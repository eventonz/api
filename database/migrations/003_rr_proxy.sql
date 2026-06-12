-- RR Proxy (docs/rr_proxy_implementation_plan.md)
-- 1. Per-event feature flag: app uses the Evento proxy for RRPublish calls
--    when true, direct my.raceresult.com otherwise. Default off — flipping
--    this row is the rollout/rollback switch (no app release needed).
ALTER TABLE races ADD COLUMN IF NOT EXISTS rr_proxy BOOLEAN NOT NULL DEFAULT false;

-- 2. CMS display overrides applied by the proxy when merging RR config
--    responses (Workstream 2). One row per race; overrides JSON is versioned
--    ({"v":1,"lists":{...}}) and fail-soft: keys that no longer match the
--    live RR config are ignored.
CREATE TABLE IF NOT EXISTS rr_display_config (
  race_id     INT PRIMARY KEY REFERENCES races(id),
  overrides   JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMP DEFAULT now(),
  updated_by  VARCHAR(100)
);
