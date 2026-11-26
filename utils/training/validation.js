const OUTCOMES = { passed: 'Passed', needs_training: 'Needs training', in_progress: 'In progress' };
const TEXT_LIMIT = 400;

class TrainingError extends Error {}

function pilotNumber(value) {
  const match = /^(?:C)?([0-9]{1,15})$/i.exec(String(value ?? '').trim());
  if (!match || Number(match[1]) === 0) throw new TrainingError('Enter a valid public pilot number, such as C3250.');
  return String(Number(match[1]));
}

function code(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(value)) {
    throw new TrainingError(`Enter a valid ${label} identifier.`);
  }
  return value;
}

function trainingDate(value, today = new Date().toISOString().slice(0, 10)) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/.test(value)) {
    throw new TrainingError('Use YYYY-MM-DD for the training date.');
  }
  const date = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || value > today) {
    throw new TrainingError('The training date must be a real calendar date on or before today (UTC).');
  }
  return value;
}

function text(value, label, required = false) {
  const normalized = String(value ?? '').trim().replace(/\r\n/g, '\n');
  if ((required && !normalized) || normalized.length > TEXT_LIMIT || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(normalized)) {
    throw new TrainingError(`${label} must be valid text of at most ${TEXT_LIMIT} characters.`);
  }
  return normalized;
}

function snowflake(value) {
  if (typeof value !== 'string' || !/^\d{17,20}$/.test(value)) throw new TrainingError('Invalid Discord identity.');
  return value;
}

function recordId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) {
    throw new TrainingError('Enter a valid training record ID.');
  }
  return value;
}

function evaluation({ programId, lessonId, outcome, date, comments }) {
  if (!Object.hasOwn(OUTCOMES, outcome)) throw new TrainingError('Select a valid evaluation outcome.');
  return {
    programId: code(programId, 'program'),
    lessonId: code(lessonId, 'lesson'),
    outcome,
    date: trainingDate(date ?? new Date().toISOString().slice(0, 10)),
    comments: text(comments, 'Comments'),
  };
}

module.exports = {
  TrainingError, OUTCOMES, TEXT_LIMIT, pilotNumber, code, trainingDate, text, snowflake, recordId, evaluation,
};
