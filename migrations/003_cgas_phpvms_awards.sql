-- Run once before configuring CGAS_TOUR_AWARD_ID.
-- Existing completions are pending so the website award also reflects tour
-- achievements detected before this integration was installed.
ALTER TABLE bot_cgas_completions
  ADD COLUMN award_status ENUM('disabled','pending','awarded','failed') NOT NULL DEFAULT 'pending' AFTER role_last_error,
  ADD COLUMN award_attempts INT UNSIGNED NOT NULL DEFAULT 0 AFTER award_status,
  ADD COLUMN award_next_attempt_at DATETIME NULL AFTER award_attempts,
  ADD COLUMN award_last_error TEXT NULL AFTER award_next_attempt_at,
  ADD KEY ix_bot_cgas_award_work (award_status, award_next_attempt_at);
