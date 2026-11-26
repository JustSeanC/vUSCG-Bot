const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const training = require('../utils/training/service');
const qualifications = require('../utils/training/qualifications');
const dashboard = require('../utils/training/dashboard');
const { importQualifications } = require('../scripts/import-qualifications');
const { promoteRank, runGraduations } = require('../utils/training/graduation');
const { Collection, ChannelType } = require('discord.js');
const { parseInput, importRows } = require('../utils/training/import');

const port = process.env.TRAINING_TEST_MYSQL_PORT;
const actor = { discordId: '123456789012345678', pilotId: 11 };

test('Training against disposable MySQL 8.4', { skip: !port && 'Set TRAINING_TEST_MYSQL_PORT for an empty local fixture database' }, async t => {
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
    CREATE TABLE pireps (
      id VARCHAR(64) PRIMARY KEY, user_id INT UNSIGNED, state INT, deleted_at DATETIME NULL
    );
    CREATE TABLE discord_links (discord_id VARCHAR(20) PRIMARY KEY, pilot_id INT UNSIGNED NOT NULL);
    INSERT INTO users VALUES (10, 3250, 'Example Pilot', 105), (30, 11, 'Example Instructor', 200);
    INSERT INTO discord_links VALUES ('123456789012345678', 11);
    INSERT INTO pireps VALUES ('AbC-3250', 10, 2, NULL), ('Rejected', 10, 6, NULL), ('Pending', 10, 1, NULL),
      ('Deleted', 10, 2, UTC_TIMESTAMP()), ('Reassigned', 10, 2, NULL), ('OtherPilot', 30, 2, NULL),
      ('Changing', 10, 2, NULL);
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

  await t.test('005 preserves standalone and imported history and rejects invalid evidence', async () => {
    const [[{ count }]] = await db.query('SELECT COUNT(*) AS count FROM vuscg_training_records');
    await db.query(await readFile(path.join(__dirname, '../migrations/005_training_pirep_link.sql'), 'utf8'));
    const [[{ retained }]] = await db.query("SELECT COUNT(*) AS retained FROM vuscg_training_records WHERE source IN ('manual', 'import')");
    assert.equal(retained, count);
    assert.ok((await training.history(db, pilot.id, 10, 0)).some(row => row.source === 'import'));
    for (const [id, error] of [
      ['AbC/3250', /valid PIREP ID/], ['Missing', /missing or was deleted/], ['abc-3250', /missing or was deleted/],
      ['Rejected', /Only an accepted PIREP/], ['Pending', /Only an accepted PIREP/],
      ['Deleted', /missing or was deleted/], ['OtherPilot', /different pilot/],
    ]) {
      await assert.rejects(training.previewEvaluation(db, 3250, { ...input, programId: 'fw', pirepId: id }), error);
    }
    const preview = await training.previewEvaluation(db, null, { ...input, programId: 'fw', pirepId: 'AbC-3250' });
    assert.equal(preview.pilot.id, '10');
  });

  let linkedPass;
  const linked = (suffix, detail = {}) => training.prepareRecord(pilot, {
    ...input, programId: 'fw', lessonId: 'flight-5', pirepId: 'AbC-3250', ...detail,
  }, { source: 'pirep', actor, interactionId: '5500000000000000' + String(suffix).padStart(2, '0') });

  await t.test('linked paths use one durable receipt and one active evaluation per outcome', async () => {
    const records = await Promise.all([
      training.createRecord(db, linked(1)), training.createRecord(db, linked(1)),
    ]);
    assert.equal(records[0].recordId, records[1].recordId);
    assert.equal(records.filter(row => row.created).length, 1);
    await assert.rejects(training.createRecord(db, linked(2, { comments: 'Different comments' }), { allowRepeat: true }), /already has an active evaluation/);
    const firstPasses = await Promise.allSettled([
      training.createRecord(db, linked(3, { outcome: 'passed' })),
      training.createRecord(db, linked(4, { outcome: 'passed' })),
    ]);
    assert.equal(firstPasses.filter(row => row.status === 'fulfilled').length, 1);
    linkedPass = firstPasses.find(row => row.status === 'fulfilled').value.recordId;
    await training.createRecord(db, linked(5, { lessonId: 'flight-6', outcome: 'passed' }));
    const fw = (await training.progress(db, pilot.id)).find(track => track.id === 'fw');
    assert.ok(fw.completed.some(item => item.id === 'flight-5'));
    assert.ok(fw.completed.some(item => item.id === 'flight-6'));
    assert.equal(fw.lastSource, 'pirep');
    assert.equal(fw.lastPirepId, 'AbC-3250');
    const recent = (await training.history(db, pilot.id, 20, 0)).find(row => row.record_id === linkedPass);
    assert.equal(recent.source, 'pirep');
    assert.equal(recent.pirep_id, 'AbC-3250');

    // Training can reference the same accepted report repeatedly without touching aviation accounting.
    const [[owner]] = await db.execute('SELECT flight_time FROM users WHERE id = ?', [10]);
    const [[pirep]] = await db.execute('SELECT state FROM pireps WHERE id = ?', ['AbC-3250']);
    assert.equal(owner.flight_time, 105);
    assert.equal(pirep.state, 2);
  });

  await t.test('transaction rechecks report state, owner, enrollment and lesson after preview', async () => {
    for (const [i, report, mutation, expected] of [
      [11, 'Changing', 'UPDATE pireps SET state = 6 WHERE id = ?', /Only an accepted PIREP/],
      [12, 'Reassigned', 'UPDATE pireps SET user_id = 30 WHERE id = ?', /different pilot/],
    ]) {
      await training.previewEvaluation(db, 3250, { ...input, programId: 'fw', pirepId: report });
      await db.execute(mutation, [report]);
      await assert.rejects(training.createRecord(db, linked(i, { pirepId: report })), expected);
    }
    await training.previewEvaluation(db, 3250, { ...input, programId: 'fw', lessonId: 'flight-7', pirepId: 'AbC-3250' });
    await db.execute("UPDATE vuscg_training_lessons SET active = FALSE WHERE program_id = 'fw' AND lesson_id = 'flight-7'");
    await assert.rejects(training.createRecord(db, linked(13, { lessonId: 'flight-7' })), /lesson is unavailable/);
    await training.setEnrollment(db, { userId: pilot.id, programId: 'fw', active: false, actor });
    await assert.rejects(training.createRecord(db, linked(14)), /needs an active enrollment/);
    await training.setEnrollment(db, { userId: pilot.id, programId: 'fw', active: true, actor });
  });

  await t.test('voiding linked credit keeps audit and allows an explicit replacement', async () => {
    await training.voidRecord(db, { id: linkedPass, reason: 'Incorrect evaluation', actor, interactionId: '550000000000000090' });
    const fw = (await training.progress(db, pilot.id)).find(track => track.id === 'fw');
    assert.equal(fw.completed.some(item => item.id === 'flight-5'), false);
    const replacement = await training.createRecord(db, linked(90, { outcome: 'passed' }));
    assert.notEqual(replacement.recordId, linkedPass);
    const original = (await training.history(db, pilot.id, 20, 0)).find(row => row.record_id === linkedPass);
    assert.equal(original.void_reason, 'Incorrect evaluation');
    assert.equal(original.pirep_id, 'AbC-3250');
  });


  await t.test('recovers the saved receipt when a commit acknowledgement is lost', async () => {
    const request = linked(92, { lessonId: 'flight-8', outcome: 'passed' });
    const interrupted = {
      execute: db.execute.bind(db),
      async getConnection() {
        const connection = await db.getConnection();
        return {
          query: connection.query.bind(connection),
          execute: connection.execute.bind(connection),
          beginTransaction: connection.beginTransaction.bind(connection),
          rollback: connection.rollback.bind(connection),
          release: connection.release.bind(connection),
          async commit() {
            await connection.commit();
            throw new Error('Connection lost after commit');
          },
        };
      },
    };
    const recovered = await training.createRecord(interrupted, request);
    assert.equal(recovered.created, false);
    assert.equal((await training.createRecord(db, request)).recordId, recovered.recordId);
    const [rows] = await db.execute('SELECT record_id FROM vuscg_training_records WHERE source_key = ?', [request.sourceKey]);
    assert.deepEqual(rows, [{ record_id: recovered.recordId }]);
  });


  await t.test('006 preserves training rows and audits authorized qualification changes and delivery jobs', async () => {
    const migration = await readFile(path.join(__dirname, '../migrations/006_training_qualifications.sql'), 'utf8');
    const [[before]] = await db.query('SELECT COUNT(*) AS total FROM vuscg_training_records');
    await db.query(migration);
    await db.query(migration);
    assert.deepEqual((await db.query('SELECT COUNT(*) AS total FROM vuscg_training_records'))[0][0], before);
    await db.query(`
      ALTER TABLE users ADD rank_id INT NOT NULL DEFAULT 12;
      CREATE TABLE ranks (id INT PRIMARY KEY, name VARCHAR(80));
      INSERT INTO ranks VALUES (13, 'LTJG');
      INSERT INTO users (id, pilot_id, name, flight_time) VALUES (50, 55, 'Command Reviewer', 0);
      INSERT INTO discord_links VALUES ('100000000000000325', 3250), ('100000000000000055', 55);
    `);

    const previous = process.env.GUILD_ID;
    process.env.GUILD_ID = 'qualification-fixture';
    t.after(() => { if (previous === undefined) delete process.env.GUILD_ID; else process.env.GUILD_ID = previous; });
    let sequence = 0;
    const context = role => ({
      db, roles: { COMMAND_STAFF_ROLE_ID: 'command', INSTRUCTOR_PILOT_ROLE_ID: 'instructor' },
      interaction: {
        id: '66000000000000' + String(++sequence).padStart(4, '0'),
        user: { id: role === 'command' ? '100000000000000055' : actor.discordId },
        inGuild: () => true, guildId: 'qualification-fixture',
        guild: { members: { fetch: async options => {
          assert.equal(options.force, true);
          return { roles: { cache: new Set([role]) } };
        } } },
      },
    });
    const change = async (qualification, program, action = 'grant', reason = '') =>
      qualifications.preview(db, { pilotId: 3250, qualification, program, action, date: '2025-11-20', reason });
    const apply = async (ctx, request) => qualifications.commitConfirmedChange(ctx, request, await qualifications.authorize(ctx, request));

    await assert.rejects(apply(context('instructor'), await change('ip')), /require Command Staff/);
    await assert.rejects(change('mr', 'stage-zero'), /explicit rw or fw/);
    const mrRw = await change('mr', 'rw');
    const mrFw = await change('mr', 'fw');
    const [rw, fw] = await Promise.all([apply(context('instructor'), mrRw), apply(context('instructor'), mrFw)]);
    const ip = await apply(context('command'), await change('ip'));
    for (const key of ['dlq', 'hitron', 'blackjack', 'mq9']) {
      await apply(context('instructor'), await change(key));
    }
    const newKind = await db.query("INSERT INTO vuscg_training_qualifications (qualification_id, name, scope) VALUES ('test-track', 'Test track', 'program')");
    assert.ok(newKind);
    const byStaff = await change('test-track', 'fw');
    const runs = await Promise.allSettled([apply(context('command'), byStaff), apply(context('command'), byStaff)]);
    assert.equal(runs.filter(result => result.status === 'fulfilled').length, 1);
    assert.match(runs.find(result => result.status === 'rejected').reason.message, /already active/);
    const revoke = await change('ip', null, 'revoke', 'Correction');
    await assert.rejects(apply(context('instructor'), revoke), /require Command Staff/);
    const reviewing = context('command');
    const receipt = await apply(reviewing, revoke);
    assert.deepEqual(await apply(reviewing, revoke), { id: receipt.id, created: false });
    const history = await qualifications.history(db, pilot.id, 20, 0);
    const revoked = history.find(row => row.event_id === receipt.id);
    assert.equal(revoked.reviewer_role, 'command_staff');
    assert.equal(revoked.reason, 'Correction');
    assert.equal(revoked.reviewer_pilot_id, 55);
    assert.equal(revoked.reviewer_discord_id, '100000000000000055');
    assert.ok((await qualifications.activeAwards(db, pilot.id)).some(row => row.qualification_id === 'mr' && row.program_id === 'fw'));
    assert.ok(!(await qualifications.activeAwards(db, pilot.id)).some(row => row.qualification_id === 'ip'));

    const targets = async id => (await db.execute('SELECT target FROM vuscg_training_qualification_sync WHERE event_id=? ORDER BY target', [id]))[0].map(row => row.target);
    assert.deepEqual(await targets(rw.id), ['award', 'type_rating', 'graduation']);
    assert.deepEqual(await targets(fw.id), ['award', 'type_rating', 'graduation']);
    assert.deepEqual(await targets(ip.id), ['award', 'ip_role']);
    const [events] = await db.execute('SELECT * FROM vuscg_training_qualification_events WHERE event_id IN (?, ?)', [rw.id, fw.id]);
    const rankFor = async () => (await db.execute('SELECT rank_id FROM users WHERE id=10'))[0][0].rank_id;
    assert.equal(await rankFor(), 12);
    assert.equal(await promoteRank(db, events[0], 'LTJG'), true);
    assert.equal(await rankFor(), 13);
    assert.equal(await promoteRank(db, events[1], 'LTJG'), false);
    await db.execute('UPDATE users SET rank_id=16 WHERE id=10');
    assert.equal(await promoteRank(db, events[1], 'LTJG'), false);
    assert.equal(await rankFor(), 16);
    const revokedMr = await apply(context('command'), await change('mr', events[0].program_id, 'revoke', 'Review required'));
    assert.deepEqual(await targets(revokedMr.id), ['award', 'type_rating']);
    assert.equal(await rankFor(), 16);

    const file = [
      { source_id: 'historical-ip', pilot_id: 3250, qualification_id: 'ip', tracker_label: 'IP', flag: 'YES',
        date: '2025-11-20', review: 'Reviewed approved evidence' },
      { source_id: 'no', flag: 'NO' },
      { source_id: 'ambiguous', flag: 'YES' },
    ];
    const report = await importQualifications(db, file, { dataset: 'tracker' });
    assert.deepEqual(report.map(item => item.status), ['ready', 'ignored_no', 'rejected']);
    const [[stagingCount]] = await db.query('SELECT COUNT(*) AS total FROM vuscg_training_qualification_imports');
    assert.equal(stagingCount.total, 0);
    await importQualifications(db, file, { dataset: 'tracker', stage: true });
    await importQualifications(db, file, { dataset: 'tracker', stage: true });
    const candidate = await qualifications.preview(db, { candidateId: report[0].candidateId, reason: 'Verified staff review' });
    assert.equal(candidate.source.provenance.trackerLabel, 'IP');
    await assert.rejects(apply(context('instructor'), candidate), /require Command Staff/);
    const historical = await apply(context('command'), candidate);
    assert.deepEqual(await targets(historical.id), []);
    await db.query("INSERT INTO users (id, pilot_id, name, flight_time) VALUES (51, 3251, 'Historical Pilot', 0)");
    const [historicalMr] = await importQualifications(db, [{
      ...file[0], source_id: 'historical-mr', pilot_id: 3251, qualification_id: 'mr', program: 'rw', tracker_label: 'MR',
    }], { dataset: 'tracker', stage: true });
    const historicalChange = await qualifications.preview(db, { candidateId: historicalMr.candidateId, reason: 'Evidence reviewed' });
    assert.equal(historicalChange.graduateDiscordId, null);
    assert.deepEqual(await targets((await apply(context('instructor'), historicalChange)).id), []);

    const lost = context('instructor');
    const lostChange = await qualifications.preview(db, { pilotId: 3251, qualification: 'dlq', action: 'grant', date: '2025-11-20' });
    const actorBeforeLoss = await qualifications.authorize(lost, lostChange);
    lost.db = {
      query: db.query.bind(db), execute: db.execute.bind(db),
      async getConnection() {
        const connection = await db.getConnection();
        const commit = connection.commit.bind(connection);
        connection.commit = async () => {
          connection.commit = commit;
          await commit();
          throw new Error('Commit response lost');
        };
        return connection;
      },
    };
    const recovered = await qualifications.commitConfirmedChange(lost, lostChange, actorBeforeLoss);
    assert.equal(recovered.created, false);
    assert.deepEqual(await targets(recovered.id), ['award']);
    const historyOnly = (await qualifications.history(db, pilot.id, 20, 0)).find(row => row.event_id === historical.id);
    assert.equal(historyOnly.delivery, null);
    assert.equal(historyOnly.provenance.sourceId, 'historical-ip');
    const recordedDelivery = (await qualifications.history(db, pilot.id, 20, 0)).find(row => row.event_id === fw.id);
    assert.ok(recordedDelivery.delivery.some(job => job.target === 'graduation' && job.state === 'pending'));
    await assert.rejects(apply(reviewing, { ...revoke, reason: 'Changed after confirmation' }), /different qualification change/);
  });

  await t.test('dashboard paginates enrollments and separates dates, verified instructors, and imported activity', async () => {
    await training.setEnrollment(db, { userId: pilot.id, programId: 'rw', active: true, actor });
    await training.setEnrollment(db, { userId: '30', programId: 'rw', active: true, actor });
    const firstRows = await dashboard.roster(db, { days: 30, limit: 1, offset: 0 });
    const secondRows = await dashboard.roster(db, { days: 30, limit: 1, offset: 1 });
    assert.equal(firstRows[0].pilot_id, 11);
    assert.equal(firstRows[0].followup, 'no_record');
    assert.equal(Number(firstRows[0].slots_without_mr), 0);
    assert.equal(secondRows[0].pilot_id, 3250);
    assert.ok(secondRows[0].awards.length > 1);
    assert.deepEqual((await dashboard.roster(db, { program: 'fw', days: 14, status: 'active', limit: 5, offset: 0 }))
      .map(item => item.program_id), ['fw']);
    const stats = await dashboard.stats(db, ['2025-11-05', '2025-11-05'], 60);
    assert.equal(stats.enrollment.pilots, 2);
    assert.equal(stats.enrollment.enrollments, 3);
    assert.equal(stats.enrollment.multi, 1);
    assert.equal(Number(stats.attempts.attempts), 1);
    assert.equal(Number(stats.attempts.imported), 1);
    const counts = await dashboard.instructors(db, ['2025-11-01', '2025-11-30'], 5, 0);
    assert.deepEqual(counts.rows.map(item => item.instructor_pilot_id), [11]);
    assert.equal(counts.rows[0].trainees, 1);
    assert.equal(counts.imported.attempts, 1);
    const none = await dashboard.instructors(db, ['2020-01-01', '2020-12-31'], 5, 0);
    assert.deepEqual(none.rows, []);
  });


  await t.test('007 preserves manual native pivots and supports precise owned-row removal', async () => {
    await db.query(`
      CREATE TABLE user_awards (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, award_id INT);
      CREATE TABLE role_user (user_id INT, role_id INT, user_type VARCHAR(80), PRIMARY KEY (user_id, role_id, user_type));
      CREATE TABLE typerating_user (user_id INT, typerating_id INT, PRIMARY KEY (user_id, typerating_id));
      INSERT INTO user_awards (user_id, award_id) VALUES (10, 8);
      INSERT INTO role_user VALUES (10, 20, 'user');
      INSERT INTO typerating_user VALUES (10, 100), (10, 200);
    `);
    await db.query(await readFile(path.join(__dirname, '../migrations/007_training_native_ownership.sql'), 'utf8'));
    const owned = 'b'.repeat(64);
    await db.execute('INSERT INTO user_awards (user_id, award_id, vuscg_qualification_owner) VALUES (?, ?, ?)', [10, 8, owned]);
    await assert.rejects(db.execute('INSERT INTO user_awards (user_id, award_id, vuscg_qualification_owner) VALUES (?, ?, ?)',
      [10, 8, owned]), { code: 'ER_DUP_ENTRY' });
    await db.execute('DELETE FROM user_awards WHERE user_id=? AND award_id=? AND vuscg_qualification_owner=?', [10, 8, owned]);
    const [[manual]] = await db.execute('SELECT vuscg_qualification_owner FROM user_awards WHERE user_id=10 AND award_id=8');
    assert.equal(manual.vuscg_qualification_owner, null);
    const [[role]] = await db.execute('SELECT vuscg_qualification_owner FROM role_user WHERE user_id=10 AND role_id=20');
    assert.equal(role.vuscg_qualification_owner, null);
    const [ratings] = await db.execute('SELECT typerating_id FROM typerating_user WHERE user_id=10 ORDER BY typerating_id');
    assert.deepEqual(ratings.map(item => item.typerating_id), [100, 200]);
  });


  await t.test('audited graduation resumes after Discord outage and announces once after dependencies', async () => {
    const [[event]] = await db.query(`SELECT e.* FROM vuscg_training_qualification_status s
      JOIN vuscg_training_qualification_events e ON e.event_id = s.last_event_id
      WHERE s.qualification_id = 'mr' AND s.active AND s.user_id = 10`);
    const roleIds = { pilot: '110000000000000001', cadet: '110000000000000002', rw: '110000000000000003',
      fw: '110000000000000004', o2: '110000000000000005' };
    const previous = {};
    const settings = { TRAINING_GRADUATION_RANK_NAME: 'LTJG', TRAINING_CHANNEL_ID: 'fixture-parent',
      ...Object.fromEntries(Object.entries(roleIds).map(([key, value]) => [`TRAINING_GRADUATION_${key.toUpperCase()}_ROLE_ID`, value])) };
    for (const [key, value] of Object.entries(settings)) { previous[key] = process.env[key]; process.env[key] = value; }
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const opposite = roleIds[event.program_id === 'rw' ? 'fw' : 'rw'];
    const roles = new Set([opposite, roleIds.cadet, 'senior']);
    let failed = false;
    let announcements = 0;
    const user = {
      manageable: true,
      roles: { cache: roles, add: async id => {
        if (id === roleIds[event.program_id] && !failed) { failed = true; throw new Error('Discord unavailable'); }
        roles.add(id);
      }, remove: async id => { roles.delete(id); } },
      setNickname: async name => { user.nickname = name; },
    };
    const thread = {
      id: 'thread', parentId: 'fixture-parent', type: ChannelType.PrivateThread, name: 'Training Case for C3250',
      members: { fetch: async ({ member }) => member === event.graduate_discord_id },
      send: async message => { assert.deepEqual(message.allowedMentions.parse, []); announcements++; },
    };
    const guild = {
      roles: { fetch: async () => new Map(Object.values(roleIds).map(id => [id, { editable: true, permissions: { has: () => false } }])) },
      members: { fetch: async opts => { assert.equal(opts.user, event.graduate_discord_id); return user; } },
      channels: { fetch: async () => ({ id: 'fixture-parent', threads: {
        fetchActive: async () => ({ threads: new Collection([[thread.id, thread]]) }),
        fetchArchived: async () => ({ threads: new Collection(), hasMore: false }),
      } }) },
    };
    const client = { guilds: { fetch: async () => guild } };
    const due = () => db.execute("UPDATE vuscg_training_qualification_sync SET next_attempt_at=UTC_TIMESTAMP() WHERE event_id=? AND target='graduation'", [event.event_id]);
    const state = async () => (await db.execute("SELECT state FROM vuscg_training_qualification_sync WHERE event_id=? AND target='graduation'", [event.event_id]))[0][0].state;
    await runGraduations(client, db, 'qualification-fixture');
    assert.equal(await state(), 'retry');
    assert.equal(failed, false);
    for (const target of ['award', 'type_rating']) {
      await db.execute("UPDATE vuscg_training_qualification_sync SET state='complete' WHERE event_id=? AND target=?", [event.event_id, target]);
      await db.execute(`INSERT INTO vuscg_training_qualification_sync_attempts (event_id,target,result,created_at)
        VALUES (?,?,'inserted',UTC_TIMESTAMP(6))`, [event.event_id, target]);
    }
    await due();
    await runGraduations(client, db, 'qualification-fixture');
    assert.equal(await state(), 'retry');
    assert.ok(roles.has(roleIds.cadet));
    await due();
    await runGraduations(client, db, 'qualification-fixture');
    await runGraduations(client, db, 'qualification-fixture');
    assert.equal(await state(), 'complete');
    assert.equal(announcements, 1);
    assert.ok(roles.has(roleIds[event.program_id]) && roles.has(opposite) && roles.has('senior'));
    assert.ok(!roles.has(roleIds.cadet) && !roles.has(roleIds.o2));
    assert.equal(user.nickname, 'C3250 CDR Example P');
  });


  await t.test('reviewed migration order preserves CGAS state and read-only schema inventory executes', async () => {
    const sql = relative => readFile(path.join(__dirname, '..', relative), 'utf8');
    for (const file of ['001_cgas_tour.sql', '002_cgas_historical_announcements.sql', '003_cgas_phpvms_awards.sql']) {
      await db.query(await sql('migrations/' + file));
    }
    await db.query(await sql('integrations/phpvms7/bridge-nonces.sql'));
    await db.query(await sql('integrations/phpvms7/bridge-nonces.sql'));
    const [inventory] = await db.query(await sql('integrations/phpvms7/training-schema-preflight.sql'));
    assert.equal(inventory[1][0].selected_schema, 'vuscg_training_test');
    assert.ok(inventory[2].some(row => row.TABLE_NAME === 'bot_cgas_completions'));
    assert.ok(inventory[3].some(row => row.TABLE_NAME === 'bot_cgas_completions' && row.COLUMN_NAME === 'award_status'));
    assert.ok(inventory[3].some(row => row.TABLE_NAME === 'user_awards' && row.COLUMN_NAME === 'vuscg_qualification_owner'));
    assert.ok(inventory[5].some(row => row.CONSTRAINT_NAME === 'chk_training_qual_actor' && row.ENFORCED === 'YES'));
    const [[count]] = await db.query('SELECT COUNT(*) AS count FROM bot_cgas_completions');
    assert.equal(count.count, 0);
  });

});
