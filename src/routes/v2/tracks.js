/**
 * V2 timing ingest — /v2/tracks/*
 *
 * POST /v2/tracks/raceresult/:rr_eventid
 * POST /v2/tracks/racetec/:apikey      (RaceTec / SES — timer_platform 'racetec')
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
const RAW_CAP     = 500;              // raw pushes kept per race (newest first)
const RAW_TTL     = 7 * 24 * 3600;
const RAW_MAX     = 64 * 1024;        // bytes of body kept per push
const LOOKUP_TTL  = 30; // seconds — race state cache; a Stop Live lands within this
const ACCEPT_LIVE = new Set(['armed', 'live', 'finalising']);

// Platform key → [{ id, live_state, status }] for every v2 race carrying it:
// RaceResult = rr_raceid (one RR event can back several races), RaceTec =
// the per-event api key (migration 042).
async function racesForKey(platform, key, { fresh = false } = {}) {
  const cacheKey = platform === 'racetec' ? `v2:tracks:racetec:${key}` : `v2:tracks:rr_event:${key}`;
  try {
    const hit = await (fresh ? Promise.resolve(null) : redis.get(cacheKey));
    if (hit) return JSON.parse(hit);
  } catch { /* fall through to PG */ }

  const { rows } = await pool.query(
    platform === 'racetec'
      ? `SELECT id, live_state, status FROM v2.races WHERE racetec_apikey = $1 ORDER BY id`
      : `SELECT id, live_state, status FROM v2.races WHERE rr_raceid = $1 ORDER BY id`,
    [key]
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

// Keep every push as received, keyed by the timer's own id so it's easy to
// find in Redis — racetec:pushes:{apikey} / raceresult:pushes:{rr_eventid} —
// (scripts/show-pushes.js <key>). Live or not, JSON or not: the point is
// seeing the raw traffic.
function recordRawPush(races, platform, key, request) {
  const body = request.body;
  const text = body?.__raw !== undefined ? String(body.__raw) : JSON.stringify(body);
  const entry = JSON.stringify({
    at: new Date().toISOString(),
    platform,
    content_type: request.headers['content-type'] || '',
    bytes: Buffer.byteLength(text || ''),
    states: Object.fromEntries(races.map((r) => [r.id, r.live_state])),
    body: (text || '').slice(0, RAW_MAX),
  });
  const listKey = `${platform}:pushes:${key}`;
  redis.multi()
    .lpush(listKey, entry)
    .ltrim(listKey, 0, RAW_CAP - 1)
    .expire(listKey, RAW_TTL)
    .exec()
    .catch(() => {});
  return text || '';
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

  // Both platforms share one handler: resolve the key to races, gate on live
  // state, queue one job per live race for the worker.
  const ingest = (platform, label) => async (request, reply) => {
    const key = platform === 'racetec' ? request.params.apikey : request.params.rr_eventid;
    let races = await racesForKey(platform, key);
    if (!races.length) return reply.code(400).send({ msg: 'Race not found' });
    const rawText = recordRawPush(races, platform, key, request);
    const preview = rawText.replace(/\s+/g, ' ').slice(0, 300);

    if (!isValidJsonBody(request.body) || request.body.__raw !== undefined) {
      const raw = String(request.body?.__raw ?? '').slice(0, 400);
      for (const r of races) raceLog(r.id, 'error', `push received but body is not JSON (${request.headers['content-type'] || 'no content-type'}): ${raw || '<empty>'}`);
      return reply.code(400).send({ msg: 'Body must be valid JSON' });
    }

    let live = races.filter(acceptsData);
    if (!live.length) {
      // The cached lookup can lag a Go live pressed seconds ago (the first
      // RaceSim/exporter burst lands right after) — confirm against the DB
      // before dropping anything.
      races = await racesForKey(platform, key, { fresh: true });
      live = races.filter(acceptsData);
    }
    if (!live.length) {
      const bucket = Math.floor(Date.now() / 600000);
      for (const r of races) {
        raceLog(r.id, 'push', `received while ${r.live_state} — ignored (race not live): ${preview}`);
        // Counted so the worker can warn admins "RaceResult is pushing but nobody pressed Go live".
        redis.incr(`ops:pushes_ignored:${r.id}:${bucket}`).then(() => redis.expire(`ops:pushes_ignored:${r.id}:${bucket}`, 1500)).catch(() => {});
      }
      return reply.code(202).send({ message: 'Race not accepting data' });
    }

    const datetime = new Date().toISOString();
    const jobs = live.map((race) => JSON.stringify({
      race_id: race.id,
      datetime,
      endpoint: `v2/tracks/${platform}`,
      payload: request.body,
    }));
    await redis.lpush(QUEUE_KEY, ...jobs);
    const n = Array.isArray(request.body) ? request.body.length : 1;
    for (const r of live) raceLog(r.id, 'push', `received ${n} record${n === 1 ? '' : 's'} from ${label} → queued: ${preview}`);

    return reply.code(202).send({ message: 'Queued', races: live.length });
  };

  app.post('/raceresult/:rr_eventid', {
    schema: { params: { type: 'object', properties: { rr_eventid: { type: 'integer' } }, required: ['rr_eventid'] } },
  }, ingest('raceresult', 'RaceResult'));

  app.post('/racetec/:apikey', {
    schema: { params: { type: 'object', properties: { apikey: { type: 'string', minLength: 8, maxLength: 80 } }, required: ['apikey'] } },
  }, ingest('racetec', 'RaceTec'));
}

module.exports = v2TracksRoutes;
module.exports.acceptsData = acceptsData;
