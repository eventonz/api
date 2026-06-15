-- Follow a RaceResult participant from the app's start-list detail and get a
-- single "X has finished" push (docs: rr-follow finish notifications).
-- Keyed on athlete_id (= RaceResult [ID] = the app's pid) — exactly what the
-- Evento finish-notification exporter pushes, and stable across bib changes.
CREATE TABLE IF NOT EXISTS rr_follows (
  id          BIGSERIAL PRIMARY KEY,
  rr_eventid  INTEGER     NOT NULL,
  athlete_id  TEXT        NOT NULL,   -- = pid (RR participant ID); match key
  player_id   TEXT        NOT NULL,   -- OneSignal subscription id
  bib         TEXT,
  name        TEXT,
  notified    BOOLEAN     NOT NULL DEFAULT false,  -- finish push sent? guards re-sends
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rr_eventid, athlete_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_rr_follows_lookup ON rr_follows (rr_eventid, athlete_id);
