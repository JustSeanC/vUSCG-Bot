const { stat, readFile } = require('node:fs/promises');
const { parseArgs } = require('node:util');
const { createStrictPool } = require('../utils/databasePool');
const { TrainingError } = require('../utils/training/validation');
const { parseInput, importRows, sourceIdentifier } = require('../utils/training/import');
require('dotenv').config();

async function main() {
  const { values, positionals } = parseArgs({
    options: { dataset: { type: 'string' }, apply: { type: 'boolean' } },
    allowPositionals: true,
  });
  if (!values.dataset || positionals.length !== 1) {
    throw new TrainingError('Usage: node scripts/import-training.js --dataset <stable-export-id> [--apply] <file.csv|file.json>');
  }
  sourceIdentifier(values.dataset);
  const [filename] = positionals;
  const file = await stat(filename);
  if (!file.isFile() || file.size > 16 * 1024 * 1024) throw new TrainingError('Provide an input file of at most 16 MiB.');
  const entries = parseInput(filename, await readFile(filename, 'utf8'));
  const { DB_HOST, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  if (!DB_HOST || !DB_USER || !DB_NAME) throw new TrainingError('Configure DB_HOST, DB_USER, and DB_NAME for the intended database.');
  const db = createStrictPool({ host: DB_HOST, user: DB_USER, password: DB_PASSWORD, database: DB_NAME, timezone: 'Z' });
  try {
    const report = await importRows(db, entries, { dataset: values.dataset, apply: values.apply });
    console.log(JSON.stringify(report, null, 2));
    if (report.stopped) process.exitCode = 1;
    else if (report.counts.rejected) process.exitCode = 2;
  } finally {
    await db.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof TrainingError ? error.message : `Training import failed (${error.code || error.name}).`);
    process.exitCode = 1;
  });
}
