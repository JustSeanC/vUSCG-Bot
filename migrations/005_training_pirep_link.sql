-- Run once after 004. MySQL 8.4. Existing manual and import rows retain their source.
ALTER TABLE vuscg_training_records
  DROP CHECK chk_training_instructor_source,
  MODIFY source ENUM('manual', 'import', 'pirep') NOT NULL,
  ADD COLUMN active_pirep_evaluation TINYINT GENERATED ALWAYS AS (
    CASE WHEN source = 'pirep' AND voided_at IS NULL THEN 1 ELSE NULL END
  ) STORED,
  ADD UNIQUE KEY uq_training_pirep_evaluation
    (user_id, program_id, lesson_id, pirep_id, outcome, active_pirep_evaluation),
  ADD CONSTRAINT chk_training_instructor_source CHECK (
    (source = 'manual' AND instructor_discord_id IS NOT NULL)
    OR (source = 'import' AND instructor_discord_id IS NULL)
    OR (source = 'pirep' AND instructor_discord_id IS NOT NULL AND pirep_id IS NOT NULL)
  );
