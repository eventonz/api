-- 013: results display overrides for my.raceresult events, keyed on the RR
-- event id (v2 CMS writes here; the proxy reads v2 first, then the frozen
-- public.rr_display_config by v1 race). Same jsonb shape as v1:
--   {"v":1,"lists":{"<RR list Name>":{"hidden":true|"show":true,"label":"…","line2":["CLUB"]}}}
CREATE TABLE IF NOT EXISTS v2.rr_display_config (
  rr_eventid  integer PRIMARY KEY,
  overrides   jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
