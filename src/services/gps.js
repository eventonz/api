/**
 * RaceMap GPS feed (V2) — read side of the keys evento-worker's RaceMap
 * poller writes (docs/racemap-gps-integration.md §2). Redis only, nothing
 * here touches Postgres athlete data or redis_splits:*.
 *
 *   gps:race:{v2_race_id}                      field snapshot (dots layer), 5 min
 *   gps:race:{v2_race_id}:athlete:{athlete_id} latest fix per matched athlete, 10 min
 *   gps:race:{v2_race_id}:ops                  crew / support vehicles, 5 min, PIN-gated
 */

const redis = require('../config/redis');

/** A GPS fix older than this (seconds) is ignored by the tracking merge. */
const gpsMaxAgeSecs = () => Number(process.env.GPS_MAX_AGE_S) > 0 ? Number(process.env.GPS_MAX_AGE_S) : 600;

function parseAll(values) {
  const out = [];
  for (const v of values || []) {
    if (!v) continue;
    try { out.push(JSON.parse(v)); } catch { /* skip a malformed blob */ }
  }
  return out;
}

function newestAt(docs) {
  let best = null;
  for (const d of docs) {
    const ms = Date.parse(d?.at || '');
    if (!Number.isNaN(ms) && (best == null || ms > best.ms)) best = { ms, at: d.at };
  }
  return best ? best.at : null;
}

/**
 * Field snapshot for an event: gps:race:{id} for each of its v2 races merged
 * into one { at, contests, rows }. null when no race has a feed or no rider is
 * on it — e.g. only ops vehicles tracked (the app hides its Field button on the
 * resulting 404).
 */
async function gpsFieldSnapshot(raceIds) {
  const ids = (raceIds || []).map(String).filter(Boolean);
  if (!ids.length) return null;
  const docs = parseAll(await redis.mget(ids.map((id) => `gps:race:${id}`)));
  if (!docs.length) return null;
  const contests = {};
  const rows = [];
  for (const d of docs) {
    Object.assign(contests, d.contests && typeof d.contests === 'object' ? d.contests : {});
    if (Array.isArray(d.rows)) rows.push(...d.rows);
  }
  // Crew vehicles live in the :ops key, so no rider rows = nothing for the
  // public Field button to show; 404 hides it.
  if (!rows.length) return null;
  return { at: newestAt(docs), contests, rows };
}

/** Ops vehicles for an event: gps:race:{id}:ops merged into { at, rows }; null when none. */
async function gpsOpsSnapshot(raceIds) {
  const ids = (raceIds || []).map(String).filter(Boolean);
  if (!ids.length) return null;
  const docs = parseAll(await redis.mget(ids.map((id) => `gps:race:${id}:ops`)));
  if (!docs.length) return null;
  const rows = [];
  for (const d of docs) if (Array.isArray(d.rows)) rows.push(...d.rows);
  return { at: newestAt(docs), rows };
}

/** ISO instant → "HH:MM" wall clock in the race timezone (renderTracks shows the first 5 chars of splittod). */
function fixTimeHHMM(iso, tz) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
    const get = (t) => parts.find((p) => p.type === t)?.value || '00';
    const h = get('hour') === '24' ? '00' : get('hour');
    return `${h}:${get('minute')}`;
  } catch {
    return d.toISOString().slice(11, 16);
  }
}

/** Percent of the first configured (non-leg) split past `pct`, else 100 — the await-at-next-split cap. */
function nextSplitPercentAfter(ev, pct) {
  const total = Number(ev?.distance) || 0;
  if (!(total > 0)) return 100;
  const splits = (Array.isArray(ev.splits) ? ev.splits : []).filter((s) => !s.is_leg);
  let next = 100;
  for (const s of splits) {
    const p = Number(((Number(s.split_distance) || 0) / total * 100).toFixed(2));
    if (p > pct && p < next) next = p;
  }
  return next;
}

