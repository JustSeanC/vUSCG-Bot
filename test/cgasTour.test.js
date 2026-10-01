const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTour, completionFromVisits } = require('../utils/cgas');
const { resolveCommandPilot } = require('../utils/pilotStats');
const { baseline, ensureVersion, insertCompletion, queueHistoricalAnnouncements, deliverAnnouncements, awardRoles, tokenFor } = require('../utils/cgasTourChecker');
const { sendEphemeralPages } = require('../utils/pagination');

const config = stations => loadTour({ version: 'v1', stations });
const stations = [
  { id: 'a', name: 'CGAS A', airportCodes: ['KAAA', 'AAA'] },
  { id: 'b', name: 'CGAS B', airportCodes: ['KBBB'] },
];

test('completion distinguishes one station short from complete and chooses latest first visit', () => {
  const tour = config(stations);
  assert.equal(completionFromVisits(tour, [{ code: 'AAA', first_visit: '2026-01-01', first_pirep_id: 'p1' }]).complete, false);
  const done = completionFromVisits(tour, [
    { code: 'KAAA', first_visit: '2026-02-01', last_visit: '2026-03-01', first_pirep_id: 'p2' },
    { code: 'AAA', first_visit: '2026-01-01', first_pirep_id: 'p1' },
    { code: 'KBBB', first_visit: '2026-02-15', first_pirep_id: 'p3' },
  ]);
  assert.equal(done.complete, true);
  assert.equal(done.finalStation.id, 'b');
  assert.equal(done.finalPirepId, 'p3');
  assert.equal(done.results[0].firstPirepId, 'p1');
});

test('empty and invalid station configurations can never complete', () => {
  for (const tour of [loadTour({ version: 'v1', stations: [] }), config([{ id: 'a', name: 'A', airportCodes: [] }])]) {
    assert.equal(tour.valid, false);
    assert.equal(completionFromVisits(tour, []).complete, false);
  }
});

test('requirement hash ignores names but detects aliases and a new version has a distinct identity', () => {
  const original = config(stations);
  assert.equal(original.requirementHash, config([{ ...stations[0], name: 'Corrected A' }, stations[1]]).requirementHash);
  assert.notEqual(original.requirementHash, config([{ ...stations[0], airportCodes: ['NEW'] }, stations[1]]).requirementHash);
  assert.notEqual(tokenFor('v1', 1), tokenFor('v2', 1));
});

test('persisted requirements changed under the same version fail with an actionable error', async () => {
  const tour = config(stations);
  const db = { query: async () => [[{ requirement_hash: 'different', baseline_status: 'complete' }]] };
  await assert.rejects(() => ensureVersion(db, tour), /increment config\/cgasStations\.js version/);
});

test('baseline succeeds with zero completers and rolls back a failed initialization', async () => {
  const events = [];
  const db = {
    beginTransaction: async () => events.push('begin'), commit: async () => events.push('commit'), rollback: async () => events.push('rollback'),
    query: async sql => {
      if (sql.includes('SELECT requirement_hash')) return [[]];
      if (sql.includes('SELECT id, pilot_id')) return [[]];
      events.push(sql.trim().split(/\s+/).slice(0, 3).join(' ')); return [{ affectedRows: 1 }];
    },
  };
  assert.equal(await baseline(db, config(stations), false), true);
  assert.ok(events.includes('commit'));
  assert.ok(events.some(e => e.startsWith('UPDATE bot_cgas_tour_versions')));

  const broken = { ...db, query: async sql => {
    if (sql.includes('SELECT requirement_hash')) return [[]];
    if (sql.includes('SELECT id, pilot_id')) throw new Error('scan failed');
    return [{ affectedRows: 1 }];
  }};
  await assert.rejects(() => baseline(broken, config(stations), false), /scan failed/);
  assert.equal(events.at(-1), 'rollback');
});

