-- MySQL 5.7.44 only. Run with an importer that stops on the first SQL error.
-- A missing-table error below means the selected server, schema, or migration state is unsafe.
SET @vuscg_p07_ready = VERSION() REGEXP '^5[.]7[.]44(-|$)' AND VERSION() NOT LIKE '%MariaDB%'
  AND DATABASE() IS NOT NULL AND @@session.foreign_key_checks = 1
  AND (FIND_IN_SET('STRICT_TRANS_TABLES', @@session.sql_mode) OR FIND_IN_SET('STRICT_ALL_TABLES', @@session.sql_mode))
  AND (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE
    WHERE table_schema=DATABASE() AND table_name='vuscg_training_records'
      AND referenced_table_schema=DATABASE() AND referenced_table_name='vuscg_training_integrity_guard'
      AND referenced_column_name='allowed' AND constraint_name IN ('fk_training_source_guard', 'fk_training_void_guard')) = 2;
SET @vuscg_p07_assertion = IF(@vuscg_p07_ready, 'SELECT DATABASE() AS verified_mysql57_schema',
  'SELECT 1 FROM information_schema.VUSCG_STOP_WRONG_VERSION_SCHEMA_OR_MIGRATION');
PREPARE vuscg_p07_statement FROM @vuscg_p07_assertion;
EXECUTE vuscg_p07_statement;
DEALLOCATE PREPARE vuscg_p07_statement;

-- Run once after matching 004. In MySQL 5.7, source integrity is already in 004.
ALTER TABLE vuscg_training_records
  ADD COLUMN active_pirep_evaluation TINYINT GENERATED ALWAYS AS (
    CASE WHEN source = 'pirep' AND voided_at IS NULL THEN 1 ELSE NULL END
  ) STORED,
  ADD UNIQUE KEY uq_training_pirep_evaluation
    (user_id, program_id, lesson_id, pirep_id, outcome, active_pirep_evaluation);
