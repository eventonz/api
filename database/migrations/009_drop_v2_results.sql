-- 009: drop the unused v2.results table (applied 6 Sep 2026).
-- v2.rr_results (migration 008) is the single results table for every
-- RaceResult race; v2.results was an earlier per-athlete design that nothing
-- ever wrote to, and the v2 splits endpoint mistakenly read it for finished races.
DROP TABLE IF EXISTS v2.results;
