const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, Collection } = require('discord.js');
const service = require('../utils/training/service');
const { handlePirepTraining } = require('../utils/training/pirepSignoff');
const { postTrainingUpdate } = require('../utils/training/discord');
const { TrainingError } = require('../utils/training/validation');

const pilot = { id: '10', pilot_id: 3250, name: 'Example Pilot' };
const instructor = { id: 3, pilot_id: 1003 };
const pirepId = 'A-3250';
const lesson = { id: 'flight-4', name: 'Flight 4', program_name: 'Rotary Wing' };

function discordThread(id, overrides = {}) {
  return {
    id, name: 'Training Case for C3250', parentId: 'parent', type: ChannelType.PrivateThread,
    members: { fetch: async ({ member }) => member === 'trainee' }, ...overrides,
  };
}

const collection = (...threads) => new Collection(threads.map(thread => [thread.id, thread]));
const update = {
  pilot, lesson, data: { outcome: 'passed', comments: 'Private', pirepId }, actor: { pilotId: instructor.pilot_id },
  traineeDiscordId: 'trainee',
};

test('finds the archived private thread across pages, reopens it, and omits comments', async () => {
  const actions = [];
  const first = discordThread('200000000000000001', { parentId: 'other', archived: true });
  const second = discordThread('100000000000000001', {
    archived: true,
    setArchived: async archived => actions.push(['archive', archived]),
    send: async payload => { actions.push(['message', payload]); return { id: 'message' }; },
  });
  const guild = { channels: { fetch: async () => ({
    id: 'parent',
    threads: {
      fetchActive: async () => ({ threads: collection() }),
      fetchArchived: async ({ type, before }) => {
        assert.equal(type, 'private');
        if (before) assert.equal(before, first);
        return before ? { threads: collection(second) } : { threads: collection(first), hasMore: true };
      },
    },
  }) } };
  assert.equal(await postTrainingUpdate(guild, update, 'parent'), true);
  assert.deepEqual(actions[0], ['archive', false]);
  assert.match(actions[1][1].content, /PIREP: .*A-3250/);
  assert.doesNotMatch(actions[1][1].content, /Private/);
});

test('missing, locked and ambiguous threads do not send updates or unlock threads', async () => {
  const forbidden = async () => assert.fail('Unexpected thread mutation');
  const active = discordThread('10', { send: forbidden });
  const locked = discordThread('20', { locked: true, archived: true, setArchived: forbidden, send: forbidden });
  for (const [activeList, archived] of [[[], []], [[], [locked]], [[active], [locked]]]) {
    const guild = { channels: { fetch: async () => ({
      id: 'parent',
      threads: {
        fetchActive: async () => ({ threads: collection(...activeList) }),
        fetchArchived: async () => ({ threads: collection(...archived) }),
      },
    }) } };
    assert.equal(await postTrainingUpdate(guild, update, 'parent'), false);
  }
});

let serial = 0;
function fixture({ permitted = true, expires = false, footer, afterConfirm = () => {} } = {}) {
  const token = '18000000000000000' + (++serial);
  const user = { id: token };
  const messages = [];
  const submitted = [];
  const interaction = {
    id: token, user, guildId: 'staging', inGuild: () => true, customId: 'pirep-training:' + pirepId,
    client: { user: { id: 'bot' } },
    message: { author: { id: 'bot' }, embeds: [{ footer: { text: footer ?? 'PIREP: ' + pirepId } }] },
    guild: { members: { fetch: async () => ({ roles: { cache: new Set(permitted ? ['instructor'] : []) } }) } },
    reply: async payload => { messages.push(payload); },
    deferReply: async ({ ephemeral }) => { assert.equal(ephemeral, true); interaction.deferred = true; },
    editReply: async payload => {
      messages.push(payload);
      const first = payload.components?.[0]?.toJSON().components[0];
      return { awaitMessageComponent: async ({ filter }) => {
        if (expires) throw Object.assign(new Error('Timeout'), { code: 'InteractionCollectorError' });
        const select = first.type === 3;
        const click = {
          customId: first.custom_id, isStringSelectMenu: () => select, isButton: () => !select,
          values: ['0'], user, guildId: interaction.guildId,
          deferUpdate: async () => { if (!select) await afterConfirm(); },
          showModal: async modal => { submitted.push(modal.toJSON()); },
          awaitModalSubmit: async ({ filter: accept }) => {
            const modal = {
              customId: submitted.at(-1).custom_id, user, guildId: interaction.guildId, deferUpdate: async () => {},
              fields: { getTextInputValue: name => name === 'date' ? '2025-11-09' : 'Private comments' },
            };
            assert.equal(accept({ ...modal, user: { id: 'other' } }), false);
            assert.equal(accept(modal), true);
            return modal;
          },
        };
        assert.equal(filter({ ...click, user: { id: 'other' } }), false);
        if (select) assert.equal(filter({ ...click, values: ['100'] }), false);
        assert.equal(filter(click), true);
        return click;
      } };
    },
  };
  return { context: { interaction, db: {}, roles: { INSTRUCTOR_PILOT_ROLE_ID: 'instructor' } }, messages, submitted };
}

