-- Run once against the phpVMS database before enabling the checker.
CREATE TABLE IF NOT EXISTS bot_cgas_tour_versions (
  version VARCHAR(64) NOT NULL PRIMARY KEY,
  requirement_hash CHAR(64) NOT NULL,
  roster_json JSON NOT NULL,
  baseline_status ENUM('initializing','complete') NOT NULL DEFAULT 'initializing',
  baseline_completed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS bot_cgas_completions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  tour_version VARCHAR(64) NOT NULL,
  completed_at DATETIME NOT NULL,
  final_station_id VARCHAR(128) NOT NULL,
  final_station_name VARCHAR(255) NOT NULL,
  final_pirep_id VARCHAR(191) NULL,
  detected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  baselined TINYINT(1) NOT NULL DEFAULT 0,
  announcement_status ENUM('none','pending','sending','sent','uncertain') NOT NULL,
  announcement_attempts INT UNSIGNED NOT NULL DEFAULT 0,
  announcement_next_attempt_at DATETIME NULL,
  announcement_token CHAR(64) NOT NULL,
  announcement_channel_id VARCHAR(32) NULL,
  announcement_message_id VARCHAR(32) NULL,
  announcement_last_error TEXT NULL,
  role_status ENUM('disabled','pending','awarded','not_linked','failed') NOT NULL DEFAULT 'disabled',
  role_attempts INT UNSIGNED NOT NULL DEFAULT 0,
  role_next_attempt_at DATETIME NULL,
  role_last_error TEXT NULL,
  UNIQUE KEY uq_bot_cgas_pilot_version (user_id, tour_version),
  UNIQUE KEY uq_bot_cgas_announcement_token (announcement_token),
  KEY ix_bot_cgas_announcement_work (announcement_status, announcement_next_attempt_at),
  KEY ix_bot_cgas_role_work (role_status, role_next_attempt_at)
) ENGINE=InnoDB;
