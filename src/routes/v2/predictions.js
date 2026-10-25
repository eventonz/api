const pool  = require('../../config/database');
const redis = require('../../config/redis');
const { rateLimit } = require('../../plugins/rateLimit');

/**
 * Predict the finish (blocks v31 `predict_finish`) — a fan guesses an
 * athlete's finish time before they start. Free, no prizes, PRIVATE: a guess
 * is only ever returned to the install that made it. The only cross-install
 * figures are rank/field ("12th closest of 340").
 *
 *   GET /v2/predictions/:event_id/mine             → { enabled, contests, guesses: [...] }
 *   GET /v2/predictions/:event_id/:athlete_id      → { enabled, state, guessSecs, suggestedSecs, … }
 *   PUT /v2/predictions/:event_id/:athlete_id      { guessSecs, suggestedSecs?, fcmToken? }
 *
 * Identity = the install token's install_id (never a client-sent string).
 * A guess can be changed until the athlete's first crossing (or the event's
 * closesAt), then it locks. evento-worker scores + ranks on the finish and
 * sends the per-phone pushes (lib/predictions.js there).
 *
 * Settings: v2.events.event_json.predict
 *   { enabled, contests: [ids] (empty = all), closesAt (ISO), sponsor: {name, logo},
 *     termsUrl, halfwayPush, typical: { [contestId]: "H:MM:SS" } }
 */

const SETTINGS_TTL_MS = 30 * 1000;
const settingsCache = new Map(); // event_id → { at, s }

function toSecs(v) {
  const s = String(v ?? '').trim().replace(/^\*/, '');
  if (!s) return null;
  const parts = s.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  const secs = parts.reduce((acc, n) => acc * 60 + n, 0);
  return secs > 0 ? Math.round(secs) : null;
}

async function settingsFor(eventId) {
  const hit = settingsCache.get(eventId);
  if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit.s;
  const { rows } = await pool.query(`SELECT event_json->'predict' AS p FROM v2.events WHERE id = $1`, [eventId]);
  const p = rows[0]?.p || null;
  const s = p && p.enabled ? {
    enabled: true,
    contests: Array.isArray(p.contests) ? p.contests.map(String).filter(Boolean) : [],
    closesAt: p.closesAt || null,
    sponsor: p.sponsor && (p.sponsor.name || p.sponsor.logo) ? { name: p.sponsor.name || '', logo: p.sponsor.logo || '' } : null,
    termsUrl: p.termsUrl || null,
    typical: p.typical && typeof p.typical === 'object' ? p.typical : {},
  } : { enabled: false };
  settingsCache.set(eventId, { at: Date.now(), s });
  return s;
}

const contestEnabled = (s, contestId) => s.enabled && (!s.contests.length || s.contests.includes(String(contestId)));
const closed = (s) => !!(s.closesAt && Date.parse(s.closesAt) <= Date.now());

/** The athlete's race + contest in this event (null when unknown). */
async function athleteIn(eventId, athleteId) {
  const { rows } = await pool.query(
    `SELECT a.race_id, a.contest::text AS contest, a.first_name, a.name
       FROM v2.athletes a JOIN v2.races r ON r.id = a.race_id
      WHERE r.event_id = $1 AND a.athlete_id = $2
      ORDER BY a.updated_at DESC NULLS LAST, a.id DESC LIMIT 1`,
    [eventId, athleteId]
  );
  return rows[0] || null;
}

/** Has the athlete crossed any mat? Live cache first, then the results table. */
async function crossings(raceId, athleteId) {
  try {
    const raw = await redis.get(`redis_splits:${raceId}:athlete:${athleteId}`);
    if (raw) {
      const v = JSON.parse(raw);
      const timed = (v.splits || []).filter((s) => (s.tod || s.time || s.gun || s.chip || '') !== '');
      if (timed.length) return { started: true, splits: timed };
    }
  } catch { /* fall through */ }
  const { rows } = await pool.query(
    `SELECT 1 FROM v2.rr_results WHERE race_id = $1 AND athlete_id = $2
        AND (split_tod <> '' OR split_gun <> '' OR split_chip <> '') LIMIT 1`,
    [raceId, athleteId]
  );
  return { started: rows.length > 0, splits: [] };
}