test('unique completion insert and stable token make repeated/restarted detection idempotent', async () => {
  let count = 0;
  const db = { query: async (sql, params) => [{ affectedRows: count++ ? 0 : 1, params }] };
  const completion = completionFromVisits(config(stations), [
    { code: 'AAA', first_visit: '2026-01-01', first_pirep_id: '1' },
    { code: 'KBBB', first_visit: '2026-01-02', first_pirep_id: '2' },
  ]);
  const attempts = await Promise.all([
    insertCompletion(db, config(stations), { id: 8 }, completion, false, true),
    insertCompletion(db, config(stations), { id: 8 }, completion, false, true),
  ]);
  assert.deepEqual(attempts.sort(), [false, true]);
});

function deliveryDb(sendError) {
  const updates = [];
  return { updates, query: async (sql) => {
    if (sql.includes("announcement_status = 'sending' LIMIT")) return [[]];
    if (sql.includes("announcement_status='pending'" ) && sql.includes('SELECT *')) return [[{
      id: 1, user_id: 7, completed_at: '2026-01-02', final_station_name: 'CGAS B',
      announcement_token: tokenFor('v1', 7), announcement_attempts: 0,
    }]];
    if (sql.includes('SELECT pilot_id')) return [[{ pilot_id: 42, name: '@everyone Pilot' }]];
    if (sql.includes('SELECT dl.discord_id')) return [[]];
    updates.push(sql); return [{ affectedRows: 1 }];
  }, sendError };
}

test('definite Discord failures retry, ambiguous sends stop blind reposts, and unlinked pilots use safe fallback', async () => {
  for (const [error, expected] of [[Object.assign(new Error('forbidden'), { status: 403 }), "announcement_status='pending'"], [new Error('socket reset'), "announcement_status='uncertain'"]]) {
    const db = deliveryDb(error);
    const channel = { isTextBased: () => true, messages: { fetch: async () => new Map() }, send: async payload => {
      const json = payload.embeds[0].toJSON();
      assert.match(json.description, /Pilot \(C42\)/);
      assert.doesNotMatch(json.description, /@everyone/);
      assert.deepEqual(payload.allowedMentions, { parse: [], users: [] });
      throw error;
    }};
    await deliverAnnouncements(db, { channels: { fetch: async () => channel }, guilds: {} }, { channelId: '1' }, 2);
    assert.ok(db.updates.some(sql => sql.includes(expected)));
  }
});

test('optional role failure is tracked separately and baselined records are never selected', async () => {
  const updates = [];
  const db = { query: async sql => {
    if (sql.includes('SELECT *')) { assert.match(sql, /role_status IN/); return [[{ id: 1, user_id: 7, role_attempts: 0, tour_version: 'v1' }]]; }
    if (sql.includes('SELECT pilot_id')) return [[{ pilot_id: 42, name: 'Pilot' }]];
    if (sql.includes('SELECT dl.discord_id')) return [[{ discord_id: '99' }]];
    updates.push(sql); return [{ affectedRows: 1 }];
  }};
  const member = { roles: { add: async () => { throw new Error('hierarchy'); } } };
  const client = { guilds: { fetch: async () => ({ members: { fetch: async () => member } }) } };
  await awardRoles(db, client, { guildId: 'g', roleId: 'r' });
  assert.ok(updates.some(sql => sql.includes("role_status='failed'")));
});

test('staff target resolution allows both staff roles, rejects ordinary users/conflicts, and distinguishes lookup failures', async () => {
  const opts = (user, pilotId) => ({ getUser: () => user, getInteger: () => pilotId });
  const interaction = { options: opts({ id: 'd', username: 'Target' }, null), user: { id: 'self' } };
  const roles = { COMMAND_STAFF_ROLE_ID: 'c', INSTRUCTOR_PILOT_ROLE_ID: 'i' };
  const missingLink = { query: async () => [[]] };
  assert.equal((await resolveCommandPilot(missingLink, interaction, id => id === 'c', roles)).error, 'target_unlinked');
  assert.equal((await resolveCommandPilot(missingLink, interaction, () => false, roles)).error, 'forbidden_target');
  const conflict = { ...interaction, options: opts({ id: 'd' }, 42) };
  assert.equal((await resolveCommandPilot(missingLink, conflict, id => id === 'i', roles)).error, 'conflicting_targets');
  let call = 0;
  const linked = { query: async () => ++call === 1 ? [[{ pilot_id: 42 }]] : [[{ id: 7, pilot_id: 42, name: 'Pilot' }]] };
  assert.equal((await resolveCommandPilot(linked, interaction, id => id === 'i', roles)).id, 7);
});

