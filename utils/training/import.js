const { extname } = require('node:path');
const service = require('./service');
const { TrainingError, pilotNumber, code, trainingDate, evaluation } = require('./validation');

const requiredColumns = ['source_id', 'pilot_id', 'track', 'lesson', 'instructor', 'date', 'result'];
const optionalColumns = ['mapped_track', 'comments'];

function csvRows(input) {
  const rows = [];
  let row = [];
  let field = '';
  let state = 'start';
  for (let position = 0; position < input.length; position++) {
    const char = input[position];
    if (state === 'quoted') {
      if (char === '"' && input[position + 1] === '"') {
        field += '"';
        position++;
      } else if (char === '"') {
        state = 'closed';
      } else {
        field += char;
      }
    } else if (char === ',' || char === '\r' || char === '\n') {
      row.push(field);
      field = '';
      state = 'start';
      if (char !== ',') {
        if (char === '\r' && input[position + 1] === '\n') position++;
        rows.push(row);
        row = [];
      }
    } else if (char === '"' && state === 'start') {
      state = 'quoted';
    } else {
      if (char === '"' || state === 'closed') throw new TrainingError('Malformed quoting in CSV input.');
      field += char;
      state = 'plain';
    }
  }
  if (state === 'quoted') throw new TrainingError('CSV ends inside a quoted field.');
  if (row.length || field || state === 'closed') rows.push([...row, field]);
  return rows;
}

function parseInput(filename, input) {
  const contents = input.replace(/^\uFEFF/, '');
  if (extname(filename).toLowerCase() === '.json') {
    let rows;
    try {
      rows = JSON.parse(contents);
    } catch {
      throw new TrainingError('Input is invalid JSON.');
    }
    if (!Array.isArray(rows)) throw new TrainingError('JSON input must be an array of training attempt objects.');
    return rows.map((row, index) => ({ row, number: index + 1 }));
  }
  if (extname(filename).toLowerCase() !== '.csv') throw new TrainingError('Use a CSV or JSON file.');
  const [headers, ...rows] = csvRows(contents);
  if (!headers || new Set(headers).size !== headers.length || requiredColumns.some(name => !headers.includes(name)) ||
      headers.some(name => !requiredColumns.includes(name) && !optionalColumns.includes(name))) {
    throw new TrainingError('CSV header must contain the documented columns with no duplicates.');
  }
  return rows.map((values, index) => {
    const number = index + 2;
    if (values.every(value => value.trim() === '')) return { number, blank: true };
    if (values.length !== headers.length) return { number, error: 'CSV row has the wrong number of fields.' };
    return { number, row: Object.fromEntries(headers.map((key, column) => [key, values[column]])) };
  });
}

function sourceIdentifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$/.test(value)) {
    throw new TrainingError('Dataset and source IDs must be stable text identifiers of 1–80 characters.');
  }
  return value;
}