/**
 * GPS-vs-mat merge for the tracking map (one MGET for all requested ids).
 *
 * For each athlete with a fix in gps:race:{race}:athlete:{id}: when the fix is
 * newer than the track's last mat crossing (anchor_at; a missing anchor counts
 * as older) and younger than GPS_MAX_AGE_S, the track is re-anchored on the fix
 * — position = pct, speed = GPS km/h, isgps = true — so renderTracks extrapolates
 * from there at the GPS speed ("GPS Update" message). Athletes with a fix but no
 * splits record at all get a new track when the fix's contest_id resolves to a
 * raceobj contest. Everything else is left exactly as it was.
 *
 * Returns the (possibly extended) `latest` array. Never throws.
 */
async function mergeGpsFixes({ latest, trackIds, v2RaceId, raceobj, tz }) {
  const ids = (trackIds || []).map(String).filter(Boolean);
  if (!ids.length) return latest;
  let values;
  try {
    values = await redis.mget(ids.map((id) => `gps:race:${v2RaceId}:athlete:${id}`));
  } catch {
    return latest;
  }
  if (!values || !values.some(Boolean)) return latest;

  const byId = new Map((latest || []).map((t) => [String(t.athlete_id), t]));
  const maxAgeMs = gpsMaxAgeSecs() * 1000;
  const now = Date.now();
  const out = (latest || []).slice();

  for (let k = 0; k < values.length; k++) {
    if (!values[k]) continue;
    let fix; try { fix = JSON.parse(values[k]); } catch { continue; }
    const fixMs = Date.parse(fix?.at || '');
    if (Number.isNaN(fixMs) || now - fixMs > maxAgeMs) continue;      // stale or unparseable
    const pct = Number(fix.pct);
    if (!Number.isFinite(pct)) continue;

    const id = ids[k];
    const existing = byId.get(id);
    if (existing) {
      if (Number(existing.percent_course) === 100) continue;          // finished: the mat wins
      const anchorMs = Date.parse(existing.anchor_at || '');
      if (!Number.isNaN(anchorMs) && fixMs <= anchorMs) continue;     // mat crossing is fresher
      const ev = (raceobj?.events || []).find((e) => String(e.contest_id) === String(existing.contest_id));
      // Never behind the last mat actually crossed.
      if (pct < Number(existing.percent_course)) continue;
      Object.assign(existing, {
        percent_course: Number(pct.toFixed(2)),
        distance: Number(fix.km) || (Number(existing.course_distance) || 0) * pct / 100,
        speed: Number(fix.speed) || 0,
        isgps: true,
        splitname: 'GPS',
        splittod: fixTimeHHMM(fix.at, tz),
        anchor_at: fix.at,
        next_splitpercent: ev ? nextSplitPercentAfter(ev, pct) : (existing.next_splitpercent ?? 100),
      });
      continue;
    }

    // GPS only — no splits record. Needs a contest to place it on a course.
    const ev = (raceobj?.events || []).find((e) => String(e.contest_id) === String(fix.contest_id));
    if (!ev) continue;
    const total = Number(ev.distance) || 0;
    const p = Math.min(100, Math.max(0, Number(pct.toFixed(2))));
    const track = {
      athlete_id: id, raceNo: fix.bib ?? '', distance: Number(fix.km) || total * p / 100, name: '',
      use_tracking_path: ev.use_tracking_path, marker_text: '',
      racetime: '', splitname: 'GPS', splitracetime: '',
      percent_course: p, course_distance: total, speed: Number(fix.speed) || 0, isgps: true,
      next_splitpercent: nextSplitPercentAfter(ev, p), contest_id: ev.contest_id,
      splittod: fixTimeHHMM(fix.at, tz), live_camera_url: '', anchor_at: fix.at,
      records: [], start_rr_splitid: 0,
    };
    byId.set(id, track);
    out.push(track);
  }
  return out;
}

module.exports = { gpsFieldSnapshot, gpsOpsSnapshot, mergeGpsFixes, fixTimeHHMM, nextSplitPercentAfter, gpsMaxAgeSecs };