/** Where the wheel starts: timer's own predicted finish → CMS typical time for the contest. */
function suggestion(s, contestId, cross) {
  const latest = [...(cross?.splits || [])].reverse().find((x) => x.predicted);
  const fromTimer = latest ? toSecs(latest.predicted) : null;
  if (fromTimer) return fromTimer;
  return toSecs(s.typical?.[String(contestId)]);
}

/**
 * On-pace finish (seconds) from the athlete's latest crossing: the timer's own
 * prediction when it sends one, else race time ÷ share of the course done
 * (v2.splits.percent_course). Only from 25 % on — earlier legs (a triathlon
 * swim) project nonsense.
 */
async function onPace(raceId, contestId, cross) {
  const timed = cross?.splits || [];
  if (!timed.length) return null;
  const { rows } = await pool.query(
    `SELECT rr_splitid, percent_course FROM v2.splits
      WHERE race_id = $1 AND contest_id = $2 AND NOT COALESCE(is_leg, false) AND rr_splitid IS NOT NULL`,
    [raceId, String(contestId)]
  );
  const pct = new Map(rows.map((r) => [String(r.rr_splitid), Number(r.percent_course) || 0]));
  let best = null;
  for (const x of timed) {
    const p = pct.get(String(x.rr_id)) || 0;
    if (x.finish || p >= 100) continue;
    if (!best || p > best.p) best = { x, p };
  }
  if (!best || best.p < 25) return null;
  const predicted = toSecs(best.x.predicted);
  if (predicted) return predicted;
  const t = toSecs(best.x.chip) || toSecs(best.x.time) || toSecs(best.x.gun);
  return t ? Math.round(t / (best.p / 100)) : null;
}

function shapeMine(row) {
  return {
    athleteId: row.athlete_id,
    contestId: row.contest_id,
    guessSecs: row.guess_secs,
    locked: !!row.locked_at,
    actualSecs: row.actual_secs,
    offSecs: row.off_secs,
    rank: row.rank,
    field: row.field,
    final: row.final,
  };
}

function requireInstall(request, reply) {
  if (request.auth?.type !== 'install' || !request.auth.install_id) {
    reply.code(401).send({ error: 'Install token required', code: 'INSTALL_TOKEN_REQUIRED' });
    return null;
  }
  return String(request.auth.install_id);
}

