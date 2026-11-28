-- MySQL 5.7.44 only. Run with an importer that stops on the first SQL error.
-- A missing-table error below means the selected server, schema, or migration state is unsafe.
SET @vuscg_p07_ready = VERSION() REGEXP '^5[.]7[.]44(-|$)' AND VERSION() NOT LIKE '%MariaDB%'
  AND DATABASE() IS NOT NULL AND @@session.foreign_key_checks = 1
  AND (FIND_IN_SET('STRICT_TRANS_TABLES', @@session.sql_mode) OR FIND_IN_SET('STRICT_ALL_TABLES', @@session.sql_mode))
  AND (NOT EXISTS (SELECT 1 FROM information_schema.TABLES WHERE table_schema=DATABASE()
    AND table_name='vuscg_training_records') OR (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE
    WHERE table_schema=DATABASE() AND table_name='vuscg_training_records'
      AND referenced_table_schema=DATABASE() AND referenced_table_name='vuscg_training_integrity_guard'
      AND referenced_column_name='allowed' AND constraint_name IN ('fk_training_source_guard', 'fk_training_void_guard')) = 2);
SET @vuscg_p07_assertion = IF(@vuscg_p07_ready, 'SELECT DATABASE() AS verified_mysql57_schema',
  'SELECT 1 FROM information_schema.VUSCG_STOP_WRONG_VERSION_SCHEMA_OR_MIGRATION');
PREPARE vuscg_p07_statement FROM @vuscg_p07_assertion;
EXECUTE vuscg_p07_statement;
DEALLOCATE PREPARE vuscg_p07_statement;

