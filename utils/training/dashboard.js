const { first } = require('./service');
const { TrainingError, trainingDate, code } = require('./validation');

function followupDays(value = process.env.TRAINING_FOLLOWUP_DAYS) {
  if (value == null || value === '') return 30;
  if (!/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 365) {
    throw new TrainingError('TRAINING_FOLLOWUP_DAYS must be a whole number from 1 to 365.');
  }
  return Number(value);
}

function dateRange(start, end, today = new Date()) {
  const utc = today.toISOString().slice(0, 10);
  const last = trainingDate(end ?? utc, utc);
  const defaultStart = new Date(Date.parse(last) - 29 * 86400000).toISOString().slice(0, 10);
  const since = trainingDate(start ?? defaultStart, utc);
  if (since > last) throw new TrainingError('The start date must be on or before the end date.');
  return [since, last];
}

const metrics = `WITH latest AS (
  SELECT r.user_id, r.program_id, r.instructor_pilot_id, r.source, r.training_date,
    ROW_NUMBER() OVER (PARTITION BY r.user_id, r.program_id ORDER BY r.training_date DESC, r.created_at DESC, r.record_id DESC) AS position
  FROM vuscg_training_records r WHERE r.voided_at IS NULL
), status AS (
  SELECT e.user_id, e.program_id, e.active AND p.enabled AS active, u.pilot_id, u.name,
    COUNT(l.lesson_id) AS configured,
    SUM(EXISTS (SELECT 1 FROM vuscg_training_records r
      WHERE r.user_id = e.user_id AND r.program_id = e.program_id
        AND r.lesson_id = l.lesson_id AND r.outcome = 'passed' AND r.voided_at IS NULL)) AS completed
  FROM vuscg_training_enrollments e JOIN vuscg_training_programs p USING (program_id)
  JOIN users u ON u.id = e.user_id
  LEFT JOIN vuscg_training_lessons l ON l.program_id = e.program_id AND l.active = TRUE
  GROUP BY e.user_id, e.program_id, e.active, p.enabled, u.pilot_id, u.name
), metrics AS (
  SELECT s.*, l.instructor_pilot_id, l.source, l.training_date,
    CASE WHEN NOT s.active THEN 'paused' WHEN l.training_date IS NULL THEN 'no_record'
      WHEN DATEDIFF(UTC_DATE(), l.training_date) >= ? THEN 'follow_up' ELSE 'recent' END AS followup,
    s.configured > 0 AND s.configured = s.completed AND NOT EXISTS (
      SELECT 1 FROM vuscg_training_qualification_status q
      WHERE q.user_id = s.user_id AND q.qualification_id = 'mr' AND q.active = TRUE
        AND q.program_id IN ('', s.program_id)
    ) AS slots_without_mr
  FROM status s LEFT JOIN latest l ON l.user_id = s.user_id AND l.program_id = s.program_id AND l.position = 1
)`;

async function roster(db, { program = null, status = 'all', days, limit, offset }) {
  const track = program == null ? null : code(program, 'program');
  if (!['all', 'active', 'paused'].includes(status)) throw new TrainingError('Select a valid enrollment status.');
  const active = status === 'all' ? null : Number(status === 'active');
  const [rows] = await db.query(`${metrics}
    SELECT m.*, DATE_FORMAT(m.training_date, '%Y-%m-%d') AS latest_date,
      (SELECT GROUP_CONCAT(e.program_id ORDER BY e.program_id SEPARATOR ', ') FROM vuscg_training_enrollments e
        JOIN vuscg_training_programs p USING (program_id)
        WHERE e.user_id = m.user_id AND e.active AND p.enabled) AS active_programs,
      (SELECT JSON_ARRAYAGG(JSON_OBJECT('name', q.name, 'program_id', qs.program_id))
        FROM vuscg_training_qualification_status qs JOIN vuscg_training_qualifications q USING (qualification_id)
        WHERE qs.user_id = m.user_id AND qs.active) AS awards
    FROM metrics m WHERE (? IS NULL OR m.program_id = ?) AND (? IS NULL OR m.active = ?)
    ORDER BY m.pilot_id, m.user_id, m.program_id LIMIT ? OFFSET ?`, [days, track, track, active, active, limit, offset]);
  return rows;
}

