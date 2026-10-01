const test = require('node:test');
const assert = require('node:assert/strict');
const { activityStatus, resolvePilot, fetchLifetimeStats, fetchAirportPage, formatMinutes } = require('../utils/pilotStats');
const { matchStations } = require('../utils/cgas');
const metadata = require('../commands/metadata');

test('activity warning colors preserve exact UTC cutoff boundaries', () => {
  const last = '2026-01-01 12:00:00';
  assert.equal(activityStatus(last, new Date('2026-03-21T11:59:59Z')).color, 0x2ecc71);
  assert.equal(activityStatus(last, new Date('2026-03-22T12:00:00Z')).color, 0xf1c40f);
  assert.equal(activityStatus(last, new Date('2026-04-01T11:59:59Z')).color, 0xf1c40f);
  const cutoff = activityStatus(last, new Date('2026-04-01T12:00:00Z'));
  assert.equal(cutoff.color, 0xe74c3c);
  assert.equal(cutoff.cutoff.toISOString(), '2026-04-01T12:00:00.000Z');
  assert.equal(activityStatus(null), null);
});

test('formatMinutes uses phpVMS minute units', () => assert.equal(formatMinutes(91), '1h 31m'));

test('linked identity always wins over nickname and resolves users.id', async () => {
  const calls = [];
  const db = { query: async (sql, params) => {
    calls.push([sql, params]);
    return calls.length === 1 ? [[{ pilot_id: 42 }]] : [[{ id: 7, pilot_id: 42, name: 'Pilot' }]];
  }};
  const result = await resolvePilot(db, { user: { id: 'discord', username: 'C999' }, member: { nickname: 'C999 Other' } });
  assert.equal(result.id, 7);
  assert.deepEqual(calls[1][1], [42]);
});

test('nickname is only fallback for an unlinked account and database failures propagate', async () => {
  let call = 0;
  const db = { query: async () => (++call === 1 ? [[]] : [[{ id: 8, pilot_id: 123 }]]) };
  assert.equal((await resolvePilot(db, { user: { id: 'd' }, member: { nickname: 'C123 Name' } })).source, 'nickname');
  await assert.rejects(() => resolvePilot({ query: async () => { throw new Error('db down'); } }, { user: { id: 'd' } }), /db down/);
});

test('statistics query is accepted-only and aircraft aggregation cannot multiply totals', async () => {
  const calls = [];
  const db = { query: async (sql, params) => { calls.push([sql, params]); return calls.length === 1
    ? [[{ accepted_count: 3, unique_aircraft: 2, flight_minutes: 180, distance_nm: 400, unique_arrivals: 2 }]]
    : [[{ aircraft_id: 1, registration: 'C1' }, { aircraft_id: 2, registration: null }]]; } };
  const stats = await fetchLifetimeStats(db, 7);
  assert.equal(stats.accepted_count, 3);
  assert.ok(calls.every(([, params]) => params[1] === 2));
  assert.match(calls[0][0], /COUNT\(DISTINCT p\.aircraft_id\)/);
  assert.match(calls[1][0], /LEFT JOIN aircraft/);
});

test('airport pages are bounded, accepted-only, distinct, and retain missing metadata', async () => {
  let call = 0;
  const db = { query: async (sql, params) => {
    call++;
    if (call === 1) return [[{ total: 1 }]];
    assert.match(sql, /LEFT JOIN airports/);
    assert.deepEqual(params.slice(-2), [10, 20]);
    return [[{ code: 'KZZZ', name: null, arrivals: 2 }]];
  }};
  const page = await fetchAirportPage(db, 1, 10, 20);
  assert.equal(page.rows[0].name, null);
});

test('CGAS aliases and repeated airport arrivals complete a station only once', () => {
  const result = matchStations([
    { id: 'a', name: 'A', airportCodes: ['KAAA', 'AAA', 'KAAA'] },
    { id: 'b', name: 'B', airportCodes: ['KBBB'] },
  ], [
    { code: 'KAAA', first_visit: '2026-01-02Z', last_visit: '2026-02-02Z', arrivals: 5 },
    { code: 'AAA', first_visit: '2026-01-01Z', last_visit: '2026-03-02Z', arrivals: 1 },
  ]);
  assert.equal(result.filter(s => s.visited).length, 1);
  assert.equal(result[0].airportCodes.length, 2);
  assert.equal(result[0].firstVisit.toISOString().slice(0, 10), '2026-01-01');
});

test('help access mirrors member, Instructor Pilot, Command Staff, and multiple roles', () => {
  const roles = { COMMAND_STAFF_ROLE_ID: 'c', INSTRUCTOR_PILOT_ROLE_ID: 'i' };
  const visible = ids => Object.entries(metadata).filter(([, v]) => v?.category && metadata.canView(v.access, id => ids.includes(id), roles)).map(([k]) => k);
  assert.ok(!visible([]).includes('activate'));
  assert.ok(visible(['i']).includes('promote'));
  assert.ok(!visible(['i']).includes('activity90'));
  assert.ok(visible(['c']).includes('activate'));
  assert.ok(visible(['c', 'i']).includes('moveaircraft'));
});
