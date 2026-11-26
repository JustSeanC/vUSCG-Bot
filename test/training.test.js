const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, Collection } = require('discord.js');
const command = require('../commands/training');
const service = require('../utils/training/service');
const { parseInput, importRows } = require('../utils/training/import');
const { evaluation, trainingDate, pilotNumber } = require('../utils/training/validation');
const { progressEmbed, postTrainingUpdate } = require('../utils/training/discord');

const roles = { COMMAND_STAFF_ROLE_ID: 'command', INSTRUCTOR_PILOT_ROLE_ID: 'instructor' };
const pilot = { id: '10', pilot_id: 3250, name: 'Example Pilot' };
const data = { programId: 'rw', lessonId: 'flight-4', date: '2025-11-05', outcome: 'passed', comments: 'Private notes' };
const lesson = { name: 'Flight 4', program_name: 'Rotary Wing' };

test('training slash definition exposes the six authorized workflows', () => {
  const definition = require('../commands').training.definition.toJSON();
  assert.equal(definition.name, 'training');
  assert.deepEqual(definition.options.map(({ name }) => name), ['record', 'progress', 'pilot', 'history', 'enroll', 'void']);
  assert.equal(command.canUse('enroll', true, id => id === 'command', roles), true);
  assert.equal(command.canUse('void', true, id => id === 'instructor', roles), false);
  assert.equal(command.canUse('record', true, id => id === 'instructor', roles), true);
  assert.equal(command.canUse('history', false, () => false, roles), true);
});

test('validates common IDs and calendar dates without interpreting ambiguous dates', () => {
  assert.equal(pilotNumber('c003250'), '3250');
  assert.throws(() => pilotNumber('3.25e3'), /valid public pilot/);
  assert.equal(trainingDate('2024-02-29', '2025-01-01'), '2024-02-29');
  assert.throws(() => trainingDate('2025-02-29', '2026-01-01'), /real calendar date/);
  assert.throws(() => trainingDate('2025-01-02', '2025-01-01'), /on or before today/);
  assert.throws(() => evaluation({ ...data, programId: 'RW/FW' }), /program identifier/);
  assert.throws(() => evaluation({ ...data, lessonId: 'flight 4' }), /lesson identifier/);
  assert.throws(() => evaluation({ ...data, outcome: 'graduated' }), /evaluation outcome/);
});

test('configured lesson completion does not imply a completed curriculum', () => {
  const [track] = service.summarizeProgress([{
    program_id: 'rw', program_name: 'Rotary Wing', enrolled_active: 1, enabled: 1,
    curriculum_complete: 0, lesson_id: 'flight-4', lesson_name: 'Flight 4', passed: 1,
  }]);
  const payload = progressEmbed(pilot, [track], 1).toJSON();
  assert.match(payload.description, /1\/1 configured lessons passed/);
  assert.match(payload.description, /Program completion: unavailable/);
  assert.doesNotMatch(payload.description, /100%/);
});

test('import parser preserves escaped CSV data and rejects malformed input', () => {
  const header = 'source_id,pilot_id,track,lesson,instructor,date,result,comments';
  const entries = parseInput('example.csv', header + '\r\na,C3250,RW,flight-4,C03,2025-01-01,passed,"hello, ""trainee""\r\nnext"\r\n');
  assert.equal(entries[0].row.comments, 'hello, "trainee"\r\nnext');
  assert.throws(() => parseInput('bad.csv', header + '\na,1,RW,flight-4,3,2025-01-01,passed,"incomplete'), /inside a quoted field/);
  assert.throws(() => parseInput('bad.json', '{}'), /array/);
});

test('ambiguous and conflicting import rows are reported without database reads', async () => {
  const row = { source_id: 'a', pilot_id: '3250', track: 'RW/FW', lesson: 'flight-4',
    instructor: 'IP??', date: '5/11/25', result: 'passed' };
  const entries = parseInput('example.json', JSON.stringify([row, {
    ...row, mapped_track: 'rw', instructor: 'C03', date: '2025-11-05',
  }, { ...row, source_id: 'b', lesson: '' }]));
  const report = await importRows({}, entries, { dataset: 'fixture' });
  assert.equal(report.mode, 'dry-run');
  assert.deepEqual(report.rows.map(item => item.status), ['rejected', 'rejected', 'blank']);
  assert.match(report.rows[0].reason, /Ambiguous/);
  assert.match(report.rows[1].reason, /Conflicting/);
});

