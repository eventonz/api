-- RaceResult feed provisioning + live state for V2 races.
--
-- Replaces two manual steps on the old path: a human pasting a Simple API URL
-- into the CMS (races.rr_splits), and a human pressing GO LIVE / END.
--
-- The feed URL and its key are now created by us in the timer's RaceResult
-- event file (see services/raceresult/provision.js), and the live window is
-- derived from RaceResult's own EventOver flag plus contest start times, so
-- there is nothing for a timer to remember on race morning.

ALTER TABLE v2.races
  -- Provisioned Simple API feed: https://api.raceresult.com/{rr_raceid}/{key}
  ADD COLUMN IF NOT EXISTS rr_splits_url    TEXT,
  ADD COLUMN IF NOT EXISTS rr_simpleapi_key TEXT,
  -- Name of the list we wrote into the event file, so provisioning is
  -- idempotent (match by name, same as the exporter/webhook flows).
  ADD COLUMN IF NOT EXISTS rr_list_name     TEXT,
  -- Fingerprint of the event's split configuration. When this changes (a timer
  -- adds a checkpoint on race morning) the list is regenerated before the live
  -- window opens.
  ADD COLUMN IF NOT EXISTS rr_splits_hash   TEXT,
  ADD COLUMN IF NOT EXISTS provisioned_at   TIMESTAMPTZ,

  -- Live serving. v2RaceConfig currently hardcodes use_redis=false and derives
  -- islive from races.status, which never holds 'live' — both come from here.
  ADD COLUMN IF NOT EXISTS use_redis        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS live_state       TEXT    NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS live_from        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS live_until       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_pull_at     TIMESTAMPTZ,
  -- Last time a pull actually saw new records; drives the no-data backstop.
  ADD COLUMN IF NOT EXISTS last_data_at     TIMESTAMPTZ;

-- live_state: idle → armed → live → finalising → done (or 'error').
ALTER TABLE v2.races
  DROP CONSTRAINT IF EXISTS races_live_state_check;
ALTER TABLE v2.races
  ADD CONSTRAINT races_live_state_check
  CHECK (live_state IN ('idle', 'armed', 'live', 'finalising', 'done', 'error'));

-- The scheduler's hot query: RR-linked races that are live or due to be.
CREATE INDEX IF NOT EXISTS idx_v2_races_live_window
  ON v2.races (live_state, live_from)
  WHERE rr_raceid IS NOT NULL;
