const { createHash, randomUUID } = require('node:crypto');
const { resolvePilot } = require('../pilotStats');
const { TrainingError, pilotNumber, code, snowflake, recordId, text, evaluation } = require('./validation');

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function first(db, sql, params) {
  const [rows] = await db.execute(sql, params);
  return rows[0];
}

async function transaction(db, run) {
  const connection = await db.getConnection();
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await connection.beginTransaction();
    const result = await run(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function findPilot(db, value) {
  const pilot = await first(db, 'SELECT CAST(id AS CHAR) AS id, pilot_id, name FROM users WHERE pilot_id = ? LIMIT 1',
    [pilotNumber(value)]);
  if (!pilot) throw new TrainingError('That public pilot number is missing from phpVMS.');
  return pilot;
}

async function linkedPilot(db, interaction) {
  const pilot = await resolvePilot(db, interaction, { allowNicknameFallback: false });
  if (pilot.error) {
    throw new TrainingError('Your Discord account needs a valid phpVMS pilot link. Ask Command Staff to verify your existing account link.');
  }
  return pilot;
}

async function linkedDiscordForPilot(db, pilotId) {
  const [links] = await db.execute('SELECT discord_id FROM discord_links WHERE pilot_id = ? LIMIT 2', [pilotId]);
  return links.length === 1 ? snowflake(links[0].discord_id) : null;
}

async function getProgram(db, programId) {
  const program = await first(db, `SELECT program_id, name FROM vuscg_training_programs
    WHERE program_id = ? AND enabled = TRUE`, [code(programId, 'program')]);
  if (!program) throw new TrainingError('That training program is unavailable.');
  return program;
}

async function getLesson(db, programId, lessonId) {
  const lesson = await first(db, `SELECT l.name, p.name AS program_name FROM vuscg_training_lessons l
    JOIN vuscg_training_programs p USING (program_id)
    WHERE l.program_id = ? AND l.lesson_id = ? AND l.active = TRUE AND p.enabled = TRUE`, [programId, lessonId]);
  if (!lesson) throw new TrainingError('That lesson is unavailable in the selected training program.');
  return lesson;
}

function booking(db, userId, programId, lock = false) {
  return first(db, `SELECT active FROM vuscg_training_enrollments WHERE user_id = ? AND program_id = ?${lock ? ' FOR UPDATE' : ''}`,
    [userId, programId]);
}

function checkEnrollment(enrollment) {
  if (!enrollment?.active) throw new TrainingError('This pilot needs an active enrollment in that program. Ask Command Staff to use /training enroll.');
}

async function previewEvaluation(db, pilotId, input) {
  const data = evaluation(input);
  const pilot = await findPilot(db, pilotId);
  const lesson = await getLesson(db, data.programId, data.lessonId);
  checkEnrollment(await booking(db, pilot.id, data.programId));
  return { pilot, lesson, data };
}

async function setEnrollment(db, { userId, programId, active, actor }) {
  const discordId = snowflake(actor.discordId);
  const instructor = pilotNumber(actor.pilotId);
  return transaction(db, async connection => {
    await getProgram(connection, programId);
    if (active) {
      await connection.execute(`INSERT INTO vuscg_training_enrollments
        (user_id, program_id, active, created_at, updated_at, created_by_discord_id, created_by_pilot_id,
         updated_by_discord_id, updated_by_pilot_id)
        VALUES (?, ?, TRUE, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE user_id = vuscg_training_enrollments.user_id`,
      [userId, programId, discordId, instructor, discordId, instructor]);
    }
    const existing = await booking(connection, userId, programId, true);
    if (!existing) throw new TrainingError('This pilot has no enrollment in that program to pause.');
    if (Boolean(existing.active) !== active) {
      await connection.execute(`UPDATE vuscg_training_enrollments SET active = ?, updated_at = UTC_TIMESTAMP(6),
        updated_by_discord_id = ?, updated_by_pilot_id = ? WHERE user_id = ? AND program_id = ?`,
      [active, discordId, instructor, userId, programId]);
    }
  });
}

function prepareRecord(pilot, input, submission) {
  const data = evaluation(input);
  const publicId = pilotNumber(pilot.pilot_id);
  const userId = String(pilot.id);
  const instructor = pilotNumber(submission.actor.pilotId);
  if (!['manual', 'import'].includes(submission.source)) throw new TrainingError('Invalid training record source.');
  const imported = submission.source === 'import';
  const discordId = imported ? null : snowflake(submission.actor.discordId);
  const source = imported ? 'import' : 'manual';
  const provenance = imported ? submission.provenance : null;
  const sourceKey = imported
    ? 'import:' + hash([provenance.dataset, provenance.sourceId])
    : 'discord:' + snowflake(submission.interactionId);
  const pirepId = input.pirepId ?? null;
  if (pirepId !== null && (typeof pirepId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(pirepId))) {
    throw new TrainingError('Invalid associated PIREP ID.');
  }
  const attemptHash = hash([data.date, data.outcome, instructor, data.comments, pirepId]);
  const payloadHash = hash([userId, publicId, data.programId, data.lessonId, attemptHash, discordId, provenance]);
  return { ...data, userId, publicId, instructor, discordId, source, sourceKey, attemptHash, payloadHash, provenance, pirepId };
}

function sourceRecord(db, sourceKey) {
  return first(db, `SELECT record_id, payload_hash, voided_at FROM vuscg_training_records WHERE source_key = ?`, [sourceKey]);
}

function savedReplay(row, hashValue) {
  if (row.payload_hash !== hashValue) throw new TrainingError('That submission ID already exists with different values. Review the original record.');
  return { recordId: row.record_id, created: false, voided: Boolean(row.voided_at) };
}

function matchingAttempt(db, record) {
  return first(db, `SELECT record_id FROM vuscg_training_records
    WHERE user_id = ? AND program_id = ? AND lesson_id = ? AND attempt_hash = ? AND voided_at IS NULL LIMIT 1`,
  [record.userId, record.programId, record.lessonId, record.attemptHash]);
}

function assertDistinct(existing) {
  if (existing) throw new TrainingError(`A matching active attempt already exists (${existing.record_id}). Review history before recording a repeat.`);
}

async function inspectImport(db, record) {
  const existing = await sourceRecord(db, record.sourceKey);
  if (existing) {
    return { status: 'existing', recordId: savedReplay(existing, record.payloadHash).recordId };
  }
  await getLesson(db, record.programId, record.lessonId);
  checkEnrollment(await booking(db, record.userId, record.programId));
  const match = await matchingAttempt(db, record);
  return match ? { status: 'duplicate', recordId: match.record_id } : { status: 'ready' };
}

async function createRecord(db, record, { allowRepeat = false } = {}) {
  try {
    return await transaction(db, async connection => {
      // Every writer and void operation for the same pilot/program takes this lock first.
      const enrollment = await booking(connection, record.userId, record.programId, true);
      const existing = await sourceRecord(connection, record.sourceKey);
      if (existing) return savedReplay(existing, record.payloadHash);

      checkEnrollment(enrollment);
      await getLesson(connection, record.programId, record.lessonId);
      if (!allowRepeat) assertDistinct(await matchingAttempt(connection, record));

      const id = randomUUID();
      await connection.execute(`INSERT INTO vuscg_training_records
        (record_id, user_id, public_pilot_id, program_id, lesson_id, outcome, training_date, created_at,
         instructor_discord_id, instructor_pilot_id, comments, source, source_key, payload_hash, attempt_hash, provenance, pirep_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, record.userId, record.publicId, record.programId, record.lessonId, record.outcome, record.date,
        record.discordId, record.instructor, record.comments, record.source, record.sourceKey, record.payloadHash,
        record.attemptHash, record.provenance ? JSON.stringify(record.provenance) : null, record.pirepId]);
      return { recordId: id, created: true, voided: false };
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      const existing = await sourceRecord(db, record.sourceKey);
      if (existing) return savedReplay(existing, record.payloadHash);
    }
    throw error;
  }
}

async function getRecord(db, id) {
  const row = await first(db, `SELECT r.record_id, CAST(r.user_id AS CHAR) AS user_id, r.public_pilot_id,
    r.program_id, r.lesson_id, r.outcome, r.voided_at, DATE_FORMAT(r.training_date, '%Y-%m-%d') AS training_date,
    p.name AS program_name, l.name AS lesson_name
    FROM vuscg_training_records r JOIN vuscg_training_programs p USING (program_id)
    JOIN vuscg_training_lessons l USING (program_id, lesson_id)
    WHERE r.record_id = ?`, [recordId(id)]);
  if (!row) throw new TrainingError('Training record not found.');
  return row;
}

async function voidRecord(db, { id, reason, actor, interactionId }) {
  const target = await getRecord(db, id);
  const discordId = snowflake(actor.discordId);
  const instructor = pilotNumber(actor.pilotId);
  const correctionId = snowflake(interactionId);
  const explanation = text(reason, 'Correction reason', true);

  return transaction(db, async connection => {
    await booking(connection, target.user_id, target.program_id, true);
    const prior = await first(connection, `SELECT voided_at FROM vuscg_training_records
      WHERE record_id = ? FOR UPDATE`, [id]);
    if (!prior) throw new TrainingError('Training record not found.');
    if (prior.voided_at) return false;

    await connection.execute(`UPDATE vuscg_training_records SET voided_at = UTC_TIMESTAMP(6),
      voided_by_discord_id = ?, voided_by_pilot_id = ?, void_reason = ?, void_interaction_id = ?
      WHERE record_id = ?`, [discordId, instructor, explanation, correctionId, id]);
    return true;
  });
}

function summarizeProgress(rows) {
  const tracks = new Map();
  for (const row of rows) {
    if (!tracks.has(row.program_id)) {
      tracks.set(row.program_id, {
        id: row.program_id,
        name: row.program_name,
        active: Boolean(row.enrolled_active && row.enabled),
        curriculumComplete: Boolean(row.curriculum_complete),
        lastSignoffDate: row.latest_signoff_date,
        lastInstructor: row.latest_instructor,
        lastSource: row.latest_source,
        lastLesson: row.latest_lesson,
        lastOutcome: row.latest_outcome,
        lastTrainingDate: row.latest_training_date,
        completed: [],
        remaining: [],
      });
    }
    const track = tracks.get(row.program_id);
    if (row.lesson_id) {
      const lessons = row.passed ? track.completed : track.remaining;
      lessons.push({ id: row.lesson_id, name: row.lesson_name });
    }
  }
  return [...tracks.values()];
}

async function progress(db, userId) {
  const [rows] = await db.execute(`SELECT e.program_id, e.active AS enrolled_active, p.enabled, p.name AS program_name,
    p.curriculum_complete, l.lesson_id, l.name AS lesson_name,
    latest.instructor_pilot_id AS latest_instructor, latest.source AS latest_source,
    latest.outcome AS latest_outcome, latest_lesson.name AS latest_lesson,
    DATE_FORMAT(latest.created_at, '%Y-%m-%d %H:%i') AS latest_signoff_date,
    (SELECT DATE_FORMAT(MAX(r.training_date), '%Y-%m-%d') FROM vuscg_training_records r
      WHERE r.user_id = e.user_id AND r.program_id = e.program_id AND r.voided_at IS NULL) AS latest_training_date,
    EXISTS (SELECT 1 FROM vuscg_training_records r WHERE r.user_id = e.user_id AND r.program_id = e.program_id
      AND r.lesson_id = l.lesson_id AND r.outcome = 'passed' AND r.voided_at IS NULL) AS passed
    FROM vuscg_training_enrollments e JOIN vuscg_training_programs p USING (program_id)
    LEFT JOIN vuscg_training_lessons l ON l.program_id = e.program_id AND l.active = TRUE
    LEFT JOIN vuscg_training_records latest ON latest.record_id = (
      SELECT r.record_id FROM vuscg_training_records r
      WHERE r.user_id = e.user_id AND r.program_id = e.program_id AND r.voided_at IS NULL
      ORDER BY r.created_at DESC, r.record_id DESC LIMIT 1)
    LEFT JOIN vuscg_training_lessons latest_lesson
      ON latest_lesson.program_id = latest.program_id AND latest_lesson.lesson_id = latest.lesson_id
    WHERE e.user_id = ? ORDER BY e.active DESC, e.program_id, l.sort_order, l.lesson_id`, [userId]);
  return summarizeProgress(rows);
}

async function history(db, userId, limit, offset) {
  const [rows] = await db.query(`SELECT r.record_id, r.outcome, r.instructor_pilot_id, r.comments, r.source,
    r.voided_by_pilot_id, r.void_reason, DATE_FORMAT(r.voided_at, '%Y-%m-%d %H:%i') AS voided_at,
    DATE_FORMAT(r.training_date, '%Y-%m-%d') AS training_date,
    p.name AS program_name, l.name AS lesson_name
    FROM vuscg_training_records r JOIN vuscg_training_programs p USING (program_id)
    JOIN vuscg_training_lessons l USING (program_id, lesson_id)
    WHERE r.user_id = ? ORDER BY r.training_date DESC, r.created_at DESC, r.record_id DESC LIMIT ? OFFSET ?`,
  [userId, limit, offset]);
  return rows;
}

module.exports = {
  findPilot, linkedPilot, linkedDiscordForPilot, getProgram, previewEvaluation, setEnrollment, prepareRecord, inspectImport,
  createRecord, getRecord, voidRecord, progress, summarizeProgress, history,
};