let serial = 0;
function context({ action, role, guildId = 'guild', target = 3250, clicked = 'confirm', currentRole = role } = {}) {
  const log = [];
  const id = '12345678901234' + String(++serial).padStart(4, '0');
  const user = { id };
  const options = {
    getSubcommand: () => action,
    getInteger: key => key === 'pilot_id' ? target : null,
    getString: key => ({ track: 'rw', lesson: 'flight-4', result: 'passed', comments: 'Private notes',
      date: '2025-11-05', record_id: '00000000-0000-0000-0000-000000000001', reason: 'Wrong entry' }[key] ?? null),
    getBoolean: () => null,
  };
  const interaction = {
    id, user, guildId, inGuild: () => true, options,
    guild: { members: { fetch: async request => {
      assert.deepEqual(request, { user: id, force: true });
      return { roles: { cache: new Set([currentRole]) } };
    } }, channels: { fetch: async () => { throw new Error('Discord unavailable'); } } },
    reply: async payload => { log.push(['reply', payload]); },
    deferReply: async payload => { interaction.deferred = true; log.push(['defer', payload]); },
    editReply: async payload => {
      log.push(['edit', payload]);
      return {
        awaitMessageComponent: async opts => {
          if (clicked === 'expired') throw Object.assign(new Error(), { code: 'InteractionCollectorError' });
          const button = { user, guildId, isButton: () => true, customId: `training:${id}:${clicked}`,
            deferUpdate: async () => { log.push(['confirm']); } };
          assert.equal(opts.time, 60_000);
          assert.equal(opts.filter(button), true);
          assert.equal(opts.filter({ ...button, user: { id: 'unrelated' } }), false);
          return button;
        },
      };
    },
  };
  return { ctx: { interaction, roles, hasRole: candidate => candidate === role, db: {} }, log };
}

async function withGuild(run) {
  const old = process.env.GUILD_ID;
  process.env.GUILD_ID = 'guild';
  try {
    await run();
  } finally {
    if (old === undefined) delete process.env.GUILD_ID;
    else process.env.GUILD_ID = old;
  }
}

test('wrong guild and unauthorized cross-pilot commands never touch storage', () => withGuild(async () => {
  for (const options of [
    { action: 'record', role: 'instructor', guildId: 'other' },
    { action: 'history' },
    { action: 'pilot' },
    { action: 'void', role: 'instructor' },
    { action: 'enroll', role: 'instructor' },
  ]) {
    const { ctx, log } = context(options);
    await command.execute(ctx);
    assert.equal(log.length, 1);
    assert.equal(log[0][0], 'reply');
    assert.equal(log[0][1].ephemeral, true);
  }
}));

test('self progress uses the linked account, even with an injected pilot ID', t => withGuild(async () => {
  t.mock.method(service, 'linkedPilot', async () => pilot);
  t.mock.method(service, 'progress', async (db, id) => {
    assert.equal(id, pilot.id);
    return [];
  });
  const { ctx, log } = context({ action: 'progress', target: 1234 });
  await command.execute(ctx);
  assert.match(log.at(-1)[1].embeds[0].data.title, /C3250/);
  assert.equal(log[0][1].ephemeral, true);
}));

test('expiry, cancellation, and role revocation cannot save a record', t => withGuild(async () => {
  t.mock.method(service, 'linkedPilot', async () => ({ id: 50, pilot_id: 3 }));
  t.mock.method(service, 'previewEvaluation', async () => ({ pilot, lesson, data }));
  const save = t.mock.method(service, 'createRecord', async () => assert.fail('unexpected save'));
  for (const options of [{ clicked: 'expired' }, { clicked: 'cancel' }, { currentRole: 'member' }]) {
    const { ctx, log } = context({ action: 'record', role: 'instructor', ...options });
    await command.execute(ctx);
    assert.match(log.at(-1)[1].content, /expired|Cancelled|permissions/);
  }
  assert.equal(save.mock.calls.length, 0);
}));

