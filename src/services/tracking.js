/**
 * Tracking service — the core of POST /v1/tracking, extracted so
 * /v2/tracking/:event_id can reuse it per bridged platform race.
 *
 * Mirrors API/api/v4/modules/tracking.cfm + tracking_scripts/general.cfm.
 *
 * Source order per athlete:
 *   1. tracking:race:{race_id}:{athlete_id} — webhook-pushed, freshest
 *   2. redis_splits:{race_id}:athlete:{athlete_id} — pull/push splits cache,
 *      fills athletes the webhook hasn't reported (islive races)
 */

const redis = require('../config/redis');
const { raceconfigByRaceId } = require('./raceConfig');
const pool = require('../config/database');
const { v2RaceObj } = require('./v2RaceConfig');

function nowInTzSecs(tz) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz || 'UTC',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  let h = get('hour');
  if (h === 24) h = 0; // Intl quirk
  return h * 3600 + get('minute') * 60 + get('second');
}

function hmsToSecs(hms) {
  if (!hms) return 0;
  const clean = String(hms).split('.')[0];
  const parts = clean.split(':').map((n) => Number(n) || 0);
  if (parts.length === 2) return parts[0] * 3600 + parts[1] * 60;
  if (parts.length >= 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function secsToHms(total) {
  const t = Math.max(0, Math.floor(total));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function predictPos(lastDistance, speed, lastSplitTOD, totalDistance, tz) {
  const nowSecs   = nowInTzSecs(tz);
  const splitSecs = hmsToSecs(lastSplitTOD);
  const secsDiff  = nowSecs - splitSecs;
  const currentDistance = (Number(speed) || 0) * (secsDiff / 3600) + (Number(lastDistance) || 0);
  let pct = (currentDistance / (Number(totalDistance) || 1)) * 100;
  if (pct >= 100) pct = 100;
  if (pct < 0)    pct = 0;
  return Number(pct.toFixed(2));
}

function calculateLiveRaceTime(splittod, racetime, tz) {
  try {
    if (!racetime || String(racetime).trim() === '') {
      return { live_racetime: '', is_counting: false };
    }
    const nowSecs   = nowInTzSecs(tz);
    const splitSecs = hmsToSecs(splittod);
    const secsDiff  = nowSecs - splitSecs;
    if (secsDiff < 0) {
      return { live_racetime: racetime, is_counting: false };
    }
    const total = hmsToSecs(racetime) + secsDiff;
    return { live_racetime: secsToHms(total), is_counting: true };
  } catch {
    return { live_racetime: racetime, is_counting: false };
  }
}

async function getLatestTracksRedis(tracks, raceId) {
  if (!tracks.length) return [];
  const keys = tracks.map((id) => `tracking:race:${raceId}:${id}`);
  const values = await redis.mget(keys);
  const out = [];
  for (const v of values) {
    if (v) {
      try { out.push(JSON.parse(v)); } catch { /* skip malformed */ }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// RR-live fallback: derive tracking payloads from the redis_splits cache
// (written by services/raceresultPull.js and the push merge). Used for
// athletes with no tracking:race:* key when the race is live (use_redis is
// obsolete).
//
// Leg records are stored alongside splits in redis_splits; they are excluded
// here by an ALLOWLIST — only rr_splitids configured in event.splits count.
// Legs never appear in that list (they live in event.legs), so nothing
// leg-shaped can become an athlete's "last split".
// ---------------------------------------------------------------------------
async function getTracksFromRedisSplits(athleteIds, raceId, race) {
  if (!athleteIds.length) return [];
  const keys = athleteIds.map((id) => `redis_splits:${raceId}:athlete:${id}`);
  const values = await redis.mget(keys);

  // rr_splitid → its event + position among that event's configured splits
  const bySplitId = new Map();
  for (const ev of (race.events || [])) {
    const cfgSplits = Array.isArray(ev.splits) ? ev.splits : [];
    cfgSplits.forEach((s, i) => {
      const sid = Number(s.rr_splitid);
      if (sid > 0) bySplitId.set(sid, { ev, cfgSplits, i });
    });
  }

  const out = [];
  for (let k = 0; k < values.length; k++) {
    if (!values[k]) continue;
    let records;
    try { records = JSON.parse(values[k]); } catch { continue; }
    if (!Array.isArray(records)) continue;

    // Last crossed configured course split (highest feed SplitID with a ToD)
    let best = null;
    for (const rec of records) {
      const hit = bySplitId.get(Number(rec.RR_SplitID));
      if (!hit) continue;                                  // leg or unconfigured
      if (String(rec.SplitToD || '').trim() === '') continue; // not crossed yet
      if (!best || Number(rec.SplitID) > Number(best.rec.SplitID)) {
        best = { rec, ...hit };
      }
    }
    if (!best) continue;

    const { rec, ev, cfgSplits, i } = best;
    const total   = Number(ev.distance) || 0;
    const dist    = Number(cfgSplits[i].split_distance) || 0;
    const isFinal = i === cfgSplits.length - 1;
    const pct     = isFinal ? 100
      : (total > 0 ? Number(((dist / total) * 100).toFixed(2)) : 0);
    const next    = cfgSplits[i + 1];
    const nextPct = (next && total > 0)
      ? Number(((Number(next.split_distance) / total) * 100).toFixed(2))
      : 100;

    // Same payload shape trackPersistence.insertRedis writes, so the
    // rendering loop below consumes both sources identically.
    out.push({
      athlete_id:        String(athleteIds[k]),
      raceNo:            rec.Bib ?? '',
      distance:          dist,
      name:              '',
      use_tracking_path: ev.use_tracking_path,
      marker_text:       race.marker_text ?? '',
      racetime:          rec.SplitRaceTime ?? '',
      splitname:         cfgSplits[i].name,
      splitracetime:     rec.SplitRaceTime ?? '',
      percent_course:    pct,
      course_distance:   total,
      speed:             Number(rec.SplitSpeed) || 0,
      isgps:             false,
      next_splitpercent: nextPct,
      contest_id:        ev.contest_id,
      splittod:          rec.SplitToD ?? '',
      live_camera_url:   '',
    });
  }
  return out;
}

/**
 * Turn 'latest position' entries (either Redis source) into the app's track
 * objects — position along the course, extrapolated speed, live race time.
 */
function renderTracks(latest, race, tz) {
  const out = [];
  for (const t of latest) {
    const path = `p_${t.use_tracking_path}`;

    if (Number(t.percent_course) === 100) {
      const finalRacetime = t.splitracetime || t.racetime || '';
      out.push({
        track:        String(t.athlete_id),
        location:     100,
        speed:        0,
        path,
        info:         'FINISHED ',
        marker_text:  String(t.marker_text ?? ''),
        live_racetime: finalRacetime,
        is_counting:  false,
      });
      continue;
    }

    let latestPosition = predictPos(t.distance, t.speed, t.splittod, t.course_distance, tz);
    // Never behind the last mat actually crossed (guards clock skew, simulated
    // or replayed times, and a missing/zero speed).
    if (!(latestPosition >= Number(t.percent_course))) latestPosition = Number(t.percent_course) || 0;
    let speed   = Number(t.speed) || 0;
    let message = t.isgps
      ? `GPS Update, ${t.splitname} @ ${String(t.splittod).slice(0, 5)} \nSpeed: ${speed} km/h`
      : `Last Timing Split, ${t.splitname} @ ${String(t.splittod).slice(0, 5)} `;

    // Behaviour when the prediction overruns the next timing point is the
    // PER-CONTEST CMS setting events.await_at_next_split (saved by
    // cms/eventssplits/predictive-tracking.cfm):
    //   1 — park at the next mat, zero speed, "Awaiting Update"
    //   0 (default) — keep extrapolating at last-known speed, capped at 100
    try {
      const contestEv = (race.events || []).find(
        (e) => String(e.contest_id) === String(t.contest_id)
      );
      const awaitAtNext = Number(contestEv?.await_at_next_split ?? 0) === 1;
      if (awaitAtNext && latestPosition > Number(t.next_splitpercent)) {
        latestPosition = Number(t.next_splitpercent);
        speed = 0;
        message = 'Awaiting Update';
      }
      if (latestPosition > 100) latestPosition = 100;
    } catch { /* swallow */ }

    const trackRacetime = t.racetime || '';
    const liveTimeData = latestPosition >= 100
      ? { live_racetime: trackRacetime, is_counting: false }
      : calculateLiveRaceTime(t.splittod, trackRacetime, tz);

    out.push({
      track:        String(t.athlete_id),
      location:     Number(latestPosition),
      speed:        Number(speed.toFixed(1)),
      path,
      info:         message,
      marker_text:  String(t.marker_text ?? ''),
      live_racetime: liveTimeData.live_racetime,
      is_counting:  liveTimeData.is_counting,
    });
  }

  return out;
}

/**
 * Build the tracking response for one platform race.
 * Returns the same body POST /v1/tracking has always returned.
 */
async function buildTracking({ raceId, tracks }) {
  // raceconfigByRaceId is Redis-first (raceobj:race:{race_id}, 5-min TTL),
  // PG fallback. See src/services/raceConfig.js.
  const race = await raceconfigByRaceId(raceId);
  if (!race) return { status: 404, body: { error: 'Race not found' } };

  let isWithinReceptionWindow = false;
  if (race.data_reception_start && race.data_reception_end) {
    const now = new Date();
    const start = new Date(race.data_reception_start);
    const end   = new Date(race.data_reception_end);
    isWithinReceptionWindow = now >= start && now <= end;
  }

  const isTestMode    = race.tracking_scriptv3 === 'test_script.cfm';
  const canReceiveData = isTestMode || race.islive || isWithinReceptionWindow;

  if (!canReceiveData) {
    return { status: 200, body: {
      tracks: [],
      islive: !!race.islive,
      isWithinReceptionWindow,
      message: 'Event is not Live or not within data reception window',
    } };
  }

  if (!race.tracking_scriptv3 || race.tracking_scriptv3 === '') {
    return { status: 200, body: { islive: true, message: 'No tracking Script', tracks: [] } };
  }

  let latest = await getLatestTracksRedis(tracks, raceId);

  // RR-live: fill gaps from the redis_splits cache. Webhook-pushed
  // tracking:race:* keys stay primary (fresher); the splits cache covers
  // athletes the webhook hasn't reported.
  if (race.islive) {
    const have    = new Set(latest.map((t) => String(t.athlete_id)));
    const missing = tracks.filter((id) => !have.has(id));
    if (missing.length) {
      latest = latest.concat(await getTracksFromRedisSplits(missing, raceId, race));
    }
  }

  return { status: 200, body: { tracks: renderTracks(latest, race, race.timezone || 'UTC') } };
}


/**
 * V2-native source: redis_splits:{v2_race_id}:athlete:{id} holds the compact
 * records the worker writes ({ rr_id, tod, time, speed, … }); the course
 * geometry comes from the v2 raceobj (v2.contests / v2.splits). Same output
 * shape as getTracksFromRedisSplits so renderTracks is shared.
 */
async function getTracksFromV2RedisSplits(athleteIds, v2RaceId, raceobj) {
  if (!athleteIds.length) return [];
  const values = await redis.mget(athleteIds.map((id) => `redis_splits:${v2RaceId}:athlete:${id}`));

  const bySplitId = new Map();
  for (const ev of (raceobj.events || [])) {
    const cfgSplits = (Array.isArray(ev.splits) ? ev.splits : []).filter((c) => !c.is_leg);
    cfgSplits.forEach((c, i) => { if (Number(c.rr_splitid) > 0) bySplitId.set(Number(c.rr_splitid), { ev, cfgSplits, i }); });
  }

  const out = [];
  for (let k = 0; k < values.length; k++) {
    if (!values[k]) continue;
    let doc; try { doc = JSON.parse(values[k]); } catch { continue; }
    const records = Array.isArray(doc?.splits) ? doc.splits : [];

    // Last crossed configured split = highest configured index with a time of day.
    let best = null;
    for (const rec of records) {
      const hit = bySplitId.get(Number(rec.rr_id));
      if (!hit || String(rec.tod || '').trim() === '') continue;
      if (!best || hit.i > best.i) best = { rec, ...hit };
    }
    if (!best) continue;

    const { rec, ev, cfgSplits, i } = best;
    const total = Number(ev.distance) || 0;
    const dist  = Number(cfgSplits[i].split_distance) || 0;
    const isFinal = i === cfgSplits.length - 1 || rec.finish === 1;
    const pct = isFinal ? 100 : (total > 0 ? Number(((dist / total) * 100).toFixed(2)) : 0);
    const next = cfgSplits[i + 1];
    const nextPct = (next && total > 0) ? Number(((Number(next.split_distance) / total) * 100).toFixed(2)) : 100;
    const speed = Number(rec.speed) || Number(cfgSplits[i].default_spd) || 0;

    out.push({
      athlete_id: String(athleteIds[k]), raceNo: doc.bib ?? '', distance: dist, name: '',
      use_tracking_path: ev.use_tracking_path, marker_text: '',
      racetime: rec.time ?? '', splitname: cfgSplits[i].name, splitracetime: rec.time ?? '',
      percent_course: pct, course_distance: total, speed, isgps: false,
      next_splitpercent: nextPct, contest_id: ev.contest_id, splittod: rec.tod ?? '', live_camera_url: '',
    });
  }
  return out;
}

const V2_LIVE_STATES = new Set(['armed', 'live', 'finalising']);

/**
 * Tracking for a V2-native race (worker-fed redis_splits, no platform race).
 * Live = the worker's live_state; after Stop live the cache lingers an hour
 * ('done' still serves whatever is cached, then the app falls back to results).
 */
async function buildTrackingV2({ v2RaceId, eventId, tracks }) {
  const { rows } = await pool.query(
    "SELECT id, COALESCE(live_state,'idle') AS live_state, time_zone FROM v2.races WHERE id = $1",
    [v2RaceId]
  );
  if (!rows.length) return { status: 404, body: { error: 'Race not found' } };
  const state = rows[0].live_state;
  if (!V2_LIVE_STATES.has(state) && state !== 'done') {
    return { status: 200, body: { tracks: [], islive: false, message: 'Event is not Live or not within data reception window' } };
  }
  const raceobj = await v2RaceObj(eventId);
  if (!raceobj) return { status: 404, body: { error: 'Event not found' } };
  const latest = await getTracksFromV2RedisSplits(tracks.map(String), v2RaceId, raceobj);
  return { status: 200, body: { tracks: renderTracks(latest, raceobj, raceobj.timezone || rows[0].time_zone || 'UTC') } };
}

module.exports = { buildTracking, buildTrackingV2 };
