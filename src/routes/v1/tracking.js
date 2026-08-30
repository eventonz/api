const redis = require('../../config/redis');
const { raceconfigByRaceId } = require('../../services/raceConfig');

// Mirrors API/api/v4/modules/tracking.cfm + tracking_scripts/general.cfm

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
// (written by services/raceresultPull.js). Used for athletes with no
// tracking:race:* key when the race is live (use_redis is obsolete).
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

async function trackingRoutes(app) {
  app.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['race_id', 'tracks'],
        properties: {
          race_id: { type: ['integer', 'string'] },
          tracks:  { type: 'array', items: { type: ['integer', 'string'] } },
        },
      },
    },
  }, async (request, reply) => {
    const raceId = Number(request.body.race_id);
    const tracks = (request.body.tracks || []).map(String);

    // raceconfigByRaceId is Redis-first (raceobj:race:{race_id}, 5-min TTL),
    // PG fallback. See src/services/raceConfig.js.
    const race = await raceconfigByRaceId(raceId);
    if (!race) return reply.notFound('Race not found');

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
      return {
        tracks: [],
        islive: !!race.islive,
        isWithinReceptionWindow,
        message: 'Event is not Live or not within data reception window',
      };
    }

    if (!race.tracking_scriptv3 || race.tracking_scriptv3 === '') {
      return { islive: true, message: 'No tracking Script', tracks: [] };
    }

    let latest = await getLatestTracksRedis(tracks, raceId);

    // RR-live: fill gaps from the redis_splits cache. Webhook-pushed
    // tracking:race:* keys stay primary (fresher); the 2-3 min pull snapshot
    // covers athletes the webhook hasn't reported.
    if (race.islive) {
      const have    = new Set(latest.map((t) => String(t.athlete_id)));
      const missing = tracks.filter((id) => !have.has(id));
      if (missing.length) {
        latest = latest.concat(await getTracksFromRedisSplits(missing, raceId, race));
      }
    }

    const tz = race.timezone || 'UTC';

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
      let speed   = Number(t.speed) || 0;
      let message = t.isgps
        ? `GPS Update, ${t.splitname} @ ${String(t.splittod).slice(0, 5)} \nSpeed: ${speed} km/h`
        : `Last Timing Split, ${t.splitname} @ ${String(t.splittod).slice(0, 5)} `;

      // Behaviour when the prediction overruns the next timing point is the
      // PER-CONTEST CMS setting events.await_at_next_split (saved by
      // cms/eventssplits/predictive-tracking.cfm):
      //   1 — park at the next mat, zero speed, "Awaiting Update"
      //   0 (default) — keep extrapolating at last-known speed, capped at 100
      // The original node port hard-coded the park behaviour and ignored the
      // setting; this restores the CF behaviour.
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

    return { tracks: out };
  });
}

module.exports = trackingRoutes;
