-- Staging only. Apply once to the verified InnoDB PIREP schema before the PHP patch.
ALTER TABLE pireps
  ADD COLUMN vuscg_review_revision CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN vuscg_filing_pending TINYINT UNSIGNED NOT NULL DEFAULT 0;