test('pagination controls remain owned by the requesting staff member', async () => {
  let collect;
  const message = { createMessageComponentCollector: () => ({ on: (event, fn) => { if (event === 'collect') collect = fn; } }) };
  const interaction = { id: 'x', user: { id: 'requester' }, editReply: async () => message };
  await sendEphemeralPages(interaction, { pageCount: 2, id: 'pages', render: async () => ({ content: 'page' }) });
  let reply;
  await collect({ user: { id: 'pilot-being-viewed' }, reply: async value => { reply = value; } });
  assert.equal(reply.ephemeral, true);
  assert.match(reply.content, /Only the requester/);
});

test('pending PIREPs only qualify after state changes because qualifying queries require accepted state', async () => {
  const { fetchPilotVisits } = require('../utils/cgasTourChecker');
  let sql;
  await fetchPilotVisits({ query: async (query, params) => { sql = query; assert.equal(params[2], 2); return [[]]; } }, [1, 2], ['KAAA']);
  assert.match(sql, /p\.state = \?/);
  assert.match(sql, /p\.deleted_at IS NULL/);
});

test('historical announcements are queued transactionally once, including an empty campaign', async () => {
  for (const affectedRows of [3, 0]) {
    const events = [];
    const db = {
      beginTransaction: async () => events.push('begin'), commit: async () => events.push('commit'), rollback: async () => events.push('rollback'),
      query: async (sql, params) => {
        if (sql.includes('SELECT requirement_hash')) return [[{ requirement_hash: config(stations).requirementHash, baseline_status: 'complete', historical_announcement_queued_at: null }]];
        if (sql.includes('UPDATE bot_cgas_completions')) { assert.deepEqual(params, ['v1']); return [{ affectedRows }]; }
        if (sql.includes('UPDATE bot_cgas_tour_versions')) { assert.deepEqual(params, [affectedRows, 'v1']); return [{ affectedRows: 1 }]; }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
    assert.deepEqual(await queueHistoricalAnnouncements(db, config(stations)), { alreadyQueued: false, queued: affectedRows });
    assert.deepEqual(events, ['begin', 'commit']);
  }
});

test('a completed historical campaign cannot be queued again', async () => {
  const events = [];
  const db = {
    beginTransaction: async () => events.push('begin'), commit: async () => events.push('commit'), rollback: async () => events.push('rollback'),
    query: async sql => {
      assert.match(sql, /FOR UPDATE/);
      return [[{ requirement_hash: config(stations).requirementHash, baseline_status: 'complete', historical_announcement_queued_at: '2026-10-01' }]];
    },
  };
  assert.deepEqual(await queueHistoricalAnnouncements(db, config(stations)), { alreadyQueued: true, queued: 0 });
  assert.deepEqual(events, ['begin', 'rollback']);
});

test('a failed historical campaign rolls back and remains retryable', async () => {
  const events = [];
  const db = {
    beginTransaction: async () => events.push('begin'), commit: async () => events.push('commit'), rollback: async () => events.push('rollback'),
    query: async sql => {
      if (sql.includes('SELECT requirement_hash')) return [[{ requirement_hash: config(stations).requirementHash, baseline_status: 'complete', historical_announcement_queued_at: null }]];
      throw new Error('write failed');
    },
  };
  await assert.rejects(() => queueHistoricalAnnouncements(db, config(stations)), /write failed/);
  assert.deepEqual(events, ['begin', 'rollback']);
});
