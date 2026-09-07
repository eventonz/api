/**
 * GET /v2/ops/health — what the CMS Health page shows: races currently
 * armed/live/finalising/error with how long, open alerts (worker-raised,
 * Redis ops:alerts), and worker heartbeats. Server keys only.
 */
const pool  = require('../../config/database');
const redis = require('../../config/redis');

async function v2OpsRoutes(app) {
  app.get('/health', async (request, reply) => {
    if (request.auth?.kind !== 'server') return reply.code(403).send({ error: 'Server API key required' });
    const [{ rows: races }, alertsRaw] = await Promise.all([
      pool.query(
        `SELECT r.id, r.name, r.event_id, r.rr_raceid, r.live_state, r.live_from, r.live_until, r.last_pull_at, r.last_data_at,
                r.event_date, EXTRACT(EPOCH FROM (NOW() - r.live_from))/3600 AS live_hours
           FROM v2.races r WHERE r.live_state IN ('armed','live','finalising','error') ORDER BY r.live_from`
      ),
      redis.lrange('ops:alerts', 0, 99),
    ]);
    const alerts = alertsRaw.map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
    const workers = [];
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'worker:alive:*', 'COUNT', 100);
      cursor = next;
      if (keys.length) {
        const vals = await redis.mget(...keys);
        keys.forEach((k, i) => { try { workers.push({ id: k.slice('worker:alive:'.length), ...JSON.parse(vals[i]) }); } catch { /* skip */ } });
      }
    } while (cursor !== '0');
    const queues = { ingest_queue: await redis.llen('ingest_queue'), notify_queue: await redis.llen('notify_queue') };
    return reply.send({ at: new Date().toISOString(), races, alerts, workers, queues });
  });
}

module.exports = v2OpsRoutes;
