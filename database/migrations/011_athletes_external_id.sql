-- 011: organiser-supplied identifier on startlist rows (registration / entry id
-- from a spreadsheet upload). Distinct from athlete_id (the timing platform's id).
ALTER TABLE v2.athletes ADD COLUMN IF NOT EXISTS external_id text;
CREATE INDEX IF NOT EXISTS athletes_race_external_id_idx ON v2.athletes (race_id, external_id) WHERE external_id IS NOT NULL;
