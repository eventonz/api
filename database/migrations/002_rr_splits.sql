-- Per-athlete-per-split row, system of record post-event.
-- Redis is the live store during the reception window; this table is the
-- archive that lives forever and accepts timer corrections after the event.

CREATE TABLE IF NOT EXISTS rr_splits (
  race_id      INTEGER     NOT NULL,
  athlete_id   TEXT        NOT NULL,
  split_id     TEXT        NOT NULL,
  rr_splitid   TEXT,
  bib          TEXT,
  split_name   TEXT,
  tod          TIMESTAMPTZ,
  race_time    TEXT,
  gun_time     TEXT,
  chip_time    TEXT,
  split_speed  NUMERIC,
  message_en   TEXT,
  raw          JSONB,
  source       TEXT,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (race_id, athlete_id, split_id)
);

CREATE INDEX IF NOT EXISTS idx_rr_splits_race        ON rr_splits (race_id);
CREATE INDEX IF NOT EXISTS idx_rr_splits_race_athlete ON rr_splits (race_id, athlete_id);

ALTER TABLE races
  ADD COLUMN IF NOT EXISTS splits_archived    BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS splits_archived_at TIMESTAMPTZ;
