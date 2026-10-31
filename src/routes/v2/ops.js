/**
 * GET /v2/ops/health — what the CMS Health page shows: races currently
 * armed/live/finalising/error with how long, open alerts (worker-raised,
 * Redis ops:alerts), and worker heartbeats. Server keys only.
 */
const pool  = require('../../config/database');
const redis = require('../../config/redis');
const { raceLog } = require('../../services/raceLog');
const os = require('os');
const { summarisePushes, summariseLog } = require('../../services/opsLive');

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
   * GET /v2/ops/live?race=&mins=&samples= — the CMS Live dashboard. For each
   * race that is armed/live/finalising/error (or the one asked for): the last
   * `mins` of timer pushes folded by format / split id, the latest pulls,
   * startlist refresh, errors, failed jobs, athlete + result counts, and the
   * worker's per-minute samples (ops:live:samples:{race}, newest first) for
   * the graphs. Plus queues, worker heartbeats, system samples and this box's
   * load. Server keys only.
   */
  app.get('/live', async (request, reply) => {
    if (request.auth?.kind !== 'server') return reply.code(403).send({ error: 'Server API key required' });
    const mins = Math.min(240, Math.max(1, Number(request.query.mins) || 15));
    const nSamples = Math.min(1440, Math.max(10, Number(request.query.samples) || 180));
    const raceId = Number(request.query.race) || null;
    const since = Date.now() - mins * 60000;

    const { rows: raceRows } = await pool.query(
      raceId
        ? `SELECT id, name, event_id, rr_raceid, racetec_apikey, timer_platform, live_state, status, live_from, live_until, last_pull_at, last_data_at FROM v2.races WHERE id = $1`
        : `SELECT id, name, event_id, rr_raceid, racetec_apikey, timer_platform, live_state, status, live_from, live_until, last_pull_at, last_data_at FROM v2.races WHERE live_state IN ('armed','live','finalising','error') ORDER BY live_from`,
      raceId ? [raceId] : []
    );

    const races = [];
    for (const r of raceRows) {
      const pushKey = r.timer_platform === 'racetec' ? `racetec:pushes:${r.racetec_apikey}` : `raceresult:pushes:${r.rr_raceid}`;
      const [pushRaw, logRaw, samplesRaw, athletes, results, ignoredKeys] = await Promise.all([
        redis.lrange(pushKey, 0, 999),
        redis.lrange(`race:log:${r.id}`, 0, 4999),
        redis.lrange(`ops:live:samples:${r.id}`, 0, nSamples - 1),
        pool.query('SELECT count(*)::int AS n, max(updated_at) AS at FROM v2.athletes WHERE race_id = $1', [r.id]),
        pool.query(`SELECT count(*)::int AS n, (max(updated) AT TIME ZONE 'UTC') AS at FROM v2.rr_results WHERE race_id = $1`, [r.id]),
        redis.keys(`ops:pushes_ignored:${r.id}:*`),
      ]);
      const log = logRaw.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      let ignored = 0;
      if (ignoredKeys.length) for (const v of await redis.mget(...ignoredKeys)) ignored += Number(v) || 0;
      const failed = {};
      for (const k of ['process', 'webhook', 'push']) failed[k] = await redis.llen(`failed:${k}:${r.id}`);
      races.push({
        ...r, racetec_apikey: undefined,
        athletes: athletes.rows[0], results: results.rows[0],
        pushes: summarisePushes(pushRaw, since),
        log: summariseLog(log),
        ignored, failed,
        samples: samplesRaw.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse(),
      });
    }

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
    const systemRaw = await redis.lrange('ops:live:samples:system', 0, nSamples - 1);
    // Picker: everything live now plus anything that was live in the last week.
    const { rows: recent } = await pool.query(
      `SELECT id, name, event_id, live_state, live_from, live_until FROM v2.races
        WHERE live_state IN ('armed','live','finalising','error') OR live_from > NOW() - INTERVAL '7 days'
        ORDER BY (live_state IN ('armed','live','finalising','error')) DESC, live_from DESC NULLS LAST LIMIT 30`
    );
    return reply.send({
      at: new Date().toISOString(), mins,
      races, recent,
      queues: { ingest_queue: await redis.llen('ingest_queue'), notify_queue: await redis.llen('notify_queue') },
      workers,
      stats: { ingest_processed: Number(await redis.get('worker:stats:ingest_queue:processed')) || 0, notify_processed: Number(await redis.get('worker:stats:notify_queue:processed')) || 0 },
      api: { load1: Number(os.loadavg()[0].toFixed(2)), mem_used_mb: Math.round((os.totalmem() - os.freemem()) / 1048576), mem_total_mb: Math.round(os.totalmem() / 1048576) },
      system_samples: systemRaw.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse(),
    });
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
