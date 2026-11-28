CREATE TABLE IF NOT EXISTS vuscg_training_resource_categories (
  category_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS vuscg_training_resources (
  resource_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  category_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(100) NOT NULL,
  url VARCHAR(1000) NOT NULL,
  description VARCHAR(400) NOT NULL,
  display_order SMALLINT UNSIGNED NOT NULL,
  active BOOLEAN NOT NULL,
  created_by_discord_id VARCHAR(20) CHARACTER SET ascii NOT NULL,
  created_by_pilot_id BIGINT UNSIGNED NOT NULL,
  edited_by_discord_id VARCHAR(20) CHARACTER SET ascii NOT NULL,
  edited_by_pilot_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  KEY ix_training_resource_category (category_id, active, display_order, resource_id),
  CONSTRAINT fk_training_resource_category FOREIGN KEY (category_id)
    REFERENCES vuscg_training_resource_categories (category_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS vuscg_training_resource_audit (
  interaction_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  category_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resource_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  action ENUM('add_category','add_link','edit_link','deactivate_link') NOT NULL,
  actor_discord_id VARCHAR(20) CHARACTER SET ascii NOT NULL,
  actor_pilot_id BIGINT UNSIGNED NOT NULL,
  before_snapshot JSON NULL,
  after_snapshot JSON NOT NULL,
  intent_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_training_resource_audit_category FOREIGN KEY (category_id)
    REFERENCES vuscg_training_resource_categories (category_id),
  CONSTRAINT fk_training_resource_audit_resource FOREIGN KEY (resource_id)
    REFERENCES vuscg_training_resources (resource_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS vuscg_training_instruction_events (
  event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  interaction_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  event_seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
  activation_key VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NULL UNIQUE,
  kind ENUM('start','resume','pause','instruction','materials','stage0','unchanged') NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  public_pilot_id BIGINT UNSIGNED NOT NULL,
  guild_id VARCHAR(20) CHARACTER SET ascii NOT NULL,
  trainee_discord_id VARCHAR(20) CHARACTER SET ascii NULL,
  actor_discord_id VARCHAR(20) CHARACTER SET ascii NOT NULL,
  actor_pilot_id BIGINT UNSIGNED NOT NULL,
  program_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  category_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  label VARCHAR(80) NOT NULL,
  note VARCHAR(400) NOT NULL,
  resources JSON NOT NULL,
  intent_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6) NOT NULL,
  KEY ix_training_instruction_current (user_id, program_id, kind, event_seq),
  CONSTRAINT fk_training_instruction_enrollment FOREIGN KEY (user_id, program_id)
    REFERENCES vuscg_training_enrollments (user_id, program_id),
  CONSTRAINT fk_training_instruction_category FOREIGN KEY (category_id)
    REFERENCES vuscg_training_resource_categories (category_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS vuscg_training_instruction_delivery (
  event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target ENUM('discord','trainee_rating') NOT NULL,
  state ENUM('pending','retry','sending','uncertain','complete','superseded') NOT NULL DEFAULT 'pending',
  next_attempt_at DATETIME(6) NOT NULL,
  channel_id VARCHAR(20) CHARACTER SET ascii NULL,
  message_id VARCHAR(20) CHARACTER SET ascii NULL,
  result VARCHAR(80) CHARACTER SET ascii NULL,
  PRIMARY KEY (event_id, target),
  KEY ix_training_instruction_work (target, state, next_attempt_at),
  CONSTRAINT fk_training_instruction_delivery_event FOREIGN KEY (event_id)
    REFERENCES vuscg_training_instruction_events (event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS vuscg_training_instruction_attempts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target ENUM('discord','trainee_rating') NOT NULL,
  result VARCHAR(80) CHARACTER SET ascii NOT NULL,
  native_id BIGINT UNSIGNED NULL,
  actor_discord_id VARCHAR(20) CHARACTER SET ascii NULL,
  actor_pilot_id BIGINT UNSIGNED NULL,
  created_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_training_instruction_attempt FOREIGN KEY (event_id, target)
    REFERENCES vuscg_training_instruction_delivery (event_id, target)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO vuscg_training_resource_categories (category_id, name) VALUES
  ('stage0','Stage Zero'), ('fw','Fixed Wing'), ('rw','Rotary Wing'), ('mq9','MQ9'),
  ('hitron','HITRON'), ('blackjack','BLACKJACK'), ('dlq','DLQ'), ('ip','Instructor Pilot')
ON DUPLICATE KEY UPDATE category_id = vuscg_training_resource_categories.category_id;
