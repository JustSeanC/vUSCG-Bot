CREATE TABLE IF NOT EXISTS vuscg_training_qualifications (
  qualification_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  description VARCHAR(400) NOT NULL DEFAULT '',
  scope ENUM('organization', 'program') NOT NULL DEFAULT 'organization',
  enabled BOOLEAN NOT NULL DEFAULT TRUE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS vuscg_training_qualification_imports (
  candidate_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  public_pilot_id BIGINT UNSIGNED NOT NULL,
  qualification_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  program_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  effective_date DATE NOT NULL,
  provenance JSON NOT NULL,
  created_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_training_qual_import_catalog FOREIGN KEY (qualification_id)
    REFERENCES vuscg_training_qualifications (qualification_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS vuscg_training_qualification_events (
  event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  public_pilot_id BIGINT UNSIGNED NOT NULL,
  qualification_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  program_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action ENUM('grant', 'revoke') NOT NULL,
  effective_date DATE NOT NULL,
  reviewer_user_id BIGINT UNSIGNED NOT NULL,
  reviewer_pilot_id BIGINT UNSIGNED NOT NULL,
  reviewer_discord_id VARCHAR(20) CHARACTER SET ascii NOT NULL,
  reviewer_role ENUM('command_staff', 'instructor_pilot') NOT NULL,
  reason VARCHAR(400) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  interaction_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  candidate_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  graduate_discord_id VARCHAR(20) CHARACTER SET ascii NULL,
  UNIQUE KEY uq_training_qual_interaction (interaction_id),
  UNIQUE KEY uq_training_qual_candidate (candidate_id),
  KEY ix_training_qual_history (user_id, created_at, event_id),
  CONSTRAINT chk_training_qual_actor CHECK (reviewer_role = 'command_staff' OR
    (action = 'grant' AND qualification_id IN ('mr','dlq','hitron','blackjack','mq9'))),
  CONSTRAINT chk_training_qual_revoke_reason CHECK (action <> 'revoke' OR CHAR_LENGTH(TRIM(reason)) > 0),
  CONSTRAINT fk_training_qual_event_catalog FOREIGN KEY (qualification_id)
    REFERENCES vuscg_training_qualifications (qualification_id),
  CONSTRAINT fk_training_qual_event_import FOREIGN KEY (candidate_id)
    REFERENCES vuscg_training_qualification_imports (candidate_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS vuscg_training_qualification_status (
  user_id BIGINT UNSIGNED NOT NULL,
  qualification_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  program_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  active BOOLEAN NOT NULL,
  last_event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (user_id, qualification_id, program_id),
  KEY ix_training_qual_active (qualification_id, active, user_id),
  CONSTRAINT fk_training_qual_status_catalog FOREIGN KEY (qualification_id)
    REFERENCES vuscg_training_qualifications (qualification_id),
  CONSTRAINT fk_training_qual_status_event FOREIGN KEY (last_event_id)
    REFERENCES vuscg_training_qualification_events (event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO vuscg_training_qualifications (qualification_id, name, scope) VALUES
  ('mr', 'Mission Rated', 'program'), ('ip', 'Instructor Pilot', 'organization'), ('dlq', 'DLQ', 'organization'),
  ('hitron', 'HITRON', 'organization'), ('blackjack', 'BLACKJACK', 'organization'), ('mq9', 'MQ9', 'organization')
ON DUPLICATE KEY UPDATE qualification_id = vuscg_training_qualifications.qualification_id;

-- Durable outbox and per-attempt native synchronization audit.
CREATE TABLE IF NOT EXISTS vuscg_training_qualification_sync (
  event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target ENUM('award', 'ip_role', 'type_rating', 'graduation') NOT NULL,
  state ENUM('pending', 'retry', 'complete') NOT NULL DEFAULT 'pending',
  next_attempt_at DATETIME NOT NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  announcement_state ENUM('pending', 'sending', 'sent') NOT NULL DEFAULT 'pending',
  PRIMARY KEY (event_id, target),
  KEY ix_training_qual_pending (state, next_attempt_at),
  CONSTRAINT fk_training_qual_sync_event FOREIGN KEY (event_id)
    REFERENCES vuscg_training_qualification_events (event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS vuscg_training_qualification_sync_attempts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target ENUM('award', 'ip_role', 'type_rating', 'graduation') NOT NULL,
  native_id BIGINT UNSIGNED NULL,
  result VARCHAR(80) CHARACTER SET ascii NOT NULL,
  created_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_training_qual_sync_attempt FOREIGN KEY (event_id, target)
    REFERENCES vuscg_training_qualification_sync (event_id, target)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
