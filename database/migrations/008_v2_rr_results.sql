-- v2.rr_results — the single flat results table for V2 events.
--
-- Replaces the per-timer tables of the v1 world (solemotive, timit, chrono,
-- …, all identical schemas selected via races.results_table). One table,
-- keyed by the v2 race id; the timer identity lives on the race row.
--
-- Written by finalise (last full pull at stop-live) and by the live push
-- upsert; read by the splits transformer as the post-live source once the
-- redis_splits cache has expired. Columns mirror the v1 results tables so
-- the existing upsert/read code ports unchanged.

CREATE TABLE IF NOT EXISTS v2.rr_results (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  race_id integer NOT NULL,          -- v2.races.id
  race_no integer,
  split_id integer,
  rr_splitid integer,
  athlete_id varchar(20),
  split_tod varchar(20),
  split_gun varchar(20),
  split_chip varchar(20),
  overall_rank varchar(20),
  gender_rank varchar(20),
  agegroup_rank varchar(20),
  splitpace varchar(20),
  splitpredictedtod varchar(20),
  splitpredictedracetime varchar(20),
  splitspeed varchar(20),
  updated timestamp NOT NULL DEFAULT now(),
  -- athlete_id is the identity; race_no (bib) is just an attribute. Bibs can
  -- be reassigned or corrected mid-event — keying on them (as the v1 tables
  -- did) duplicates rows on a bib change instead of updating them.
  CONSTRAINT rr_results_unique_race_athlete_split
    UNIQUE (race_id, athlete_id, split_id)
);

-- The transformer's read: one athlete's rows for one race.
CREATE INDEX IF NOT EXISTS idx_v2_rr_results_race_athlete
  ON v2.rr_results (race_id, athlete_id);