-- P02/P03 on MySQL 5.7. Initial source domain includes PIREP; 005 adds deduplication.
-- The only possible referenced value is 1. No cascades or triggers are needed.
CREATE TABLE IF NOT EXISTS vuscg_training_integrity_guard (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  allowed TINYINT UNSIGNED GENERATED ALWAYS AS (1) STORED,
  UNIQUE KEY uq_training_guard_allowed (allowed)
) ENGINE=InnoDB;
INSERT INTO vuscg_training_integrity_guard (id) VALUES (1) ON DUPLICATE KEY UPDATE id = id;
CREATE TABLE IF NOT EXISTS vuscg_training_programs (
  program_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  curriculum_complete BOOLEAN NOT NULL DEFAULT FALSE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS vuscg_training_lessons (
  program_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  lesson_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(80) NOT NULL,
  sort_order SMALLINT UNSIGNED NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (program_id, lesson_id),
  CONSTRAINT fk_training_lesson_program FOREIGN KEY (program_id)
    REFERENCES vuscg_training_programs (program_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS vuscg_training_enrollments (
  user_id BIGINT UNSIGNED NOT NULL,
  program_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  active BOOLEAN NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  created_by_discord_id VARCHAR(20) CHARACTER SET ascii NOT NULL,
  created_by_pilot_id BIGINT UNSIGNED NOT NULL,
  updated_by_discord_id VARCHAR(20) CHARACTER SET ascii NOT NULL,
  updated_by_pilot_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (user_id, program_id),
  CONSTRAINT fk_training_enrollment_program FOREIGN KEY (program_id)
    REFERENCES vuscg_training_programs (program_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS vuscg_training_records (
  record_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  public_pilot_id BIGINT UNSIGNED NOT NULL,
  program_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  lesson_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  outcome ENUM('passed', 'needs_training', 'in_progress') NOT NULL,
  training_date DATE NOT NULL,
  created_at DATETIME(6) NOT NULL,
  instructor_discord_id VARCHAR(20) CHARACTER SET ascii NULL,
  instructor_pilot_id BIGINT UNSIGNED NOT NULL,
  comments VARCHAR(400) NOT NULL,
  source ENUM('manual', 'import', 'pirep') NOT NULL,
  source_key VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attempt_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provenance JSON NULL,
  pirep_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  voided_at DATETIME(6) NULL,
  voided_by_discord_id VARCHAR(20) CHARACTER SET ascii NULL,
  voided_by_pilot_id BIGINT UNSIGNED NULL,
  void_reason VARCHAR(400) NULL,
  void_interaction_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NULL,
  source_guard TINYINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN
    (source = 'manual' AND instructor_discord_id IS NOT NULL)
    OR (source = 'import' AND instructor_discord_id IS NULL)
    OR (source = 'pirep' AND instructor_discord_id IS NOT NULL AND pirep_id IS NOT NULL)
    THEN 1 ELSE 0 END) STORED,
  void_audit_guard TINYINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN
    (voided_at IS NULL AND voided_by_discord_id IS NULL AND voided_by_pilot_id IS NULL
      AND void_reason IS NULL AND void_interaction_id IS NULL)
    OR (voided_at IS NOT NULL AND voided_by_discord_id IS NOT NULL AND voided_by_pilot_id IS NOT NULL
      AND void_reason IS NOT NULL AND void_interaction_id IS NOT NULL)
    THEN 1 ELSE 0 END) STORED,
  UNIQUE KEY uq_training_source_key (source_key),
  UNIQUE KEY uq_training_void_interaction (void_interaction_id),
  KEY ix_training_attempt (user_id, program_id, lesson_id, attempt_hash, voided_at),
  KEY ix_training_progress (user_id, program_id, lesson_id, outcome, voided_at),
  KEY ix_training_latest (user_id, program_id, voided_at, created_at, record_id),
  KEY ix_training_history (user_id, training_date, created_at, record_id),
  CONSTRAINT fk_training_record_enrollment FOREIGN KEY (user_id, program_id)
    REFERENCES vuscg_training_enrollments (user_id, program_id),
  CONSTRAINT fk_training_record_lesson FOREIGN KEY (program_id, lesson_id)
    REFERENCES vuscg_training_lessons (program_id, lesson_id),
  CONSTRAINT fk_training_source_guard FOREIGN KEY (source_guard)
    REFERENCES vuscg_training_integrity_guard (allowed),
  CONSTRAINT fk_training_void_guard FOREIGN KEY (void_audit_guard)
    REFERENCES vuscg_training_integrity_guard (allowed)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO vuscg_training_programs (program_id, name, enabled, curriculum_complete)
VALUES ('rw', 'Rotary Wing', TRUE, FALSE), ('fw', 'Fixed Wing', TRUE, FALSE),
       ('stage-zero', 'Stage Zero', FALSE, FALSE)
ON DUPLICATE KEY UPDATE program_id = vuscg_training_programs.program_id;

INSERT INTO vuscg_training_lessons (program_id, lesson_id, name, sort_order)
VALUES
  ('rw', 'flight-1', 'Flight 1', 1), ('rw', 'flight-2', 'Flight 2', 2), ('rw', 'flight-3', 'Flight 3', 3),
  ('rw', 'flight-4', 'Flight 4', 4), ('rw', 'flight-5', 'Flight 5', 5), ('rw', 'flight-6', 'Flight 6', 6),
  ('rw', 'flight-7', 'Flight 7', 7), ('rw', 'flight-8', 'Flight 8', 8), ('rw', 'flight-9', 'Flight 9', 9),
  ('fw', 'flight-1', 'Flight 1', 1), ('fw', 'flight-2', 'Flight 2', 2), ('fw', 'flight-3', 'Flight 3', 3),
  ('fw', 'flight-4', 'Flight 4', 4), ('fw', 'flight-5', 'Flight 5', 5), ('fw', 'flight-6', 'Flight 6', 6),
  ('fw', 'flight-7', 'Flight 7', 7), ('fw', 'flight-8', 'Flight 8', 8), ('fw', 'flight-9', 'Flight 9', 9)
ON DUPLICATE KEY UPDATE lesson_id = vuscg_training_lessons.lesson_id;
