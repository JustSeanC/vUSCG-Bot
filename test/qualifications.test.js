const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canChange, authorize } = require('../utils/training/qualifications');
const { followupDays, dateRange } = require('../utils/training/dashboard');
const { updateDiscord } = require('../utils/training/graduation');

test('instructors can grant each operational qualification, and only Command Staff can grant IP or revoke', () => {
  for (const code of ['mr', 'dlq', 'hitron', 'blackjack', 'mq9', 'ip']) {
    assert.equal(canChange('instructor_pilot', 'grant', code), code !== 'ip');
    assert.equal(canChange('instructor_pilot', 'revoke', code), false);
    assert.equal(canChange('command_staff', 'grant', code), true);
    assert.equal(canChange('command_staff', 'revoke', code), true);
    assert.equal(canChange(null, 'grant', code), false);
  }
  assert.equal(canChange('instructor_pilot', 'grant', 'custom'), false);
});

test('authorization refreshes roles and requires an authenticated phpVMS mapping', async () => {
  const original = process.env.GUILD_ID;
  process.env.GUILD_ID = 'test';
  let role = 'instructor';
  const id = '123456789012345678';
  const ctx = {
    interaction: { inGuild: () => true, guildId: 'test', user: { id }, guild: { members: { fetch: async opts => {
      assert.deepEqual(opts, { user: id, force: true });
      return { roles: { cache: new Set([role]) } };
    } } } },
    roles: { COMMAND_STAFF_ROLE_ID: 'command', INSTRUCTOR_PILOT_ROLE_ID: 'instructor' },
    db: { query: async () => [[]] },
  };
  try {
    await assert.rejects(authorize(ctx, { action: 'grant', qualification: 'mr' }), /valid phpVMS pilot link/);
    role = 'member';
    await assert.rejects(authorize(ctx, { action: 'grant', qualification: 'mr' }), /permission/);
  } finally {
    if (original === undefined) delete process.env.GUILD_ID;
    else process.env.GUILD_ID = original;
  }
});

test('graduation role delivery recovers from partial failure and keeps senior and first-track roles', async () => {
  const cache = new Set(['cadet', 'rw', 'senior']);
  const mutations = [];
  let fail = true;
  const member = { roles: { cache, add: async id => {
    if (id === 'fw' && fail) { fail = false; throw new Error('Discord timeout'); }
    mutations.push(['add', id]); cache.add(id);
  }, remove: async id => { mutations.push(['remove', id]); cache.delete(id); } },
  setNickname: async name => { mutations.push(['nick', name]); member.nickname = name; } };
  const roles = { cadet: 'cadet', pilot: 'pilot', rw: 'rw', fw: 'fw', o2: 'o2' };
  const pilot = { pilot_id: 3250, name: 'Example Pilot', rank_id: 16 };
  await assert.rejects(updateDiscord(member, pilot, 'fw', roles), /Discord timeout/);
  assert.deepEqual([...cache], ['cadet', 'rw', 'senior', 'pilot']);
  await updateDiscord(member, pilot, 'fw', roles);
  await updateDiscord(member, pilot, 'fw', roles);
  assert.deepEqual(mutations, [['add', 'pilot'], ['add', 'fw'], ['remove', 'cadet'], ['nick', 'C3250 CDR Example P']]);
  assert.ok(cache.has('rw') && cache.has('senior'));
  assert.equal(cache.has('o2'), false);
});

test('follow-up thresholds and date ranges are explicit and UTC', () => {
  assert.equal(followupDays('14'), 14);
  assert.equal(followupDays(''), 30);
  assert.equal(followupDays('60'), 60);
  assert.throws(() => followupDays('0'), /1 to 365/);
  assert.deepEqual(dateRange(null, null, new Date('2025-11-30T03:00:00Z')), ['2025-11-01', '2025-11-30']);
  assert.throws(() => dateRange('2025-11-09', '2025-11-01', new Date('2025-12-01')), /on or before/);
});


test('qualification and staff dashboard replace the legacy promotion dispatch', () => {
  const commands = require('../commands');
  assert.equal(commands.promote, undefined);
  assert.deepEqual(commands.qualification.definition.toJSON().options.map(option => option.name),
    ['grant', 'revoke', 'list', 'history', 'import']);
  assert.equal(commands.training.canUse('roster', false, () => false, {}), false);
});
