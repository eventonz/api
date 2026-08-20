-- 005_analytics.sql — first-party product analytics (20 Aug 2026).
--
-- Raw events land in analytics_events (monthly partitions; append-only log,
-- no PK on purpose). The app batches to POST /v1/analytics, the route buffers
-- into Redis, analyticsWorker flushes to PG and maintains partitions, and an
-- hourly rollup fills analytics_daily — dashboards read ONLY the rollup.
-- Block IMPRESSIONS are deliberately not collected (Todd, 20 Aug 2026): taps
-- only. Retention: drop old monthly partitions to reclaim space instantly.

CREATE TABLE IF NOT EXISTS analytics_events (
    ts          TIMESTAMPTZ NOT NULL,               -- client event time
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    device_id   TEXT NOT NULL,                      -- anonymous per-device UUID (Keychain)
    app_id      INTEGER NOT NULL,
    event_id    TEXT,                               -- CMS event, when inside one
    name        TEXT NOT NULL,                      -- install | app_open | event_open | page_view | block_tap | action | link_open
    key         TEXT,                               -- page slug / block type / action name / link host
    props       JSONB NOT NULL DEFAULT '{}'::jsonb,
    platform    TEXT,
    app_version TEXT,
    os_version  TEXT
) PARTITION BY RANGE (ts);

CREATE INDEX IF NOT EXISTS idx_analytics_events_app   ON analytics_events (app_id, ts);
CREATE INDEX IF NOT EXISTS idx_analytics_events_event ON analytics_events (event_id, ts) WHERE event_id IS NOT NULL;

-- Monthly partition helper — the worker calls this for every month it sees,
-- so future months need no migration.
CREATE OR REPLACE FUNCTION ensure_analytics_partition(p_month DATE) RETURNS void AS $$
DECLARE
    p_start DATE := date_trunc('month', p_month)::date;
    p_stop  DATE := (date_trunc('month', p_month) + interval '1 month')::date;
    p_name  TEXT := 'analytics_events_' || to_char(p_start, 'YYYYMM');
BEGIN
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF analytics_events FOR VALUES FROM (%L) TO (%L)',
        p_name, p_start, p_stop
    );
END $$ LANGUAGE plpgsql;

SELECT ensure_analytics_partition(now()::date);
SELECT ensure_analytics_partition((now() + interval '1 month')::date);

-- Daily rollup — one row per (day, app, event, event name, key). `devices` is
-- the day's unique device count for that slice; "unique visitors" for any
-- period sums are answered from here without touching the raw log.
CREATE TABLE IF NOT EXISTS analytics_daily (
    day      DATE NOT NULL,
    app_id   INTEGER NOT NULL,
    event_id TEXT NOT NULL DEFAULT '',
    name     TEXT NOT NULL,
    key      TEXT NOT NULL DEFAULT '',
    count    BIGINT NOT NULL DEFAULT 0,
    devices  BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (day, app_id, event_id, name, key)
);
CREATE INDEX IF NOT EXISTS idx_analytics_daily_event ON analytics_daily (event_id, day);
