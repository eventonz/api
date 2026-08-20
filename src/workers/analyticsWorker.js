/**
 * Analytics worker — drains the Redis list `analytics_queue` into the
 * partitioned analytics_events table, and maintains the analytics_daily
 * rollup (migration 005). Run as a separate PM2 app (single instance —
 * see ecosystem.config.js).
 *
 * Flush:   every 5s, LPOP up to 1000 rows, ensure the monthly partitions the
 *          batch touches exist, one multi-row INSERT.
 * Rollup:  on boot and every 15 min, rebuild today + yesterday (UTC) in
 *          analytics_daily — idempotent upsert, so re-runs are safe.
 */

require('dotenv').config();
const Redis = require('ioredis');
const pool = require('../config/database');

const QUEUE_KEY = 'analytics_queue';
const FLUSH_MS = 5_000;
const ROLLUP_MS = 15 * 60_000;
const BATCH = 1000;

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT),
  password: process.env.REDIS_PASSWORD,
  tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
});
redis.on('connect', () => console.log('[analytics] redis connected'));
redis.on('error', (err) => console.error('[analytics] redis error:', err.message));

let shuttingDown = false;
const knownPartitions = new Set();

async function ensurePartition(isoTs) {
  const month = isoTs.slice(0, 7); // YYYY-MM
  if (knownPartitions.has(month)) return;
  await pool.query('SELECT ensure_analytics_partition($1::date)', [`${month}-01`]);
  knownPartitions.add(month);
}

async function flushOnce() {
  const raw = await redis.lpop(QUEUE_KEY, BATCH);
  if (!raw || raw.length === 0) return 0;

  const rows = [];
  for (const item of raw) {
    try { rows.push(JSON.parse(item)); } catch { /* skip malformed */ }
  }
  if (!rows.length) return 0;

  for (const month of new Set(rows.map((r) => r.ts.slice(0, 7)))) {
    await ensurePartition(`${month}-15`);
  }

  const cols = ['ts', 'device_id', 'app_id', 'event_id', 'name', 'key', 'props', 'platform', 'app_version', 'os_version'];
  const values = [];
  const params = [];
  rows.forEach((r, i) => {
    values.push(`(${cols.map((_, j) => `$${i * cols.length + j + 1}`).join(',')})`);
    params.push(r.ts, r.device_id, r.app_id, r.event_id, r.name, r.key,
                JSON.stringify(r.props ?? {}), r.platform, r.app_version, r.os_version);
  });

  try {
    await pool.query(
      `INSERT INTO analytics_events (${cols.map((c) => `"${c}"`).join(',')}) VALUES ${values.join(',')}`,
      params
    );
  } catch (err) {
    // Put the batch back so nothing is lost; next tick retries.
    console.error('[analytics] insert failed, requeueing batch:', err.message);
    await redis.rpush(QUEUE_KEY, ...raw);
    throw err;
  }
  return rows.length;
}

async function flushLoop() {
  while (!shuttingDown) {
    try {
      const n = await flushOnce();
      if (n >= BATCH) continue; // queue is deep — drain without sleeping
    } catch { /* logged above; back off via the sleep below */ }
    await new Promise((r) => setTimeout(r, FLUSH_MS));
  }
}

async function rollupDay(day) {
  await pool.query(
    `INSERT INTO analytics_daily (day, app_id, event_id, name, key, count, devices)
     SELECT ts::date, app_id, COALESCE(event_id, ''), name, COALESCE(key, ''),
            COUNT(*), COUNT(DISTINCT device_id)
     FROM analytics_events
     WHERE ts >= $1::date AND ts < $1::date + interval '1 day'
     GROUP BY 1, 2, 3, 4, 5
     ON CONFLICT (day, app_id, event_id, name, key)
     DO UPDATE SET count = EXCLUDED.count, devices = EXCLUDED.devices`,
    [day]
  );
}

async function rollup() {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  try {
    await rollupDay(yesterday);
    await rollupDay(today);
    console.log(`[analytics] rollup done for ${yesterday} + ${today}`);
  } catch (err) {
    console.error('[analytics] rollup failed:', err.message);
  }
}

async function main() {
  await rollup();
  setInterval(rollup, ROLLUP_MS);
  await flushLoop();
}

process.on('SIGINT', () => { shuttingDown = true; });
process.on('SIGTERM', () => { shuttingDown = true; });

main().catch((err) => {
  console.error('[analytics] fatal:', err);
  process.exit(1);
});
