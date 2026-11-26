const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const training = require('../utils/training/service');
const { parseInput, importRows } = require('../utils/training/import');

const port = process.env.TRAINING_TEST_MYSQL_PORT;
const actor = { discordId: '123456789012345678', pilotId: 11 };

test('P02 against disposable MySQL', { skip: !port && 'Set TRAINING_TEST_MYSQL_PORT for an empty local fixture database' }, async t => {
  assert.match(port, /^[0-9]+$/);
  const db = mysql.createPool({
    host: '127.0.0.1', port: Number(port),
    database: 'vuscg_training_test', user: 'training_test', password: 'training_test_local_only',
    connectionLimit: 5, multipleStatements: true, timezone: '-08:00',
  });
  t.after(() => db.end());

  const [[{ tables }]] = await db.query(`SELECT COUNT(*) AS tables FROM information_schema.tables WHERE table_schema = DATABASE()`);
  assert.equal(tables, 0, 'Start with a new empty disposable fixture database');
  await db.query(`
    CREATE TABLE users (id INT UNSIGNED PRIMARY KEY, pilot_id INT UNSIGNED NOT NULL UNIQUE, name VARCHAR(80), flight_time INT);
    CREATE TABLE discord_links (discord_id VARCHAR(20) PRIMARY KEY, pilot_id INT UNSIGNED NOT NULL);
    INSERT INTO users VALUES (10, 3250, 'Example Pilot', 105), (30, 11, 'Example Instructor', 200);
    INSERT INTO discord_links VALUES ('123456789012345678', 11);
  `);
  await assert.rejects(training.progress(db, '10'), { code: 'ER_NO_SUCH_TABLE' });
  const migration = await readFile(path.join(__dirname, '../migrations/004_training_records.sql'), 'utf8');
  await db.query(migration);
  await db.query(migration);
  const input = {
    programId: 'rw', lessonId: 'flight-3', outcome: 'needs_training', date: '2025-11-01', comments: 'First attempt',
  };
  const pilot = await training.findPilot(db, 'C3250');
  assert.equal(pilot.id, '10');
  assert.equal(pilot.pilot_id, 3250);
  const makeRecord = (suffix, options) => training.prepareRecord(pilot, { ...input, ...options }, {
    source: 'manual', actor, interactionId: '2200000000000000' + String(suffix).padStart(2, '0'),
  });

  await t.test('validates identities, enrollment, and program-specific lessons', async () => {
    await assert.rejects(training.findPilot(db, 'C999'), /missing from phpVMS/);
    const linked = await training.linkedPilot(db, { user: { id: actor.discordId } });
    assert.equal(linked.id, 30);
    await assert.rejects(training.linkedPilot(db, { user: { id: '321456789012345678' }, member: { nickname: 'C3250' } }),
      /needs a valid phpVMS pilot link/);
    await assert.rejects(training.getProgram(db, 'stage-zero'), /unavailable/);
    await assert.rejects(training.previewEvaluation(db, 3250, { ...input, lessonId: 'flight-50' }), /lesson is unavailable/);
    await assert.rejects(training.previewEvaluation(db, 3250, input), /needs an active enrollment/);
    for (const programId of ['rw', 'fw']) {
      await training.setEnrollment(db, { userId: pilot.id, programId, active: true, actor });
    }
    const preview = await training.previewEvaluation(db, 3250, input);
    assert.equal(preview.lesson.name, 'Flight 3');
    assert.deepEqual((await training.progress(db, pilot.id)).map(row => [row.id, row.active, row.remaining.length]), [
      ['fw', true, 9], ['rw', true, 9],
    ]);
  });

  let passedId;
  await t.test('serializes duplicate clicks and identical attempts but keeps different attempts', async () => {
    const identical = makeRecord(1);
    const submissions = await Promise.all([training.createRecord(db, identical), training.createRecord(db, identical)]);
    assert.deepEqual(submissions.map(row => row.created).sort(), [false, true]);
    assert.equal(submissions[0].recordId, submissions[1].recordId);
    await assert.rejects(training.createRecord(db, makeRecord(1, { comments: 'Changed' })), /different values/);
    const races = await Promise.allSettled([
      training.createRecord(db, makeRecord(2, { outcome: 'in_progress', date: '2025-11-03' })),
      training.createRecord(db, makeRecord(3, { outcome: 'in_progress', date: '2025-11-03' })),
    ]);
    assert.equal(races.filter(item => item.status === 'fulfilled').length, 1);
    assert.match(races.find(item => item.status === 'rejected').reason.message, /matching active attempt/);
    const rw = (await training.progress(db, pilot.id)).find(item => item.id === 'rw');
    assert.equal(rw.completed.length, 0);
    assert.equal(rw.lastTrainingDate, '2025-11-03');
    const passed = await training.createRecord(db, makeRecord(4, { outcome: 'passed', date: '2025-11-05' }));
    passedId = passed.recordId;
    await training.createRecord(db, makeRecord(5, { programId: 'fw', outcome: 'passed', date: '2025-11-03' }));
    const tracks = await training.progress(db, pilot.id);
    assert.deepEqual(tracks.map(item => [item.id, item.completed.map(lesson => lesson.id)]), [
      ['fw', ['flight-3']], ['rw', ['flight-3']],
    ]);
    assert.equal(tracks.find(item => item.id === 'rw').lastInstructor, 11);
  });

  await t.test('voids once, preserves original audit, excludes voided passes, and pauses changes per track', async () => {
    assert.equal(await training.voidRecord(db, { id: passedId, reason: 'Incorrect lesson', actor, interactionId: '330000000000000001' }), true);
    assert.equal(await training.voidRecord(db, { id: passedId, reason: 'Would overwrite it', actor, interactionId: '330000000000000002' }), false);
    const attempts = await training.history(db, pilot.id, 3, 0);
    assert.equal(attempts[0].record_id, passedId);
    assert.equal(attempts[0].training_date, '2025-11-05');
    assert.equal(attempts[0].outcome, 'passed');
    assert.equal(attempts[0].void_reason, 'Incorrect lesson');
    assert.equal(attempts[0].voided_by_pilot_id, 11);
    const [[audit]] = await db.execute(`SELECT public_pilot_id, instructor_discord_id, voided_by_discord_id, pirep_id
      FROM vuscg_training_records WHERE record_id = ?`, [passedId]);
    assert.deepEqual(audit, { public_pilot_id: 3250, instructor_discord_id: actor.discordId,
      voided_by_discord_id: actor.discordId, pirep_id: null });
    const tracks = await training.progress(db, pilot.id);
    assert.deepEqual(tracks.map(item => [item.id, item.completed.length]), [['fw', 1], ['rw', 0]]);
    await training.setEnrollment(db, { userId: pilot.id, programId: 'rw', active: false, actor });
    await assert.rejects(training.createRecord(db, makeRecord(6, { lessonId: 'flight-2' })), /needs an active enrollment/);
    const replay = await training.createRecord(db, makeRecord(4, { outcome: 'passed', date: '2025-11-05' }));
    assert.deepEqual(replay, { recordId: passedId, created: false, voided: true });
  });

  await t.test('import previews valid rows without writes and stores idempotent unverified provenance', async () => {
    const row = {
      source_id: 'log-23-flight-4', pilot_id: 'C3250', track: 'RW/FW', mapped_track: 'FW',
      lesson: 'flight-4', instructor: 'C003', date: '2025/11/5', result: 'passed', comments: 'Historical attempt',
    };
    const entries = parseInput('attempts.json', JSON.stringify([
      row,
      { ...row, source_id: 'needs-review', mapped_track: '' },
      { ...row, source_id: 'bad-date', date: '11/05/25' },
      { ...row, source_id: 'unavailable-pilot', pilot_id: 9000 },
      { ...row, source_id: 'blank-lesson', lesson: '' },
      { ...row, source_id: 'duplicate' },
    ]));
    const dry = await importRows(db, entries, { dataset: '2026-log' });
    assert.deepEqual(dry.counts, { ready: 1, imported: 0, existing: 0, blank: 1, duplicate: 1, rejected: 3 });
    assert.equal((await training.history(db, pilot.id, 10, 0)).length, 4);
    const applied = await importRows(db, entries.slice(0, 1), { dataset: '2026-log', apply: true });
    assert.equal(applied.counts.imported, 1);
    const rerun = await importRows(db, entries.slice(0, 1), { dataset: '2026-log', apply: true });
    assert.equal(rerun.counts.existing, 1);
    assert.equal(rerun.rows[0].recordId, applied.rows[0].recordId);
    const [[historic]] = await db.execute(`SELECT instructor_discord_id, instructor_pilot_id, provenance
      FROM vuscg_training_records WHERE record_id = ?`, [applied.rows[0].recordId]);
    assert.equal(historic.instructor_discord_id, null);
    assert.equal(historic.instructor_pilot_id, 3);
    assert.equal(historic.provenance.originalTrack, 'RW/FW');
    assert.equal(historic.provenance.dataset, '2026-log');
    assert.equal((await training.history(db, pilot.id, 10, 0))[0].training_date, '2025-11-05');
    const [[user]] = await db.execute('SELECT flight_time FROM users WHERE id = ?', [10]);
    assert.equal(user.flight_time, 105);
  });

  await t.test('explicit repeats preserve distinct records without double-counting progress', async () => {
    const details = { programId: 'fw', outcome: 'passed', date: '2025-11-03' };
    const deliberate = await training.createRecord(db, makeRecord(88, details), { allowRepeat: true });
    assert.equal(deliberate.created, true);
    const fw = (await training.progress(db, pilot.id)).find(item => item.id === 'fw');
    assert.equal(fw.completed.length, 2);
    assert.equal((await training.history(db, pilot.id, 10, 0)).length, 6);
    const duplicate = await training.createRecord(db, makeRecord(88, details), { allowRepeat: true });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.recordId, deliberate.recordId);
  });
});