async function stats(db, [start, end], days) {
  const [enrollment, attempts, awardCounts, recent] = await Promise.all([
    first(db, `${metrics}
      SELECT COUNT(DISTINCT user_id) AS pilots, COUNT(*) AS enrollments,
        SUM(active AND program_id = 'rw') AS rw, SUM(active AND program_id = 'fw') AS fw,
        (SELECT COUNT(*) FROM (SELECT user_id FROM metrics WHERE active GROUP BY user_id HAVING COUNT(*) > 1) AS multi) AS multi,
        SUM(completed) AS completed, SUM(followup = 'no_record') AS no_record,
        SUM(followup = 'follow_up') AS follow_up, SUM(followup = 'recent') AS recent,
        SUM(followup = 'paused') AS paused, SUM(active AND slots_without_mr) AS slots_without_mr
      FROM metrics`, [days]),
    first(db, `SELECT COUNT(*) AS attempts, SUM(outcome = 'passed') AS passed, SUM(outcome = 'needs_training') AS needs_training,
      SUM(outcome = 'in_progress') AS in_progress, SUM(source = 'import') AS imported, COUNT(DISTINCT user_id) AS trained
      FROM vuscg_training_records WHERE training_date BETWEEN ? AND ? AND voided_at IS NULL`, [start, end]),
    db.execute(`SELECT q.qualification_id, q.name, COUNT(s.user_id) AS awards, COUNT(DISTINCT s.user_id) AS pilots
      FROM vuscg_training_qualifications q LEFT JOIN vuscg_training_qualification_status s
        ON s.qualification_id = q.qualification_id AND s.active
      GROUP BY q.qualification_id, q.name ORDER BY q.qualification_id`),
    db.execute(`SELECT u.pilot_id, r.program_id, r.lesson_id, r.record_id,
      DATE_FORMAT(r.training_date, '%Y-%m-%d') AS training_date FROM vuscg_training_records r
      JOIN users u ON u.id = r.user_id WHERE r.training_date BETWEEN ? AND ? AND r.voided_at IS NULL AND r.outcome = 'passed'
      ORDER BY r.training_date DESC, r.created_at DESC, r.record_id DESC LIMIT 5`, [start, end]),
  ]);
  return { enrollment, attempts, awards: awardCounts[0], recent: recent[0] };
}

async function instructors(db, [start, end], limit, offset) {
  const [rows] = await db.query(`SELECT instructor_pilot_id, COUNT(*) AS attempts, COUNT(DISTINCT user_id) AS trainees,
      SUM(outcome = 'passed') AS passed, SUM(outcome = 'needs_training') AS needs_training,
      SUM(outcome = 'in_progress') AS in_progress, SUM(program_id = 'rw') AS rw, SUM(program_id = 'fw') AS fw,
      DATE_FORMAT(MAX(training_date), '%Y-%m-%d') AS latest
    FROM vuscg_training_records WHERE training_date BETWEEN ? AND ? AND voided_at IS NULL
      AND source IN ('manual', 'pirep') AND instructor_discord_id IS NOT NULL
    GROUP BY instructor_pilot_id ORDER BY instructor_pilot_id LIMIT ? OFFSET ?`, [start, end, limit, offset]);
  const imported = await first(db, `SELECT COUNT(*) AS attempts, COUNT(DISTINCT instructor_pilot_id) AS identifiers
    FROM vuscg_training_records WHERE training_date BETWEEN ? AND ? AND voided_at IS NULL AND source = 'import'`, [start, end]);
  return { rows, imported };
}

module.exports = { followupDays, dateRange, roster, stats, instructors };
