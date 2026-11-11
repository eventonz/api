#!/usr/bin/env node
/**
 * Field-based segment ratios for one live contest, read straight from Redis.
 * Reporting only — nothing is written. See src/services/trackingRatios.js.
 *
 *   node scripts/tracking-ratios.js <event_id> <v2_race_id> <contest_id> [--check N]
 *
 *   node scripts/tracking-ratios.js pinotage 158 4            ratios per segment
 *   node scripts/tracking-ratios.js pinotage 158 4 --check 6  + predict the next mat for 6 random
 *                                                            teams that have since crossed it, and
 *                                                            compare with the old flat-speed method
 */
const pool = require('../src/config/database');
const redis = require('../src/config/redis');
const { v2RaceObj } = require('../src/services/v2RaceConfig');
const { computeSegmentRatios, expectedNextMat, matsFromContest, todSecs } = require('../src/services/trackingRatios');

const [eventId, raceId, contestId] = process.argv.slice(2);
const checkIdx = process.argv.indexOf('--check');
const check = checkIdx > 0 ? Number(process.argv[checkIdx + 1] || 5) : 0;
if (!eventId || !raceId || !contestId) {
  console.error('usage: node scripts/tracking-ratios.js <event_id> <v2_race_id> <contest_id> [--check N]');
  process.exit(1);
}

const hm = (s) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}`;

(async () => {
  const raceobj = await v2RaceObj(eventId);
  const contest = (raceobj?.events || []).find((e) => String(e.contest_id) === String(contestId));
  if (!contest) throw new Error(`contest ${contestId} not found on ${eventId}`);
  const mats = matsFromContest(contest);

  const { rows } = await pool.query('SELECT raceno FROM v2.athletes WHERE race_id = $1', [raceId]);
  const ids = rows.map((r) => String(r.raceno));
  const values = await redis.mget(ids.map((id) => `redis_splits:${raceId}:athlete:${id}`));
  const teams = values.map((v) => { try { return JSON.parse(v)?.splits || []; } catch { return []; } });

  const table = computeSegmentRatios(mats, teams);
  console.log(`\n${raceobj.name || eventId} · ${contest.event_descr} · ${teams.filter((t) => t.length).length} teams with data\n`);
  console.log('segment'.padEnd(22), 'km'.padStart(5), 'ratio'.padStart(7), 'spread'.padStart(7), 'teams'.padStart(6), '  state');
  for (const s of table) {
    console.log(`${s.from} → ${s.to}`.padEnd(22), String(s.km).padStart(5),
      (s.ratio == null ? '-' : s.ratio.toFixed(2)).padStart(7),
      (s.spread == null ? '-' : `±${Math.round(s.spread * 100)}%`).padStart(7),
      String(s.n).padStart(6), s.ready ? '  ready' : (s.from_id === mats[0].rr_splitid ? '  never (first segment)' : '  waiting for 20'));
  }

  if (check) {
    const startId = mats[0].rr_splitid;
    // Hold back each sampled team's crossing of its last mat and predict it.
    const cands = [];
    teams.forEach((recs, k) => {
      const t = {}; for (const r of recs) { const s = todSecs(r.tod); if (s != null) t[Number(r.rr_id)] = s; }
      const seg = table.filter((s) => s.ready && t[s.from_id] != null && t[s.to_id] != null).pop();
      if (seg) cands.push({ id: ids[k], recs, t, seg });
    });
    const sample = cands.sort(() => Math.random() - 0.5).slice(0, check);
    console.log(`\nteam   segment        own km/h   field pred   old pred   actual    err field / err old`);
    const errs = { f: [], o: [] };
    for (const c of sample) {
      const heldBack = c.recs.filter((r) => Number(r.rr_id) !== c.seg.to_id);
      const p = expectedNextMat(table, heldBack, startId);
      if (!p) continue;
      const i = table.indexOf(c.seg);
      const prev = table[i - 1];
      const lastSpeed = prev && c.t[prev.from_id] != null ? prev.km / ((c.t[prev.to_id] - c.t[prev.from_id]) / 3600) : p.own_kmh;
      const old = c.t[c.seg.from_id] + c.seg.km / lastSpeed * 3600;
      const ef = (p.expected_tod_secs - c.t[c.seg.to_id]) / 60;
      const eo = (old - c.t[c.seg.to_id]) / 60;
      errs.f.push(Math.abs(ef)); errs.o.push(Math.abs(eo));
      console.log(`${c.id.padEnd(6)} ${p.segment.padEnd(14)} ${String(p.own_kmh).padStart(7)}     ${hm(p.expected_tod_secs)}       ${hm(old)}      ${hm(c.t[c.seg.to_id])}    ${ef.toFixed(1).padStart(6)} / ${eo.toFixed(1).padStart(6)} min`);
    }
    const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
    console.log(`\nmedian abs error over ${errs.f.length}: field ${med(errs.f).toFixed(1)} min · old ${med(errs.o).toFixed(1)} min`);
  }
  await redis.quit();
  await pool.end?.();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
