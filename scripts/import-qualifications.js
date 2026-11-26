const { createHash } = require('node:crypto');
const { readFile, stat } = require('node:fs/promises');
const { parseArgs } = require('node:util');
const mysql = require('mysql2/promise');
const { first, findPilot } = require('../utils/training/service');
const { catalogEntry } = require('../utils/training/qualifications');
const { TrainingError, code, trainingDate } = require('../utils/training/validation');
const { sourceIdentifier } = require('../utils/training/import');

async function importQualifications(db, rows, { dataset, stage = false }) {
  sourceIdentifier(dataset);
  if (!Array.isArray(rows) || rows.length > 25000) throw new TrainingError('Provide an array of up to 25,000 reviewed rows.');
  const counts = new Map();
  for (const row of rows) counts.set(row?.source_id, (counts.get(row?.source_id) ?? 0) + 1);
  const report = [];
  for (const [index, row] of rows.entries()) {
    const number = index + 1;
    try {
      const sourceId = sourceIdentifier(row?.source_id);
      if (counts.get(sourceId) !== 1) throw new TrainingError('Duplicate source ID in this export.');
      if (row.flag === 'NO') {
        report.push({ row: number, status: 'ignored_no' });
        continue;
      }
      if (row.flag !== 'YES' || typeof row.review !== 'string' || !row.review.trim() || row.review.length > 200 ||
          typeof row.tracker_label !== 'string' || !row.tracker_label.trim() || row.tracker_label.length > 100) {
        throw new TrainingError('A YES row needs an explicit tracker label and review reference.');
      }
      const qualification = code(row.qualification_id, 'qualification');
      const program = row.program ?? '';
      const date = trainingDate(row.date);
      const pilot = await findPilot(db, row.pilot_id);
      await catalogEntry(db, qualification, program, 'grant');
      const provenance = { dataset, sourceId, trackerLabel: row.tracker_label, flag: 'YES', review: row.review };
      const key = createHash('sha256').update(JSON.stringify([dataset, sourceId])).digest('hex');
      const columns = [key, pilot.id, pilot.pilot_id, qualification, program, date, JSON.stringify(provenance)];
      if (stage) {
        await db.execute(`INSERT INTO vuscg_training_qualification_imports
          (candidate_id, user_id, public_pilot_id, qualification_id, program_id, effective_date, provenance, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))
          ON DUPLICATE KEY UPDATE candidate_id = vuscg_training_qualification_imports.candidate_id`, columns);
      }
      const existing = await first(db, `SELECT CAST(user_id AS CHAR) AS user_id, public_pilot_id, qualification_id,
        program_id, DATE_FORMAT(effective_date, '%Y-%m-%d') AS effective_date, provenance
        FROM vuscg_training_qualification_imports WHERE candidate_id = ?`, [key]);
      if (existing && (existing.user_id !== pilot.id || String(existing.public_pilot_id) !== String(pilot.pilot_id) ||
          existing.qualification_id !== qualification || existing.program_id !== program || existing.effective_date !== date ||
          Object.entries(provenance).some(([property, value]) => existing.provenance[property] !== value))) {
        throw new TrainingError('This candidate ID already exists with different reviewed data.');
      }
      report.push({ row: number, candidateId: key, status: stage ? 'staged' : existing ? 'already_staged' : 'ready' });
    } catch (error) {
      if (!(error instanceof TrainingError)) throw error;
      report.push({ row: number, status: 'rejected', reason: error.message });
    }
  }
  return report;
}

async function main() {
  require('dotenv').config();
  const { values, positionals } = parseArgs({
    options: { dataset: { type: 'string' }, stage: { type: 'boolean' } }, allowPositionals: true,
  });
  if (!values.dataset || positionals.length !== 1) {
    throw new TrainingError('Usage: node scripts/import-qualifications.js --dataset <id> [--stage] reviewed.json');
  }
  const [filename] = positionals;
  if ((await stat(filename)).size > 16 * 1024 * 1024) throw new TrainingError('Use a file of at most 16 MiB.');
  const rows = JSON.parse(await readFile(filename, 'utf8'));
  const { DB_HOST, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  if (!DB_HOST || !DB_USER || !DB_NAME) throw new TrainingError('Configure the target training database.');
  const db = mysql.createPool({ host: DB_HOST, user: DB_USER, password: DB_PASSWORD, database: DB_NAME });
  try {
    const report = await importQualifications(db, rows, { dataset: values.dataset, stage: values.stage });
    const counts = {};
    for (const item of report) counts[item.status] = (counts[item.status] ?? 0) + 1;
    console.log(JSON.stringify({ mode: values.stage ? 'stage' : 'dry-run', counts, rows: report }, null, 2));
    if (counts.rejected) process.exitCode = 2;
  } finally {
    await db.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof TrainingError ? error.message : `Qualification import failed (${error.code || error.name}).`);
    process.exitCode = 1;
  });
}

module.exports = { importQualifications };
