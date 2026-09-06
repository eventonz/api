/**
 * V2 timing ingest — /v2/tracks/*
 *
 * POST /v2/tracks/raceresult/:rr_eventid
 *
 * RaceResult pushes crossings here (the CMS writes this URL into the event
 * file as the push exporter target; Ugo's native array format is accepted
 * too). The request path does the minimum — resolve the RaceResult event id
 * to its v2.races rows (Redis-cached), check the race is accepting data, and
 * LPUSH one job per race onto the Redis LIST `ingest_queue` — then returns
 * 202. The separate evento-worker service (../evento-worker, its own droplet)
 * BRPOPs and runs the merge + athlete pushes. A start-line burst of thousands
 * of records just lengthens the list; nothing touches Postgres on this path.
 *
 * Public + URL-gated by rr_eventid, same policy as /v1/tracks/*.
 *
 * Envelope (same shape the v1 tracks routes enqueue):
 *   { race_id: <v2.races.id>, datetime, endpoint: 'v2/tracks/raceresult', payload }
 */

const pool  = require('../../config/database');
const redis = require('../../config/redis');
const { raceLog } = require('../../services/raceLog');

const QUEUE_KEY   = 'ingest_queue';
const LOOKUP_TTL  = 30; // seconds — race state cache; a Stop Live lands within this
const ACCEPT_LIVE = new Set(['armed', 'live', 'finalising']);

// rr_eventid → [{ id, live_state, status }] for every v2 race on that RR event.
async function racesForRrEvent(rrEventId) {
  const cacheKey = `v2:tracks:rr_event:${rrEventId}`;
  try {
    const hit = await redis.get(cacheKey);
    if (hit) return JSON.parse(hit);
  } catch { /* fall through to PG */ }

  const { rows } = await pool.query(
    `SELECT id, live_state, status
       FROM v2.races
      WHERE rr_raceid = $1
      ORDER BY id`,
    [rrEventId]
  );
  const races = rows.map((r) => ({
    id: Number(r.id),
    live_state: String(r.live_state || 'idle').toLowerCase(),
    status: String(r.status || '').toLowerCase(),
  }));
  redis.set(cacheKey, JSON.stringify(races), 'EX', LOOKUP_TTL).catch(() => {});
  return races;
}

// Race must be in its live window (scheduler / CMS Stop Live own live_state)
// or flagged live the old way via status.
function acceptsData(race) {
  return ACCEPT_LIVE.has(race.live_state) || race.status === 'live';
}

function isValidJsonBody(body) {
  return body != null && typeof body === 'object';
}

async function v2TracksRoutes(app) {
  // RaceResult's HTTP exporter posts the rendered template as plain text (or
  // with no Content-Type at all); the old CF endpoint read the raw body, so we
  // must too. Scoped to this plugin: anything not application/json is read as
  // a string and parsed as JSON; unparseable bodies arrive as { __raw } so the
  // handler can log the rejection against the race instead of a bare 400.
  // RaceResult renders an empty expression as nothing, so a start crossing
  // arrives as ..."split_speed":,"evento_created":true — invalid JSON. Repair
  // `"key":,` / `"key":}` to null before parsing (the old CF endpoint coped).
  const repair = (text) => text.replace(/("\s*:\s*)(?=[,}\]])/g, '$1null');
  const parseLoose = (req, body, done) => {
    const text = (Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '')).trim();
    try { return done(null, JSON.parse(text)); } catch { /* try repaired */ }
    try { return done(null, JSON.parse(repair(text))); } catch { done(null, { __raw: text }); }
  };
  app.addContentTypeParser('*', { parseAs: 'buffer' }, parseLoose);
  for (const ct of ['text/plain', 'text/html', 'application/x-www-form-urlencoded', 'application/octet-stream']) {
    app.addContentTypeParser(ct, { parseAs: 'buffer' }, parseLoose);
  }
  // Malformed application/json: same treatment rather than Fastify's default 400.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, parseLoose);

  app.post('/raceresult/:rr_eventid', {
    schema: {
      params: {
        type: 'object',
        properties: { rr_eventid: { type: 'integer' } },
        required: ['rr_eventid'],
      },
    },
  }, async (request, reply) => {
    const races = await racesForRrEvent(request.params.rr_eventid);
    if (!races.length) return reply.code(400).send({ msg: 'Race not found' });

    if (!isValidJsonBody(request.body) || request.body.__raw !== undefined) {
      const raw = String(request.body?.__raw ?? '').slice(0, 400);
      for (const r of races) raceLog(r.id, 'error', `push received but body is not JSON (${request.headers['content-type'] || 'no content-type'}): ${raw || '<empty>'}`);
      return reply.code(400).send({ msg: 'Body must be valid JSON' });
    }

    const live = races.filter(acceptsData);
    if (!live.length) {
      for (const r of races) raceLog(r.id, 'push', `received while ${r.live_state} — ignored (race not live)`);
      return reply.code(202).send({ message: 'Race not accepting data' });
    }

    const datetime = new Date().toISOString();
    const jobs = live.map((race) => JSON.stringify({
      race_id: race.id,
      datetime,
      endpoint: 'v2/tracks/raceresult',
      payload: request.body,
    }));
    await redis.lpush(QUEUE_KEY, ...jobs);
    const n = Array.isArray(request.body) ? request.body.length : 1;
    for (const r of live) raceLog(r.id, 'push', `received ${n} record${n === 1 ? '' : 's'} from RaceResult → queued`);

    return reply.code(202).send({ message: 'Queued', races: live.length });
  });
}

module.exports = v2TracksRoutes;
module.exports.acceptsData = acceptsData;
