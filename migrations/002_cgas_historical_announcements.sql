-- Adds a durable, per-tour marker for the optional one-time historical campaign.
-- Safe to run after migrations/001_cgas_tour.sql.
ALTER TABLE bot_cgas_tour_versions
  ADD COLUMN historical_announcement_queued_at DATETIME NULL,
  ADD COLUMN historical_announcement_count INT UNSIGNED NULL;
