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
const sportsplits = require('../../services/sportsplits');
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

/** GC rows from Sportsplits → the stages doc, or null (not a Sportsplits race / no GC result / Sportsplits down). */
async function sportsplitsStages(raceId, bib, log) {
  const race = await sportsplits.sportsplitsRace(raceId);
  if (!race) return null;
  const team = await sportsplits.findTeam(raceId, '', bib);
  if (!team) return null;
  const { gc, live } = sportsplits.stagesFor(race, team.contest);
  let gcTeam = null;
  try { gcTeam = await sportsplits.fetchGcResult(race, gc, team.raceno); } catch (err) {
    log?.warn({ err, raceId, bib }, 'sportsplits GC fetch failed');
  }
  const rows = sportsplits.gcStageRows(gcTeam, raceId, team.raceno);
  // Start sheet: Sportsplits waves (batch + gun time per stage list), with any
  // hand-entered v2.stage_starts row overriding its stage.
  const { starts: manual } = await readStagesFromDb([raceId], team.raceno).catch(() => ({ starts: [] }));
  const manualNos = new Set(manual.map((s) => Number(s.stage_no)));
  const waves = await sportsplits.stageStartRows(race, raceId, team.raceno);
  const starts = [...manual, ...waves.filter((w) => !manualNos.has(Number(w.stage_no)))];
  if (!rows.length && !starts.length) return null;
  const doc = buildStagesDoc(rows, starts);
  // A team Sportsplits marks is_active=false (one rider withdrew, the other
  // rides on as an Individual Finisher) is no longer a team: no stages table
  // at all (the apps hide it when `stages` is empty), only its next start.
  if (gcTeam?.is_active === false) doc.stages = [];
  // Today's start = the stage set live in the CMS (its Sportsplits event id),
  // whether or not the team already has a time for it; otherwise the first
  // stage without a result (buildStagesDoc), e.g. tomorrow once its list is out.
  // Its date is today's in the race's time zone: Sportsplits stamps every stage
  // with the race's first day, so the CMS live-stage choice is the only date we trust.
  const today = waves.find((w) => w.event_id === live);
  if (today) {
    const date = sportsplits.todayIn(race.time_zone) || today.start_date;
    doc.next_start = { stage_no: today.stage_no, name: today.stage_name, date, time: today.start_time, chute: today.chute };
  }
  if (gcTeam?.finish_time) {
    doc.gc = { time: String(gcTeam.finish_time), rank: gcTeam.overall_pos ?? null, of: gcTeam.overall_total ?? null,
               cat_rank: gcTeam.type_pos ?? null, cat_of: gcTeam.type_total ?? null };
  }
  return doc;
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

    // Sportsplits stage races (W2W): the stage table is the team's GC result,
    // fetched live from Sportsplits (short Redis cache in the service) — never
    // stored. Start sheets entered by hand (v2.stage_starts) still merge in.
    for (const raceId of races) {
      const doc = await sportsplitsStages(raceId, bib, request.log);
      if (doc) return reply.header('X-Source', 'sportsplits').send({ race_id: raceId, bib, ...doc });
    }

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
