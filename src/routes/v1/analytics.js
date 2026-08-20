/**
 * First-party product analytics ingest (migration 005).
 *
 * POST /v1/analytics
 *   Body: {
 *     app_id: 901,
 *     device: { id, platform, app_version, os_version },
 *     events: [ { name, ts, event_id?, key?, props? }, ... ]   // ≤ 500
 *   }
 *   The app batches (foreground flush / 30s while active); this route only
 *   validates and buffers into the Redis list `analytics_queue` — the PG write
 *   happens in analyticsWorker. Race-weekend load never touches Postgres from
 *   the request path. Falls back to a direct insert if Redis is down.
 *
 * GET /v1/analytics/summary?app_id=&event_id=&days=30
 *   Reads the analytics_daily rollup (plus nothing else — raw stays cold).
 *
 * Auth: standard bearer scope (the app already holds eventoApiToken).
 * Privacy: device ids are app-generated anonymous UUIDs; no PII arrives here.
 */

const pool  = require('../../config/database');
const redis = require('../../config/redis');

const QUEUE_KEY   = 'analytics_queue';
const MAX_EVENTS  = 500;
const NAME_RE     = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_QUEUE   = 500_000; // backstop against a runaway client

const EVENT_SCHEMA = {
  type: 'object',
  required: ['app_id', 'device', 'events'],
  properties: {
    app_id: { type: 'integer' },
    device: {
      type: 'object',
      required: ['id'],
      properties: {
        id:          { type: 'string', minLength: 8, maxLength: 64 },
        platform:    { type: 'string', maxLength: 10 },
        app_version: { type: 'string', maxLength: 20 },
        os_version:  { type: 'string', maxLength: 20 },
      },
    },
    events: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_EVENTS,
      items: {
        type: 'object',
        required: ['name', 'ts'],
        properties: {
          name:     { type: 'string', maxLength: 40 },
          ts:       { type: 'string', maxLength: 40 },  // ISO8601
          event_id: { type: 'string', maxLength: 100 },
          key:      { type: 'string', maxLength: 150 },
          props:    { type: 'object' },
        },
      },
    },
  },
};

function cleanRows(body) {
  const { app_id, device, events } = body;
  const rows = [];
  for (const e of events) {
    if (!NAME_RE.test(e.name)) continue;
    const ts = new Date(e.ts);
    if (Number.isNaN(ts.getTime())) continue;
    // Clamp clock skew: no future events, nothing older than 30 days.
    const now = Date.now();
    if (ts.getTime() > now + 5 * 60_000 || ts.getTime() < now - 30 * 86400_000) continue;
    let props = e.props ?? {};
    if (JSON.stringify(props).length > 1024) props = {};
    rows.push({
      ts: ts.toISOString(),
      device_id: device.id,
      app_id,
      event_id: e.event_id || null,
      name: e.name,
      key: e.key || null,
      props,
      platform: device.platform || null,
      app_version: device.app_version || null,
      os_version: device.os_version || null,
    });
  }
  return rows;
}

async function insertDirect(rows) {
  const cols = ['ts', 'device_id', 'app_id', 'event_id', 'name', 'key', 'props', 'platform', 'app_version', 'os_version'];
  const values = [];
  const params = [];
  rows.forEach((r, i) => {
    values.push(`(${cols.map((_, j) => `$${i * cols.length + j + 1}`).join(',')})`);
    params.push(r.ts, r.device_id, r.app_id, r.event_id, r.name, r.key, JSON.stringify(r.props), r.platform, r.app_version, r.os_version);
  });
  await pool.query(
    `INSERT INTO analytics_events (${cols.map((c) => `"${c}"`).join(',')}) VALUES ${values.join(',')}`,
    params
  );
}

async function analyticsRoutes(app) {
  app.post('/', { schema: { body: EVENT_SCHEMA } }, async (request, reply) => {
    const rows = cleanRows(request.body);
    if (!rows.length) return reply.code(202).send({ queued: 0 });

    try {
      const depth = await redis.llen(QUEUE_KEY);
      if (depth > MAX_QUEUE) return reply.code(202).send({ queued: 0, dropped: rows.length });
      await redis.rpush(QUEUE_KEY, ...rows.map((r) => JSON.stringify(r)));
    } catch {
      // Redis down — analytics must never 500 the app; write through.
      try { await insertDirect(rows); } catch { return reply.code(202).send({ queued: 0 }); }
    }
    return reply.code(202).send({ queued: rows.length });
  });

  app.get('/summary', async (request, reply) => {
    const appId = Number(request.query.app_id);
    const eventId = String(request.query.event_id || '');
    const days = Math.min(Math.max(Number(request.query.days) || 30, 1), 400);
    if (!Number.isFinite(appId)) return reply.code(400).send({ error: 'app_id required' });

    const params = [appId, `${days} days`];
    let where = 'app_id = $1 AND day > now()::date - $2::interval';
    if (eventId) { params.push(eventId); where += ` AND event_id = $${params.length}`; }

    const { rows } = await pool.query(
      `SELECT name, key, SUM(count)::bigint AS count, MAX(devices)::bigint AS peak_day_devices,
              SUM(devices)::bigint AS device_days
       FROM analytics_daily WHERE ${where}
       GROUP BY name, key ORDER BY count DESC LIMIT 200`,
      params
    );
    const { rows: byDay } = await pool.query(
      `SELECT day::text, SUM(count) FILTER (WHERE name = 'app_open')::bigint AS opens,
              MAX(devices) FILTER (WHERE name = 'app_open')::bigint AS devices
       FROM analytics_daily WHERE ${where}
       GROUP BY day ORDER BY day`,
      params
    );

    // Which events carry the app — rollup-only, app scope.
    const { rows: byEvent } = eventId
      ? { rows: [] }
      : await pool.query(
          `SELECT event_id,
                  SUM(count) FILTER (WHERE name = 'event_open')::bigint AS opens,
                  SUM(count) FILTER (WHERE name = 'page_view')::bigint  AS page_views,
                  MAX(devices)::bigint AS peak_day_devices
           FROM analytics_daily WHERE ${where} AND event_id <> ''
           GROUP BY event_id ORDER BY page_views DESC NULLS LAST LIMIT 50`,
          params
        );

    // True period uniques come from the raw log — daily uniques don't sum.
    // One indexed scan over the window; fine at current volume.
    const rawParams = [appId, `${days} days`];
    let rawWhere = 'app_id = $1 AND ts > now() - $2::interval';
    if (eventId) { rawParams.push(eventId); rawWhere += ` AND event_id = $${rawParams.length}`; }
    const { rows: uniq } = await pool.query(
      `SELECT COUNT(DISTINCT device_id)::bigint AS devices FROM analytics_events WHERE ${rawWhere}`,
      rawParams
    );

    // Sessions are derived, not tracked: a device's burst of events with no
    // 30-minute gap is one session (the industry-standard rule).
    const { rows: sess } = await pool.query(
      `SELECT COUNT(*)::bigint AS sessions FROM (
         SELECT ts - LAG(ts) OVER (PARTITION BY device_id ORDER BY ts) AS gap
         FROM analytics_events WHERE ${rawWhere}
       ) g WHERE gap IS NULL OR gap > interval '30 minutes'`,
      rawParams
    );

    return {
      app_id: appId, event_id: eventId || null, days,
      unique_devices: Number(uniq[0]?.devices ?? 0),
      sessions: Number(sess[0]?.sessions ?? 0),
      totals: rows, by_day: byDay, by_event: byEvent,
    };
  });
}

module.exports = analyticsRoutes;