async function predictionsRoutes(app) {
  const params = { type: 'object', properties: { event_id: { type: 'string' }, athlete_id: { type: 'string' } }, required: ['event_id', 'athlete_id'] };

  // Everything this install guessed in the event — followed rows + Race Wrapped.
  app.get('/:event_id/mine', {
    schema: { params: { type: 'object', properties: { event_id: { type: 'string' } }, required: ['event_id'] } },
  }, async (request, reply) => {
    const install = requireInstall(request, reply);
    if (!install) return reply;
    const { event_id } = request.params;
    const s = await settingsFor(event_id);
    const { rows } = await pool.query(
      `SELECT * FROM v2.predictions WHERE install_id = $1 AND event_id = $2 ORDER BY created_at`,
      [install, event_id]
    );
    return {
      enabled: s.enabled, contests: s.contests || [], closed: s.enabled ? closed(s) : true,
      sponsor: s.sponsor || null,
      guesses: rows.map(shapeMine),
    };
  });

  app.get('/:event_id/:athlete_id', { schema: { params } }, async (request, reply) => {
    const install = requireInstall(request, reply);
    if (!install) return reply;
    const { event_id, athlete_id } = request.params;
    const s = await settingsFor(event_id);
    const ath = s.enabled ? await athleteIn(event_id, athlete_id) : null;
    if (!ath || !contestEnabled(s, ath.contest)) return { enabled: false };

    const [{ rows }, cross] = await Promise.all([
      pool.query(`SELECT * FROM v2.predictions WHERE race_id = $1 AND athlete_id = $2 AND install_id = $3`,
        [ath.race_id, athlete_id, install]),
      crossings(ath.race_id, athlete_id),
    ]);
    const mine = rows[0] || null;
    const locked = cross.started || closed(s) || !!mine?.locked_at;
    let state;
    if (mine?.actual_secs != null) state = 'finished';
    else if (locked) state = mine ? 'locked' : 'closed';
    else state = mine ? 'guessed' : 'open';

    return {
      enabled: true,
      state,
      contestId: ath.contest,
      guessSecs: mine?.guess_secs ?? null,
      suggestedSecs: mine?.suggested_secs ?? suggestion(s, ath.contest, cross),
      actualSecs: mine?.actual_secs ?? null,
      offSecs: mine?.off_secs ?? null,
      rank: mine?.rank ?? null,
      field: mine?.field ?? null,
      final: mine?.final ?? false,
      onPaceSecs: mine && cross.started && mine.actual_secs == null ? await onPace(ath.race_id, ath.contest, cross) : null,
      closesAt: s.closesAt,
      sponsor: s.sponsor,
      termsUrl: s.termsUrl,
    };
  });

  app.put('/:event_id/:athlete_id', {
    preHandler: rateLimit({ name: 'predict', limit: 20, windowSec: 60, key: (req) => `i:${req.auth?.install_id || req.ip}` }),
    schema: {
      params,
      body: { type: 'object', properties: {
        guessSecs: { type: 'integer', minimum: 60, maximum: 172800 },
        suggestedSecs: { type: ['integer', 'null'] },
        fcmToken: { type: ['string', 'null'], maxLength: 4096 },
      }, required: ['guessSecs'] },
    },
  }, async (request, reply) => {
    const install = requireInstall(request, reply);
    if (!install) return reply;
    const { event_id, athlete_id } = request.params;
    const b = request.body;
    const s = await settingsFor(event_id);
    const ath = s.enabled ? await athleteIn(event_id, athlete_id) : null;
    if (!ath || !contestEnabled(s, ath.contest)) return reply.code(404).send({ error: 'Predictions are not open for this athlete.' });
    if (closed(s)) return reply.code(409).send({ error: 'Predictions have closed.', code: 'LOCKED' });
    const cross = await crossings(ath.race_id, athlete_id);
    if (cross.started) return reply.code(409).send({ error: 'Locked — they\'ve started.', code: 'LOCKED' });

    let deviceTokenId = null;
    if (b.fcmToken) {
      const { rows } = await pool.query(`SELECT id FROM v2.device_tokens WHERE fcm_token = $1`, [b.fcmToken]);
      deviceTokenId = rows[0]?.id ?? null;
    }
    const suggested = Number.isInteger(b.suggestedSecs) ? b.suggestedSecs : null;
    const { rows } = await pool.query(
      `INSERT INTO v2.predictions (race_id, event_id, contest_id, athlete_id, app_id, install_id,
                                   device_token_id, guess_secs, suggested_secs)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (race_id, athlete_id, install_id) DO UPDATE SET
         guess_secs = EXCLUDED.guess_secs,
         device_token_id = COALESCE(EXCLUDED.device_token_id, v2.predictions.device_token_id),
         contest_id = EXCLUDED.contest_id, updated_at = now()
       WHERE v2.predictions.locked_at IS NULL
       RETURNING *`,
      [ath.race_id, event_id, ath.contest, athlete_id, request.auth.app_id ?? null, install,
       deviceTokenId, b.guessSecs, suggested]
    );
    if (!rows.length) return reply.code(409).send({ error: 'Locked — they\'ve started.', code: 'LOCKED' });
    return { ok: true, state: 'guessed', guessSecs: rows[0].guess_secs };
  });
}

module.exports = predictionsRoutes;
module.exports.toSecs = toSecs;