function normalizeRow(row, dataset) {
  if (!row || typeof row !== 'object' || Array.isArray(row) ||
      Object.keys(row).some(key => !requiredColumns.includes(key) && !optionalColumns.includes(key)) ||
      Object.entries(row).some(([key, value]) => value != null && typeof value !== 'string' &&
        !(['pilot_id', 'instructor'].includes(key) && Number.isSafeInteger(value)))) {
    throw new TrainingError('Row does not match the documented import format.');
  }
  if (!String(row.lesson ?? '').trim()) return null;
  const originalTrack = String(row.track ?? '').trim();
  const track = originalTrack.toLowerCase();
  const mapped = String(row.mapped_track ?? '').trim().toLowerCase();
  if (track === 'rw/fw' && !['rw', 'fw'].includes(mapped)) {
    throw new TrainingError('Ambiguous RW/FW lesson. Supply a reviewed mapped_track for this attempt.');
  }
  if (!['rw', 'fw', 'rw/fw'].includes(track) || (track !== 'rw/fw' && mapped)) {
    throw new TrainingError('Use RW, FW, or RW/FW with an explicit per-attempt mapping.');
  }
  const programId = track === 'rw/fw' ? mapped : track;
  const originalDate = String(row.date ?? '').trim();
  const normalizedDate = originalDate.replace(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/, (_, year, month, day) =>
    `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
  const instructorText = String(row.instructor ?? '').trim();
  return {
    pilotId: pilotNumber(row.pilot_id),
    details: evaluation({
      programId,
      lessonId: code(String(row.lesson).trim().toLowerCase(), 'lesson'),
      outcome: String(row.result ?? '').trim().toLowerCase(),
      date: trainingDate(normalizedDate),
      comments: row.comments,
    }),
    submission: {
      source: 'import',
      actor: { pilotId: pilotNumber(instructorText) },
      provenance: { dataset, sourceId: sourceIdentifier(row.source_id), originalTrack, originalDate, instructorText },
    },
  };
}

async function importRows(db, entries, { dataset, apply = false } = {}) {
  sourceIdentifier(dataset);
  if (entries.length > 25000) throw new TrainingError('Limit each import file to 25,000 rows.');
  const keys = new Map();
  const seenAttempts = new Set();
  const normalized = entries.map(entry => {
    if (entry.blank || entry.error) return entry;
    try {
      const data = normalizeRow(entry.row, dataset);
      if (!data) return { ...entry, blank: true };
      const { sourceId } = data.submission.provenance;
      const fingerprint = JSON.stringify(data);
      const previous = keys.get(sourceId);
      keys.set(sourceId, previous === undefined || previous === fingerprint ? fingerprint : null);
      return { number: entry.number, data };
    } catch (error) {
      if (!(error instanceof TrainingError)) throw error;
      const sourceId = entry.row?.source_id;
      if (typeof sourceId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$/.test(sourceId)) keys.set(sourceId, null);
      return { number: entry.number, error: error.message };
    }
  });

  const reports = [];
  const processed = new Set();
  const pilots = new Map();
  for (const entry of normalized) {
    const { number, data, blank, error } = entry;
    if (blank || error) {
      reports.push({ row: number, status: blank ? 'blank' : 'rejected', reason: error ?? 'Blank lesson or row.' });
      continue;
    }
    const { sourceId } = data.submission.provenance;
    if (keys.get(sourceId) === null || processed.has(sourceId)) {
      const conflicted = keys.get(sourceId) === null;
      reports.push({ row: number, sourceId, status: conflicted ? 'rejected' : 'duplicate',
        reason: conflicted ? 'Conflicting rows share a source ID.' : 'Repeated source ID in the file.' });
      continue;
    }
    processed.add(sourceId);
    try {
      if (!pilots.has(data.pilotId)) pilots.set(data.pilotId, await service.findPilot(db, data.pilotId));
      const record = service.prepareRecord(pilots.get(data.pilotId), data.details, data.submission);
      const inspection = await service.inspectImport(db, record);
      if (inspection.status !== 'ready') {
        reports.push({ row: number, sourceId, ...inspection,
          ...(inspection.status === 'duplicate' && { reason: 'A matching active attempt already exists.' }) });
        continue;
      }
      const fingerprint = JSON.stringify([record.userId, record.programId, record.lessonId, record.attemptHash]);
      if (seenAttempts.has(fingerprint)) {
        reports.push({ row: number, sourceId, status: 'duplicate', reason: 'Repeated attempt in the file.' });
        continue;
      }
      seenAttempts.add(fingerprint);
      const result = apply ? await service.createRecord(db, record) : null;
      reports.push({ row: number, sourceId, status: !result ? 'ready' : result.created ? 'imported' : 'existing',
        ...(result && { recordId: result.recordId }) });
    } catch (cause) {
      if (!(cause instanceof TrainingError)) {
        return summarize(apply, dataset, reports, { row: number, code: cause.code || cause.name });
      }
      reports.push({ row: number, sourceId, status: 'rejected', reason: cause.message });
    }
  }
  return summarize(apply, dataset, reports);
}

function summarize(apply, dataset, reports, stopped) {
  const counts = { ready: 0, imported: 0, existing: 0, blank: 0, duplicate: 0, rejected: 0 };
  for (const row of reports) counts[row.status]++;
  return { mode: apply ? 'apply' : 'dry-run', dataset, counts, ...(stopped && { stopped }), rows: reports };
}

module.exports = { parseInput, importRows, sourceIdentifier };
