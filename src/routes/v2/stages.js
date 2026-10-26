/**
 * Stage races — team stage times, GC and next-day start chutes.
 *
 *   POST /v2/stages/:event_id        (public group; server key or evt_ token)
 *       body { format:'evento'|'raceresult_list'|'starts', results?|starts?, race_id? }
 *       → LPUSH ingest_queue {race_id, datetime, endpoint:'v2/stages', payload}, 202
 *       The evento-worker converts and writes v2.stage_results / v2.stage_starts
 *       plus redis_stages:{race_id}:bib:{bib}.
 *
 *   GET  /v2/stages/:event_id?bib=   (authed group)
 *       Redis key per race of the event, first hit wins; on a miss build from
 *       Postgres via services/stages.js, write the key back. 404 when the bib
 *       has no rows anywhere.
 *
 * Same pipeline shape as /v2/tracks + /v2/splits: eventoapi queues and reads,
 * the worker writes Postgres (truth) and the Redis read key.
 */
const pool  = require('../../config/database');
const redis = require('../../config/redis');
const authHook = require('../../plugins/auth');
const timerAuthHook = require('../../plugins/timer-auth');
const { STAGES_TTL_SECS, stagesKey, normaliseBib, buildStagesDoc, validateStagesBody } = require('../../services/stages');

const QUEUE_KEY = 'ingest_queue';

async function racesForEvent(eventId) {
  const { rows } = await pool.query('SELECT id FROM v2.races WHERE event_id = $1 ORDER BY id', [eventId]);
  return rows.map((r) => Number(r.id));
}

/**
 * Ingest auth: a server API key (api_keys.kind='server', via plugins/auth) or
 * an evt_ timer token (plugins/timer-auth). Both hooks reply 401 themselves on
 * a bad credential; an app key or install token is refused here.
 */
async function ingestAuth(request, reply) {
  const bearer = String(request.headers['authorization'] || '');
  if (/^Bearer\s+evt_/i.test(bearer)) return timerAuthHook(request, reply);
  await authHook(request, reply);
  if (reply.sent) return;
  if (request.auth?.type !== 'key' || request.auth.kind !== 'server') {
    return reply.code(403).send({ status: 'error', message: 'A server API key or evt_ timer token is required.' });
  }
}

async function readStagesFromDb(raceIds, bib) {
  const [results, starts] = await Promise.all([
    pool.query(
      `SELECT race_id, stage_no, stage_name, stage_time, stage_rank, gc_time, gc_rank, cat_rank, gc_gap, updated_at
         FROM v2.stage_results WHERE race_id = ANY($1::bigint[]) AND raceno = $2 ORDER BY stage_no`,
      [raceIds, bib]),
    pool.query(
      `SELECT race_id, stage_no, stage_name, start_date, start_time, chute, updated_at
         FROM v2.stage_starts WHERE race_id = ANY($1::bigint[]) AND raceno = $2 ORDER BY stage_no`,
      [raceIds, bib]),
  ]);
  return { results: results.rows, starts: starts.rows };
}

/** Public ingest — registered in the public group next to rr_webhook. */
async function stagesIngestRoutes(app) {
  app.post('/:event_id', {
    preHandler: ingestAuth,
    schema: { params: { type: 'object', properties: { event_id: { type: 'string' } }, required: ['event_id'] } },
  }, async (request, reply) => {
    const v = validateStagesBody(request.body);
    if (!v.ok) return reply.code(400).send({ status: 'error', message: v.error });
    const { event_id } = request.params;
    const races = await racesForEvent(event_id);
    if (!races.length) return reply.code(404).send({ status: 'error', message: `No v2 event ${event_id}.` });
    let raceId = races[0];
    if (v.body.race_id) {
      if (!races.includes(v.body.race_id)) return reply.code(404).send({ status: 'error', message: `Race ${v.body.race_id} is not part of ${event_id}.` });
      raceId = v.body.race_id;
    }
    const { race_id: _omit, ...payload } = v.body;
    await redis.lpush(QUEUE_KEY, JSON.stringify({
      race_id: raceId,
      datetime: new Date().toISOString(),
      endpoint: 'v2/stages',
      payload,
    }));
    return reply.code(202).send({ status: 'queued', race_id: raceId });
  });
}

/** Authed read — registered in the authed group. */
async function stagesReadRoutes(app) {
  app.get('/:event_id', {
    schema: {
      params: { type: 'object', properties: { event_id: { type: 'string' } }, required: ['event_id'] },
      querystring: { type: 'object', properties: { bib: { type: 'string' } }, required: ['bib'] },
    },
  }, async (request, reply) => {
    const { event_id } = request.params;
    const bib = normaliseBib(request.query.bib);
    if (!bib) return reply.code(400).send({ error: 'bib is required' });
    const races = await racesForEvent(event_id);
    if (!races.length) return reply.code(404).send({ error: 'Event not found' });

    // Redis first — the worker keeps the key current; first race with a hit wins.
    const keys = races.map((id) => stagesKey(id, bib));
    const cached = await redis.mget(keys).catch(() => []);
    for (let i = 0; i < races.length; i++) {
      if (!cached[i]) continue;
      try { return reply.header('X-Cache', 'HIT').send({ race_id: races[i], bib, ...JSON.parse(cached[i]) }); } catch { /* rebuild */ }
    }

    const { results, starts } = await readStagesFromDb(races, bib);
    if (!results.length && !starts.length) return reply.code(404).send({ error: 'No stage data for this bib' });
    const raceId = Number((results[0] || starts[0]).race_id);
    const doc = buildStagesDoc(results.filter((r) => Number(r.race_id) === raceId), starts.filter((s) => Number(s.race_id) === raceId));
    redis.set(stagesKey(raceId, bib), JSON.stringify(doc), 'EX', STAGES_TTL_SECS).catch(() => {});
    return reply.header('X-Cache', 'MISS').send({ race_id: raceId, bib, ...doc });
  });
}

module.exports = stagesReadRoutes;
module.exports.ingest = stagesIngestRoutes;
module.exports.ingestAuth = ingestAuth;
