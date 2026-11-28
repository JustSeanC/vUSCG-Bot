const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareResource, httpsUrl } = require('../utils/training/materials');
const { buildInstruction } = require('../utils/training/instructionDelivery');
const { canUse } = require('../commands/training');
const config = require('../commands/trainingConfig');

const roles = { COMMAND_STAFF_ROLE_ID: 'command', INSTRUCTOR_PILOT_ROLE_ID: 'instructor' };

test('catalog accepts multiple valid HTTPS destinations and rejects credentials and malformed URLs', () => {
  for (const url of ['https://drive.google.com/drive/folders/123', 'https://example.test/a_(b)?page=1#section']) {
    assert.equal(httpsUrl(url), url);
    const resource = prepareResource('add_link', { categoryId: 'rw', title: 'Rotary guide', url, order: 4 });
    assert.equal(resource.changes.display_order, 4);
  }
  for (const url of ['http://example.test', 'javascript:alert(1)', 'https://user:pass@example.test', 'https://x.test/\n@everyone',
    'https://x.test/>text', 'https://x.test\\example.test', 'https://']) {
    assert.throws(() => httpsUrl(url), /valid HTTPS/);
  }
});

test('instructors can start and share while pause and configuration remain Command Staff only', () => {
  const instructor = id => id === 'instructor';
  const command = id => id === 'command';
  for (const action of ['enroll', 'materials', 'delivery']) assert.equal(canUse(action, true, instructor, roles), true);
  for (const action of ['pause', 'configure']) {
    assert.equal(canUse(action, true, instructor, roles), false);
    assert.equal(canUse(action, true, command, roles), true);
  }
  assert.equal(canUse('enroll', true, () => false, roles), false);
});

test('configuration command rejects an instructor write before any data access', async () => {
  const saved = process.env.GUILD_ID;
  process.env.GUILD_ID = 'fixture';
  const responses = [];
  try {
    await config.execute({
      db: new Proxy({}, { get: () => assert.fail('Unauthorized request accessed the database') }),
      roles, hasRole: id => id === 'instructor',
      interaction: { inGuild: () => true, guildId: 'fixture', options: { getSubcommand: () => 'add-link' },
        reply: async response => responses.push(response) },
    });
  } finally {
    if (saved === undefined) delete process.env.GUILD_ID;
    else process.env.GUILD_ID = saved;
  }
  assert.equal(responses[0].ephemeral, true);
  assert.match(responses[0].content, /permission/);
});

test('delivery formats notes and usable links without mentions; oversized catalogs keep every link', () => {
  const pilot = { pilot_id: 3250, name: 'Example Pilot' };
  const event = {
    event_id: 'e', kind: 'start', program_id: 'rw', label: 'Rotary Wing', actor_pilot_id: 77,
    note: 'Start from Stage 1, @everyone. **Ask questions.**',
    resources: [{ title: 'Guide [test]', url: 'https://example.test/path_(abc)', description: 'Before flying' }],
  };
  const result = buildInstruction(event, pilot);
  assert.deepEqual(result.allowedMentions.parse, []);
  assert.match(result.embeds[0].toJSON().description, /Start from Stage 1/);
  assert.match(result.embeds[0].toJSON().description, /https:\/\/example\.test\/path_\(abc\)/);
  assert.doesNotMatch(result.embeds[0].toJSON().description, /@everyone/);
  const large = buildInstruction({ ...event, resources: Array.from({ length: 75 }, (_, i) =>
    ({ title: 'Training document ' + i, url: 'https://example.test/docs/' + i, description: 'X'.repeat(200) })) }, pilot);
  assert.ok(large.embeds[0].toJSON().description.length <= 4000);
  assert.match(large.files[0].attachment.toString(), /https:\/\/example\.test\/docs\/74/);
  assert.equal(result.nonce, large.nonce);
});
