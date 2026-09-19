/**
 * GET /v2/ops/health — what the CMS Health page shows: races currently
 * armed/live/finalising/error with how long, open alerts (worker-raised,
 * Redis ops:alerts), and worker heartbeats. Server keys only.
 */
const pool  = require('../../config/database');
const redis = require('../../config/redis');
const { raceLog } = require('../../services/raceLog');

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
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'worker:alive:*', 'COUNT', 5000);
      cursor = next;
      if (keys.length) {
        const vals = await redis.mget(...keys);
        keys.forEach((k, i) => { try { workers.push({ id: k.slice('worker:alive:'.length), ...JSON.parse(vals[i]) }); } catch { /* skip */ } });
      }
    } while (cursor !== '0');
    const queues = { ingest_queue: await redis.llen('ingest_queue'), notify_queue: await redis.llen('notify_queue') };
    return reply.send({ at: new Date().toISOString(), races, alerts, workers, queues });
  });

  /**
   * POST /v2/ops/reset-race/:race_id — wipe a race's timing data so a test
   * or rehearsal can be rerun: v2.rr_results rows, the live cache
   * (redis_splits / tracking / push dedupe keys) and the last-data marks.
   * Refused while the race is armed, live or finalising — the next pull
   * would just refill everything. Server keys only. Startlist, splits and
   * config are untouched.
   */
  app.post('/reset-race/:race_id', {
    schema: { params: { type: 'object', properties: { race_id: { type: 'integer' } }, required: ['race_id'] } },
  }, async (request, reply) => {
    if (request.auth?.kind !== 'server') return reply.code(403).send({ error: 'Server API key required' });
    const raceId = request.params.race_id;
    const { rows } = await pool.query('SELECT id, name, live_state FROM v2.races WHERE id = $1', [raceId]);
    if (!rows.length) return reply.code(404).send({ error: 'race not found' });
    if (['armed', 'live', 'finalising'].includes(rows[0].live_state)) {
      return reply.code(409).send({ error: `race is ${rows[0].live_state} — stop live first` });
    }

    const { rowCount: results } = await pool.query('DELETE FROM v2.rr_results WHERE race_id = $1', [raceId]);
    let keys = 0;
    for (const pattern of [`redis_splits:${raceId}:athlete:*`, `tracking:race:${raceId}:*`, `push:sent:${raceId}:*`]) {
      let cursor = '0';
      do {
        const [next, found] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 5000);
        cursor = next;
        if (found.length) { await redis.del(...found); keys += found.length; }
      } while (cursor !== '0');
    }
    keys += await redis.del(`v2:tracks:last_data:${raceId}`, `schedule:pullfails:${raceId}`);
    await pool.query('UPDATE v2.races SET last_data_at = NULL, last_pull_at = NULL, updated_at = NOW() WHERE id = $1', [raceId]);
    raceLog(raceId, 'list', `results cleared by CMS — ${results} result rows, ${keys} cache keys removed`);
    return reply.send({ ok: true, race_id: raceId, results_deleted: results, cache_keys_deleted: keys });
  });
}

module.exports = v2OpsRoutes;