async function withGuild(run) {
  const previous = process.env.GUILD_ID;
  process.env.GUILD_ID = 'staging';
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.GUILD_ID;
    else process.env.GUILD_ID = previous;
  }
}

function mockLookup(t) {
  t.mock.method(service, 'linkedPilot', async () => instructor);
  t.mock.method(service, 'acceptedPilot', async (_, id) => {
    assert.equal(id, pirepId);
    return pilot;
  });
  t.mock.method(service, 'progress', async () => [
    { id: 'inactive', name: 'Inactive', active: false, remaining: [lesson], completed: [] },
    { id: 'rw', name: 'Rotary Wing', active: true, remaining: [lesson], completed: [] },
  ]);
  t.mock.method(service, 'previewEvaluation', async (_, id, data) => {
    assert.equal(id, pilot.pilot_id);
    assert.deepEqual(data, { programId: 'rw', lessonId: 'flight-4', outcome: 'passed', pirepId,
      date: '2025-11-09', comments: 'Private comments' });
    return { pilot, data, lesson };
  });
  t.mock.method(service, 'linkedDiscordForPilot', async () => null);
}

test('eligible selections and a private modal save through the shared transactional service', t => withGuild(async () => {
  mockLookup(t);
  const { context, messages, submitted } = fixture();
  const writes = t.mock.method(service, 'createRecord', async (_, record) => {
    assert.equal(messages.at(-1).content, 'Saving training change…');
    assert.equal(record.source, 'pirep');
    assert.equal(record.pirepId, pirepId);
    assert.equal(record.discordId, context.interaction.user.id);
    assert.equal(record.userId, pilot.id);
    return { recordId: 'saved', created: false };
  });
  await handlePirepTraining(context);
  assert.equal(writes.mock.calls.length, 1);
  assert.equal(submitted.length, 1);
  assert.match(messages.at(-1).content, /already saved `saved`/);
  assert.doesNotMatch(messages[0].content, /Inactive/);
  assert.equal(service.linkedDiscordForPilot.mock.calls.length, 0);
}));

test('unauthorized, expired or mismatched review buttons never save training', t => withGuild(async () => {
  mockLookup(t);
  const write = t.mock.method(service, 'createRecord', async () => assert.fail('Unexpected signoff'));
  for (const options of [{ permitted: false }, { expires: true }, { footer: 'PIREP: wrong' }]) {
    const { context, messages } = fixture(options);
    await handlePirepTraining(context);
    assert.match(messages.at(-1).content, /permission|expired|matching PIREP/);
  }
  assert.equal(write.mock.calls.length, 0);
}));

test('a report changed before confirmation surfaces the authoritative validation error', t => withGuild(async () => {
  mockLookup(t);
  let accepted = true;
  const { context, messages } = fixture({ afterConfirm: () => { accepted = false; } });
  t.mock.method(service, 'createRecord', async () => {
    assert.equal(accepted, false);
    throw new TrainingError('Only an accepted PIREP can be linked to training.');
  });
  await handlePirepTraining(context);
  assert.match(messages.at(-1).content, /Only an accepted PIREP/);
}));