test('confirmed record survives Discord notification failure and returns its ID', t => withGuild(async () => {
  t.mock.method(service, 'linkedPilot', async () => ({ id: 50, pilot_id: 3 }));
  t.mock.method(service, 'previewEvaluation', async () => ({ pilot, lesson, data }));
  t.mock.method(service, 'findPilot', async () => pilot);
  t.mock.method(service, 'linkedDiscordForPilot', async () => '123456789012345671');
  const { ctx, log } = context({ action: 'record', role: 'instructor' });
  t.mock.method(service, 'createRecord', async (db, record) => {
    assert.equal(log.some(([kind]) => kind === 'confirm'), true);
    assert.equal(record.discordId, ctx.interaction.user.id);
    assert.equal(record.instructor, '3');
    assert.equal(record.userId, '10');
    return { recordId: 'saved-record', created: true };
  });
  t.mock.method(service, 'progress', async () => [{ id: 'rw', name: 'Rotary Wing', completed: [lesson], remaining: [] }]);
  await command.execute(ctx);
  assert.match(log.at(-1)[1].content, /saved-record/);
  assert.match(log.at(-1)[1].content, /1\/1 configured lessons passed/);
}));

test('missing training tables produce an ephemeral setup error without SQL details', t => withGuild(async () => {
  t.mock.method(service, 'linkedPilot', async () => pilot);
  t.mock.method(service, 'progress', async () => { throw Object.assign(new Error('private SQL'), { code: 'ER_NO_SUCH_TABLE' }); });
  const { ctx, log } = context({ action: 'progress', target: null });
  await command.execute(ctx);
  assert.match(log.at(-1)[1].content, /database migration/);
  assert.doesNotMatch(log.at(-1)[1].content, /private SQL/);
}));

test('thread notifications verify privacy and the linked trainee, and omit comments', async () => {
  const delivered = [];
  const makeThread = type => ({
    type, parentId: 'parent', name: 'Training Case for C3250',
    members: { fetch: async ({ member }) => member === '3250-discord' },
    send: async payload => delivered.push(payload),
  });
  const threads = new Collection([['private', makeThread(ChannelType.PrivateThread)], ['public', makeThread(ChannelType.PublicThread)]]);
  const guild = { channels: { fetch: async () => ({ threads: { fetchActive: async () => ({ threads }) } }) } };
  const update = { pilot, lesson, data, actor: { pilotId: 3 }, traineeDiscordId: '3250-discord' };
  assert.equal(await postTrainingUpdate(guild, update, 'parent'), true);
  assert.equal(delivered.length, 1);
  assert.doesNotMatch(delivered[0].content, /Private notes/);
  assert.deepEqual(delivered[0].allowedMentions.parse, []);
  assert.equal(await postTrainingUpdate(guild, { ...update, traineeDiscordId: 'unrelated' }, 'parent'), false);
  threads.set('duplicate-private', makeThread(ChannelType.PrivateThread));
  assert.equal(await postTrainingUpdate(guild, update, 'parent'), false);
  assert.equal(delivered.length, 1);
});

test('Command Staff must explicitly confirm a void and uses their verified identity', t => withGuild(async () => {
  t.mock.method(service, 'linkedPilot', async () => ({ id: 50, pilot_id: 3 }));
  t.mock.method(service, 'getRecord', async () => ({
    user_id: '10', public_pilot_id: 3250, program_name: 'Rotary Wing', program_id: 'rw',
    lesson_name: 'Flight 4', training_date: '2025-11-05', outcome: 'passed', voided_at: null,
  }));
  const { ctx, log } = context({ action: 'void', role: 'command', target: null });
  const voided = t.mock.method(service, 'voidRecord', async (db, change) => {
    assert.equal(log.some(([kind]) => kind === 'confirm'), true);
    assert.equal(change.reason, 'Wrong entry');
    assert.deepEqual(change.actor, { discordId: ctx.interaction.user.id, pilotId: 3 });
    assert.equal(change.interactionId, ctx.interaction.id);
    return true;
  });
  t.mock.method(service, 'progress', async () => [{ id: 'rw', completed: [], remaining: [lesson] }]);
  await command.execute(ctx);
  assert.equal(voided.mock.calls.length, 1);
  assert.match(log.at(-1)[1].content, /voided.*0\/1 configured lessons passed/);
}));
