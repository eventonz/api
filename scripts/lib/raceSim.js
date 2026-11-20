/**
 * Race simulator core (pure — no DB, no Redis, no HTTP). scripts/race-sim.js
 * does the I/O.
 *
 * planRace() turns a startlist + the race's splits into every mat crossing a
 * RaceResult box would push, as Evento exporter structs (the same lowercase
 * fields evento-worker's raceresult normaliser reads), each with the wall-clock
 * ms it should be sent at. positionAt() gives an athlete's true position at
 * any instant, which the runner uses to fake RaceMap GPS fixes.
 *
 * All times are real: `scale` makes athletes faster rather than compressing
 * the clock, so race_time, tod and split_speed stay consistent with the time
 * the push arrives and the tracking map's prediction can be judged as-is.
 */

/** Deterministic PRNG (mulberry32) so a seed replays the same race. */
function rng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n) => String(n).padStart(2, '0');

/** Seconds → "HH:MM:SS". */
function hms(secs) {
  const s = Math.max(0, Math.round(secs));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** Epoch ms → "HH:MM:SS" wall clock in `tz`. */
function todIn(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value || '00';
  return `${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}:${get('second')}`;
}

/** Running pace range by default; anything over 60 km is treated as a bike race. */
function speedRange(distanceKm) {
  return Number(distanceKm) > 60 ? [20, 34] : [8, 15];
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  return { firstname: parts[0] || '', lastname: parts.slice(1).join(' ') };
}

/**
 * @param {object} o
 * @param {Array<{athlete_id, raceno, name, contest}>} o.athletes
 * @param {Array<{contest_id, distance_km}>} o.contests
 * @param {Array<{contest_id, name, rr_splitid, accum_km, split_type, is_leg, sort_order}>} o.splits
 * @param {number} o.startMs     gun time of the first wave
 * @param {string} o.tz          race time zone (tod is local wall clock)
 * @param {number} [o.scale=1]   speed multiplier (10 = a 4 h marathon in 24 min)
 * @param {number} [o.waveGapS=60]  seconds between contest starts
 * @param {number} [o.seed=1]
 * @param {number} [o.dnsRate=0.02] [o.dnfRate=0.03] [o.missRate=0.03]
 * @returns {{ athletes: Array, crossings: Array<{at, athlete_id, rec}> }}
 *   athletes[i].points = [{at, km}] the true path (start → last point reached).
 */
function planRace({ athletes, contests, splits, startMs, tz, scale = 1, waveGapS = 60, seed = 1,
  dnsRate = 0.02, dnfRate = 0.03, missRate = 0.03 }) {
  const rand = rng(seed);
  const between = (lo, hi) => lo + (hi - lo) * rand();
  const contestIds = contests.map((c) => String(c.contest_id));
  const byContest = new Map();
  for (const s of splits) {
    if (s.is_leg) continue;
    const k = String(s.contest_id);
    if (!byContest.has(k)) byContest.set(k, []);
    byContest.get(k).push(s);
  }
  for (const list of byContest.values()) list.sort((a, b) => Number(a.accum_km) - Number(b.accum_km) || Number(a.sort_order) - Number(b.sort_order));

  const planned = [];
  const crossings = [];
  for (const a of athletes) {
    const cid = String(a.contest);
    const course = byContest.get(cid);
    const contest = contests.find((c) => String(c.contest_id) === cid);
    if (!course || !course.length || !contest) continue;
    const plan = { athlete_id: String(a.athlete_id), bib: String(a.raceno ?? a.athlete_id), name: a.name || '',
      contest_id: cid, distance_km: Number(contest.distance_km) || Number(course[course.length - 1].accum_km) || 0,
      status: 'racing', points: [] };
    planned.push(plan);
    // Draw every random number up front so DNS/DNF choices don't shift the
    // rest of the field between seeds.
    const [lo, hi] = speedRange(plan.distance_km);
    const base = (between(lo, hi) + between(lo, hi)) / 2 * scale; // bell-ish
    const fade = between(0, 0.12);
    const startOffsetS = between(0, 30);
    const dns = rand() < dnsRate;
    const dnf = rand() < dnfRate;
    const miss = rand() < missRate;
    const middle = course.map((s, i) => i).filter((i) => i > 0 && i < course.length - 1);
    const dnfAfter = middle.length ? middle[Math.floor(rand() * middle.length)] : course.length - 1;
    const missIdx = middle.length ? middle[Math.floor(rand() * middle.length)] : -1;
    if (dns) { plan.status = 'dns'; continue; }

    const gun = startMs + contestIds.indexOf(cid) * waveGapS * 1000;
    const startAt = gun + startOffsetS * 1000;
    let t = startAt;
    let prevKm = Number(course[0].accum_km) || 0;
    const { firstname, lastname } = splitName(a.name);
    for (let i = 0; i < course.length; i++) {
      const s = course[i];
      const km = Number(s.accum_km) || 0;
      let segKmh = 0;
      if (i > 0) {
        const done = plan.distance_km > 0 ? km / plan.distance_km : 0;
        segKmh = base * (1 - fade * done) * between(0.94, 1.06);
        t += ((km - prevKm) / segKmh) * 3600 * 1000;
      }
      prevKm = km;
      plan.points.push({ at: t, km });
      const isStart = i === 0 || s.split_type === 'start';
      const isFinish = i === course.length - 1 || s.split_type === 'finish';
      if (!(miss && i === missIdx)) {
        crossings.push({
          at: Math.round(t),
          athlete_id: plan.athlete_id,
          rec: {
            bib: plan.bib, athlete_id: plan.athlete_id, rr_splitid: Number(s.rr_splitid),
            contestid: Number(cid), firstname, lastname, split_name: s.name,
            race_time: isStart ? '' : hms((t - startAt) / 1000),
            tod: todIn(t, tz),
            start: isStart ? 1 : 0, finish: isFinish ? 1 : 0,
            split_speed: isStart ? '' : Number(segKmh.toFixed(1)),
            evento_created: true,
          },
        });
      }
      if (dnf && i === dnfAfter) { plan.status = 'dnf'; break; }
      if (isFinish) plan.status = 'finished';
    }
  }
  crossings.sort((x, y) => x.at - y.at);
  return { athletes: planned, crossings };
}

/**
 * True position of a planned athlete at `ms`: { km, pct, kmh, moving }.
 * null before their start crossing (and for DNS). A DNF stands still where
 * they stopped; a finisher sits at the line.
 */
function positionAt(plan, ms) {
  const p = plan.points;
  if (!p.length || ms < p[0].at) return null;
  const pctOf = (km) => (plan.distance_km > 0 ? Math.min(100, Number((km / plan.distance_km * 100).toFixed(1))) : 0);
  for (let i = 1; i < p.length; i++) {
    if (ms < p[i].at) {
      const f = (ms - p[i - 1].at) / (p[i].at - p[i - 1].at);
      const km = p[i - 1].km + (p[i].km - p[i - 1].km) * f;
      const kmh = (p[i].km - p[i - 1].km) / ((p[i].at - p[i - 1].at) / 3600000);
      return { km: Number(km.toFixed(2)), pct: pctOf(km), kmh: Number(kmh.toFixed(1)), moving: true };
    }
  }
  const last = p[p.length - 1];
  return { km: last.km, pct: pctOf(last.km), kmh: 0, moving: false };
}

module.exports = { planRace, positionAt, rng, hms, todIn, speedRange };
