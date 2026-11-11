/**
 * Field-based segment ratios for predictive tracking (W2W, 11 Nov 2026).
 *
 * The live predictor extrapolates a rider at the speed of the segment they
 * last completed. On a stage race that put teams at the finish line while
 * they were still on the WP2→WP3 climb (Pinotage Stage 3: typical error
 * 30 min). The field already knows the course: by the time 20 teams have
 * crossed a mat we can see how much slower (or faster) that segment rides
 * than what came before it, and that proportion holds for the whole field —
 * elites and back markers slow by the same share on the same climb.
 *
 *   ratio(segment) = median over teams through its far mat of
 *                    (speed on the segment) / (that team's own average speed
 *                                              from the start to the segment's start)
 *
 * Applying it: expected speed on the segment = rider's own pace so far × ratio.
 * A rider has no "pace so far" before the first mat, so the Start→first-mat
 * segment never gets a ratio; the field method only applies from the first
 * timing point onward. Everything before that, and any segment with fewer
 * than MIN_TEAMS through its far mat, stays on the old flat-speed method.
 *
 * NOT wired into tracking.js yet — how it switches on is still to be decided.
 * Pure: takes the mats of one contest and the teams' crossings, returns one
 * entry per segment. See ../../docs/field-based-tracking-prediction.md.
 */

const MIN_TEAMS = 20;

/** 'HH:MM:SS' / 'HH:MM:SS.s' → seconds since midnight; null if unparseable. */
function todSecs(tod) {
  if (!tod || typeof tod !== 'string') return null;
  const p = tod.split(':').map(Number);
  if (p.length < 2 || p.some(Number.isNaN)) return null;
  return p.length === 2 ? p[0] * 3600 + p[1] * 60 : p[0] * 3600 + p[1] * 60 + p[2];
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quantile(xs, q) {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * Mats of a contest, in course order, from a raceobj contest (`event.splits`
 * as v2RaceConfig builds them): keyed by rr_splitid with their km from the start.
 */
function matsFromContest(contest) {
  return (contest?.splits || [])
    .filter((s) => !s.is_leg && Number(s.rr_splitid) > 0 && s.split_distance != null)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((s) => ({ rr_splitid: Number(s.rr_splitid), km: Number(s.split_distance), name: s.name }));
}

/**
 * @param {Array<{rr_splitid:number, km:number, name?:string}>} mats  — course order, first = start (km 0)
 * @param {Array<Array<{rr_id:number, tod:string}>>} teams — each team's crossing records
 *        (the compact `splits` array the worker keeps in redis_splits:{race}:athlete:{team})
 * @param {{minTeams?:number}} [opts]
 * @returns {Array<{from:string, to:string, from_id:number, to_id:number, km:number,
 *                  ratio:number|null, spread:number|null, n:number, ready:boolean}>}
 *          one entry per segment (mats[i-1] → mats[i], i ≥ 1). The first segment
 *          has no "pace so far" to compare against, so its ratio is always null.
 */
function computeSegmentRatios(mats, teams, opts = {}) {
  const minTeams = opts.minTeams ?? MIN_TEAMS;
  if (!Array.isArray(mats) || mats.length < 2) return [];
  const startId = mats[0].rr_splitid;

  // team → { rr_splitid: secs }
  const crossings = teams.map((recs) => {
    const t = {};
    for (const r of Array.isArray(recs) ? recs : []) {
      const secs = todSecs(r && r.tod);
      if (secs != null && Number(r.rr_id) > 0) t[Number(r.rr_id)] = secs;
    }
    return t;
  }).filter((t) => t[startId] != null);

  const out = [];
  for (let i = 1; i < mats.length; i++) {
    const a = mats[i - 1];
    const b = mats[i];
    const segKm = b.km - a.km;
    const priorKm = a.km - mats[0].km;
    const ratios = [];
    // i === 1 is Start → first mat: no prior pace, never a ratio.
    if (i > 1 && segKm > 0 && priorKm > 0) {
      for (const t of crossings) {
        const ta = t[a.rr_splitid];
        const tb = t[b.rr_splitid];
        if (ta == null || tb == null) continue;
        const priorSecs = ta - t[startId];
        const segSecs = tb - ta;
        if (priorSecs <= 0 || segSecs <= 0) continue;
        ratios.push((segKm / segSecs) / (priorKm / priorSecs));
      }
    }
    const ready = ratios.length >= minTeams;
    out.push({
      from: a.name ?? String(a.rr_splitid),
      to: b.name ?? String(b.rr_splitid),
      from_id: a.rr_splitid,
      to_id: b.rr_splitid,
      km: Number(segKm.toFixed(2)),
      ratio: ready ? Number(median(ratios).toFixed(3)) : null,
      // half-width of the p10–p90 band, as a share of the ratio: "± spread"
      spread: ready ? Number(((quantile(ratios, 0.9) - quantile(ratios, 0.1)) / 2 / median(ratios)).toFixed(3)) : null,
      n: ratios.length,
      ready,
    });
  }
  return out;
}

/**
 * Expected arrival at the next mat for one rider, given the segment table.
 * Returns null when the rider's segment has no ready ratio (caller falls back
 * to the flat last-known-speed method) — which includes every rider who has
 * not yet crossed the first mat.
 *
 * @param {ReturnType<typeof computeSegmentRatios>} table
 * @param {{rr_id:number, tod:string}[]} recs — the rider's crossings
 * @param {number} startId — rr_splitid of the start mat
 */
function expectedNextMat(table, recs, startId) {
  const t = {};
  for (const r of recs || []) { const s = todSecs(r && r.tod); if (s != null) t[Number(r.rr_id)] = s; }
  if (t[startId] == null) return null;
  // The rider's current segment: its "from" mat crossed, its "to" mat not yet.
  let seg = null;
  for (const s of table) { if (t[s.from_id] != null && t[s.to_id] == null) seg = s; }
  if (!seg || !seg.ready) return null;
  const priorKm = table.filter((s) => t[s.to_id] != null && s.to_id !== seg.to_id).reduce((km, s) => km + s.km, 0);
  const priorSecs = t[seg.from_id] - t[startId];
  if (priorKm <= 0 || priorSecs <= 0) return null;
  const ownKmh = priorKm / (priorSecs / 3600);
  const expectedSecs = seg.km / (ownKmh * seg.ratio) * 3600;
  return {
    segment: `${seg.from} → ${seg.to}`,
    own_kmh: Number(ownKmh.toFixed(1)),
    expected_kmh: Number((ownKmh * seg.ratio).toFixed(1)),
    expected_tod_secs: t[seg.from_id] + expectedSecs,
    earliest_tod_secs: t[seg.from_id] + expectedSecs * (1 - seg.spread),
    latest_tod_secs: t[seg.from_id] + expectedSecs * (1 + seg.spread),
  };
}

module.exports = { computeSegmentRatios, expectedNextMat, matsFromContest, todSecs, MIN_TEAMS };
