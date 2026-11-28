const { TrainingError } = require('./validation');

async function hasGuards(db, statement, expected) {
  const [[row]] = await db.query(statement);
  const definition = row['Create Table'].replaceAll('`', '');
  return expected.every(([name, column]) => definition.includes(
    `CONSTRAINT ${name} FOREIGN KEY (${column}) REFERENCES vuscg_training_integrity_guard (allowed)`,
  ));
}

// The legacy 8.4 scripts can appear to install on 5.7 while silently dropping CHECK enforcement.
async function requireTrainingIntegrity(db, { qualifications = false } = {}) {
  const [[session]] = await db.query(`SELECT VERSION() AS version,
    @@SESSION.foreign_key_checks AS fk_checks,
    FIND_IN_SET('STRICT_TRANS_TABLES', @@SESSION.sql_mode) OR
      FIND_IN_SET('STRICT_ALL_TABLES', @@SESSION.sql_mode) AS strict_mode`);
  if (!/^5\.7\./.test(session.version)) return;

  const ready = async () => /^5\.7\.44(?:-|$)/.test(session.version) && Number(session.fk_checks) &&
    Number(session.strict_mode) && await hasGuards(db, 'SHOW CREATE TABLE vuscg_training_records', [
      ['fk_training_source_guard', 'source_guard'], ['fk_training_void_guard', 'void_audit_guard'],
    ]) && (!qualifications || await hasGuards(db, 'SHOW CREATE TABLE vuscg_training_qualification_events', [
      ['fk_training_actor_guard', 'actor_guard'], ['fk_training_revoke_guard', 'revoke_reason_guard'],
    ]));

  try {
    if (await ready()) return;
  } catch (error) {
    if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
  }
  throw new TrainingError('Training writes require the verified MySQL 5.7.44 migration path, foreign keys, and strict SQL mode.');
}

module.exports = { requireTrainingIntegrity };
