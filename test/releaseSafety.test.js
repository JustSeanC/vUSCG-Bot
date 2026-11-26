const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('discord.js');
const { findRankMember } = require('../rankSync');
const activate = require('../commands/activate');
const force = require('../commands/forceranksync');
const { startGraduationWorker } = require('../utils/training/graduation');

test('rank sync prefers verified links and skips conflicting or ambiguous accounts', () => {
  const linked = { id: 'linked', nickname: 'Pending nickname' };
  const impersonating = { id: 'other', nickname: 'C3250 Example' };
  const members = new Collection([[linked.id, linked], [impersonating.id, impersonating]]);
  assert.equal(findRankMember(members, [{ discord_id: 'linked', pilot_id: 3250 }], 3250), linked);
  assert.equal(findRankMember(members, [{ discord_id: 'missing', pilot_id: 3250 }], 3250), undefined);
  assert.equal(findRankMember(members, [{ discord_id: 'linked', pilot_id: 3250 },
    { discord_id: 'other', pilot_id: 3250 }], 3250), undefined);
  assert.equal(findRankMember(members, [{ discord_id: 'other', pilot_id: 3251 }], 3250), undefined);
  assert.equal(findRankMember(members, [], 3250), undefined);
  assert.equal(findRankMember(members, [{ discord_id: 'linked', pilot_id: 3250 },
    { discord_id: 'linked', pilot_id: 3251 }], 3250), undefined);
  members.set('another', { id: 'another', nickname: 'C3250 Duplicate' });
  assert.equal(findRankMember(members, [], 3250), undefined);
});

test('activation refuses to reset a graduated pilot or replace an existing account link', async () => {
  for (const fixture of ['rank', 'link']) {
    const replies = [];
    const interaction = {
      options: { getInteger: () => 3250, getUser: () => ({ id: 'target' }), getString: () => null },
      deferReply: async () => {},
      editReply: async result => { replies.push(result.content); },
      guild: { members: { fetch: async () => ({}) }, channels: { fetch: async () => ({ threads: {} }) } },
    };
    await activate.execute({ interaction, roles: { COMMAND_STAFF_ROLE_ID: 'staff' }, hasRole: id => id === 'staff',
      db: { query: async sql => {
        if (sql.includes('FROM users')) return [[{ name: 'Example Pilot', rank_id: fixture === 'rank' ? 15 : 12 }]];
        if (sql.includes('FROM discord_links') && fixture === 'link') return [[{ discord_id: 'different', pilot_id: 3250 }]];
        assert.fail('Unexpected activation write');
      } } });
    assert.match(replies[0], /already holds LTJG|existing Discord or pilot link conflicts/);
  }
});

test('forced rank recalculation cannot overwrite a rank updated after its read', async () => {
  let response;
  const db = { query: async (sql, params) => {
    if (sql.includes('FROM ranks')) return [[{ id: 14, hours: 10 }]];
    if (sql.includes('FROM users')) return [[{ id: 7, pilot_id: 3250, rank_id: 13, flight_time: 900 }]];
    assert.match(sql, /rank_id <=> \?/);
    assert.deepEqual(params, [14, 7, 13]);
    return [{ affectedRows: 0 }];
  } };
  await force.execute({ interaction: { deferReply: async () => {}, editReply: async value => { response = value.content; } },
    db, hasRole: () => true, roles: {} });
  assert.match(response, /0 pilots updated/);
});

test('graduation worker disabled by default performs no database or Discord operations', t => {
  const original = process.env.TRAINING_GRADUATION_ENABLED;
  const guild = process.env.GUILD_ID;
  for (const value of [undefined, 'false', '1']) {
    if (value === undefined) delete process.env.TRAINING_GRADUATION_ENABLED;
    else process.env.TRAINING_GRADUATION_ENABLED = value;
    process.env.GUILD_ID = 'staging';
    const forbidden = new Proxy({}, { get: () => assert.fail('Disabled graduation attempted an external operation') });
    t.mock.method(global, 'setInterval', () => assert.fail('Disabled graduation installed a timer'));
    startGraduationWorker(forbidden, forbidden, 'staging');
    t.mock.restoreAll();
  }
  if (original === undefined) delete process.env.TRAINING_GRADUATION_ENABLED;
  else process.env.TRAINING_GRADUATION_ENABLED = original;
  if (guild === undefined) delete process.env.GUILD_ID;
  else process.env.GUILD_ID = guild;
});


test('offline registration preserves existing commands and fails on REST rejection', () => {
  const run = reject => spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { REST } = require('discord.js');
    process.env.DISCORD_TOKEN = 'offline-only';
    process.env.CLIENT_ID = '100000000000000001';
    process.env.GUILD_ID = '100000000000000002';
    REST.prototype.put = async (_, request) => {
      const names = request.body.map(command => command.name);
      for (const name of ['activate','manualpirep','mission','jumpseat','location','myactivity','myairports',
        'mycgas','cgasleaderboard','moveaircraft','activity90','forceranksync','help','training','qualification']) {
        assert.ok(names.includes(name), name);
      }
      assert.ok(!names.includes('promote'));
      if (${reject}) throw Object.assign(new Error('private request body'), { code: 'STAGING_FAILURE' });
    };
    require('./deploy-commands');
  `], { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8' });

  const good = run(false);
  assert.equal(good.status, 0);
  assert.match(good.stdout, /Slash commands registered/);
  const denied = run(true);
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /STAGING_FAILURE/);
  assert.doesNotMatch(denied.stderr, /private request body/);
});
