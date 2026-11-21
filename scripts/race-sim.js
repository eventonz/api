#!/usr/bin/env node
/**
 * Race simulator — a fake RaceResult timing box pushing a whole field through
 * the real live pipeline, so the tracking map (predictive + GPS) can be tested
 * without a race.
 *
 *   node scripts/race-sim.js setup [--rebuild]     # clone the test race into event "race-sim" on dev app 901
 *   node scripts/race-sim.js run [options]         # reset, Go live, push crossings as the race happens
 *   node scripts/race-sim.js stop                  # live_state → done
 *
 * run options:
 *   --scale 10        athletes run 10× faster (marathon ≈ 24 min); every time pushed stays real
 *   --limit 100       athletes on the startlist (default: all)
 *   --gps 15          fake RaceMap GPS trackers on that many athletes in tracking contests
 *   --gps-dead 0.3    share of those trackers that die mid-race (tests the stale / "?" paths)
 *   --gps-every 15    seconds between GPS fixes
 *   --gps-bibs 2,5    put the trackers on these bibs instead of the first N
 *   --join            GPS only, onto the race already running (same seed/scale/limit
 *                     as that run): no reset, no crossings pushed
 *   --seed 1          same seed = same race
 *   --target URL      API that receives the pushes (default https://eventoapi.com)
 *   --dry-run         print the plan, push nothing
 *
 * Pushes are Evento exporter structs (the format the CMS writes into the RR
 * event file) POSTed to {target}/v2/tracks/raceresult/{rr id} → ingest_queue →
 * evento-worker → redis_splits + v2.rr_results + athlete pushes: exactly the
 * race-day path. GPS fixes are written straight to the gps:race:* keys the
 * worker's RaceMap poller would write. See scripts/lib/raceSim.js.
 *
 * Safety: only ever touches the event SIM_EVENT. The clone has a made-up RR id
 * and no RR feed, so the scheduler never pulls or finalises it.
 */
require('dotenv').config();

const pool = require('../src/config/database');
const redis = require('../src/config/redis');
const { planRace, positionAt, rng } = require('./lib/raceSim');

const SRC_EVENT = 'evento-pipeline-test-2';  // RR 421131 test event: 3 contests, 104 athletes
const SRC_RACE = 653;
const SIM_EVENT = 'race-sim';
const SIM_RR_ID = 9990001;                   // not a real RaceResult event
const DEV_APP = 901;
const PAGES = ['home', 'tracking', 'athletes', 'athlete', 'team', 'maps'];

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
    else { out[a.slice(2)] = next; i++; }
  }
  return out;
}

const columns = async (table) => (await pool.query(
  `SELECT column_name FROM information_schema.columns WHERE table_schema = 'v2' AND table_name = $1 AND column_name <> 'id' AND is_generated = 'NEVER' ORDER BY ordinal_position`,
  [table])).rows.map((r) => r.column_name);

/**
 * INSERT INTO v2.{table} SELECT … FROM v2.{table} WHERE {where} — every column
 * copied as-is except `set` (column → SQL expression). Returns new ids.
 */
async function copy(client, table, where, params, set) {
  const cols = await columns(table);
  if ('id' in set) cols.unshift('id'); // text ids (events) are given, serial ids are not copied
  const select = cols.map((c) => (c in set ? `${set[c]} AS ${c}` : c)).join(', ');
  const { rows } = await client.query(
    `INSERT INTO v2.${table} (${cols.join(', ')}) SELECT ${select} FROM v2.${table} WHERE ${where} RETURNING id`, params);
  return rows.map((r) => r.id);
}

async function simRace() {
  const { rows } = await pool.query('SELECT id, rr_raceid, time_zone, rr_list_name, rr_splits_url FROM v2.races WHERE event_id = $1', [SIM_EVENT]);
  if (!rows.length) throw new Error(`no ${SIM_EVENT} race — run: node scripts/race-sim.js setup`);
  const race = rows[0];
  // Belt and braces: a feed would make the scheduler pull over the sim.
  if (race.rr_list_name || race.rr_splits_url) throw new Error(`race ${race.id} has an RR feed — refusing`);
  return race;
}

async function teardown(client) {
  await client.query(`UPDATE v2.apps SET events = (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(events) e WHERE e->>'id' <> $1) WHERE id = $2`, [SIM_EVENT, DEV_APP]);
  const { rows } = await client.query('SELECT id FROM v2.races WHERE event_id = $1', [SIM_EVENT]);
  for (const { id } of rows) {
    for (const t of ['rr_results', 'splits', 'legs', 'contests', 'athletes', 'follows', 'predictions']) {
      await client.query(`DELETE FROM v2.${t} WHERE race_id = $1`, [id]);
    }
    await client.query('DELETE FROM v2.races WHERE id = $1', [id]);
  }
  await client.query('DELETE FROM v2.events WHERE id = $1', [SIM_EVENT]); // pages + courses cascade
}

async function setup(opts) {
  const exists = (await pool.query('SELECT 1 FROM v2.events WHERE id = $1', [SIM_EVENT])).rowCount > 0;
  if (exists && !opts.rebuild) { console.log(`${SIM_EVENT} already set up (use --rebuild to re-clone)`); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (exists) await teardown(client);
    await copy(client, 'events', 'id = $1', [SRC_EVENT, SIM_EVENT],
      { id: '$2', event_json: `event_json || '{"name":"Race Sim","nav":[{"id":"tracking","icon":"tracking","page":"tracking","title":"Tracking","screen":"page"},{"id":"athletes","icon":"athletes","page":"athletes","title":"Athletes","screen":"page"}]}'::jsonb` });
    await copy(client, 'pages', 'event_id = $1 AND slug = ANY($2)', [SRC_EVENT, PAGES, SIM_EVENT], { event_id: '$3' });
    const courseMap = {};
    for (const { id } of (await client.query('SELECT id FROM v2.courses WHERE event_id = $1', [SRC_EVENT])).rows) {
      const [newId] = await copy(client, 'courses', 'id = $1', [id, SIM_EVENT], { event_id: '$2' });
      courseMap[id] = newId;
    }
    const [raceId] = await copy(client, 'races', 'id = $1', [SRC_RACE, SIM_EVENT, SIM_RR_ID], {
      event_id: '$2', rr_raceid: '$3', name: `'Race Sim'`, v1_race_id: 'NULL',
      rr_list_name: 'NULL', rr_splits_url: 'NULL', rr_simpleapi_key: 'NULL', rr_splits_hash: 'NULL', provisioned_at: 'NULL',
      live_state: `'idle'`, live_from: 'NULL', live_until: 'NULL', last_pull_at: 'NULL', last_data_at: 'NULL',
    });
    await copy(client, 'contests', 'race_id = $1', [SRC_RACE, raceId, JSON.stringify(courseMap)], {
      race_id: '$2', course_id: `($3::jsonb ->> course_id::text)::bigint`, racemap_event_id: 'NULL', racemap_poll: 'false',
    });
    for (const t of ['splits', 'legs', 'athletes']) await copy(client, t, 'race_id = $1', [SRC_RACE, raceId], { race_id: '$2' });
    const card = { id: SIM_EVENT, name: 'Race Sim', meta: 'Simulated RaceResult race', badge: 'Simulation', date: new Date().toISOString().slice(0, 10), published: true };
    await client.query(`UPDATE v2.apps SET events = jsonb_build_array($1::jsonb) || events WHERE id = $2`, [JSON.stringify(card), DEV_APP]);
    await client.query('COMMIT');
    const n = (await pool.query('SELECT count(*)::int AS n FROM v2.athletes WHERE race_id = $1', [raceId])).rows[0].n;
    console.log(`set up ${SIM_EVENT}: race ${raceId}, RR id ${SIM_RR_ID}, ${n} athletes, courses ${JSON.stringify(courseMap)}, listed first on app ${DEV_APP}`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function delKeys(pattern) {
  let cursor = '0'; let n = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
    cursor = next;
    if (keys.length) { await redis.del(...keys); n += keys.length; }
  } while (cursor !== '0');
  return n;
}

async function loadRace(race, limit) {
  const [athletes, contests, splits] = await Promise.all([
    pool.query('SELECT athlete_id, raceno, name, contest FROM v2.athletes WHERE race_id = $1 ORDER BY raceno::text', [race.id]),
    pool.query('SELECT contest_id, name, distance_km, is_tracking FROM v2.contests WHERE race_id = $1 ORDER BY sort_order, name', [race.id]),
    pool.query('SELECT contest_id, name, rr_splitid, accum_km, split_type, is_leg, sort_order FROM v2.splits WHERE race_id = $1', [race.id]),
  ]);
  return { athletes: athletes.rows.slice(0, limit || undefined), contests: contests.rows, splits: splits.rows };
}

function summary(plan, contests) {
  const by = (s) => plan.athletes.filter((a) => a.status === s).length;
  const lines = contests.map((c) => {
    const as = plan.athletes.filter((a) => a.contest_id === String(c.contest_id));
    const done = as.filter((a) => a.status === 'finished').map((a) => a.points[a.points.length - 1].at - a.points[0].at);
    const range = done.length ? `${Math.round(Math.min(...done) / 60000)}–${Math.round(Math.max(...done) / 60000)} min` : '—';
    return `  ${c.name}: ${as.length} athletes, finish times ${range}`;
  });
  const last = plan.crossings.length ? plan.crossings[plan.crossings.length - 1].at : Date.now();
  return [`${plan.athletes.length} athletes · ${plan.crossings.length} crossings · ${by('finished')} finish, ${by('dnf')} DNF, ${by('dns')} DNS`,
    ...lines, `race over at ${new Date(last).toLocaleTimeString()}`].join('\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(url, recs) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(recs) });
  if (res.status !== 202) throw new Error(`push ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json().catch(() => ({}));
  if (body.message !== 'Queued') throw new Error(`push not queued: ${JSON.stringify(body)}`);
}

/** The fake RaceMap poller: per-athlete fix keys + the field snapshot, as evento-worker writes them. */
async function writeGps(raceId, trackers, contestKm, now) {
  const rows = [];
  const m = redis.multi();
  for (const t of trackers) {
    const alive = now < t.deadAt;
    const at = alive ? now : t.deadAt;
    const pos = positionAt(t.plan, at);
    if (!pos) continue;
    const fixAt = new Date(at).toISOString();
    rows.push([t.plan.bib, pos.pct, pos.kmh, t.plan.athlete_id, t.plan.name, t.plan.contest_id, fixAt]);
    if (alive) {
      m.set(`gps:race:${raceId}:athlete:${t.plan.athlete_id}`, JSON.stringify({
        bib: t.plan.bib, pct: pos.pct, km: Number(pos.km.toFixed(1)), to_go_km: Number((t.plan.distance_km - pos.km).toFixed(1)),
        speed: pos.kmh, at: fixAt, mapped: true, contest_id: t.plan.contest_id,
      }), 'EX', 600);
    }
  }
  m.set(`gps:race:${raceId}`, JSON.stringify({ at: new Date(now).toISOString(), contests: contestKm, rows }), 'EX', 300);
  await m.exec();
  return rows.length;
}

async function run(opts) {
  const race = await simRace();
  const scale = Number(opts.scale) || 1;
  const target = String(opts.target || 'https://eventoapi.com').replace(/\/$/, '');
  const url = `${target}/v2/tracks/raceresult/${race.rr_raceid}`;
  const { athletes, contests, splits } = await loadRace(race, Number(opts.limit) || 0);
  // --join rebuilds the running race's plan from the gun time it saved.
  const saved = opts.join ? Number(await redis.get(`race-sim:gun:${race.id}`)) : 0;
  if (opts.join && !saved) throw new Error('no running race to join (race-sim:gun not set)');
  const startMs = saved || Date.now() + 20000; // gun in 20 s: time to open the map
  const seed = Number(opts.seed) || 1;
  const plan = planRace({ athletes, contests, splits, startMs, tz: race.time_zone, scale, seed });

  const rand = rng(seed + 1);
  const tracking = new Set(contests.filter((c) => c.is_tracking).map((c) => String(c.contest_id)));
  const gpsN = Number(opts.gps) || 0;
  const deadShare = Number(opts['gps-dead']) || 0;
  const bibs = opts['gps-bibs'] ? String(opts['gps-bibs']).split(',').map((b) => b.trim()) : null;
  const trackers = plan.athletes.filter((a) => a.status !== 'dns' && tracking.has(a.contest_id) && (!bibs || bibs.includes(a.bib)))
    .slice(0, bibs ? undefined : gpsN).map((p, i, all) => {
    const start = p.points[0].at; const end = p.points[p.points.length - 1].at;
    const dies = i < Math.round(all.length * deadShare);
    return { plan: p, deadAt: dies ? start + (end - start) * (0.3 + 0.4 * rand()) : Infinity };
  });
  const contestKm = Object.fromEntries(contests.filter((c) => tracking.has(String(c.contest_id))).map((c) => [String(c.contest_id), Number(c.distance_km)]));

  console.log(`Race Sim — race ${race.id}, RR ${race.rr_raceid}, ×${scale}, seed ${seed} → ${url}`);
  console.log(summary(plan, contests));
  if (trackers.length) console.log(`GPS: ${trackers.length} trackers (${trackers.filter((t) => t.deadAt < Infinity).map((t) => `#${t.plan.bib}`).join(', ') || 'none'} die mid-race)`);
  if (opts['dry-run']) return;
  if (opts.join) return gpsOnly(race, trackers, contestKm, (Number(opts['gps-every']) || 15) * 1000);

  // Reset: last run's splits, results and GPS, then Go live.
  const cleared = await delKeys(`redis_splits:${race.id}:*`) + await delKeys(`gps:race:${race.id}*`);
  await pool.query('DELETE FROM v2.rr_results WHERE race_id = $1', [race.id]);
  await pool.query(`UPDATE v2.races SET live_state = 'live', live_from = NOW(), live_until = NOW() + interval '12 hours', last_data_at = NULL WHERE id = $1`, [race.id]);
  await redis.del(`v2:tracks:rr_event:${race.rr_raceid}`); // the push route's 30 s state cache
  await redis.set(`race-sim:gun:${race.id}`, String(startMs), 'EX', 86400);
  console.log(`reset (${cleared} Redis keys), race live — gun at ${new Date(startMs).toLocaleTimeString()}`);

  let next = 0; let pushed = 0; let lastGps = 0; let lastLog = 0; let errors = 0;
  const gpsEvery = (Number(opts['gps-every']) || 15) * 1000;
  const lastAt = plan.crossings.length ? plan.crossings[plan.crossings.length - 1].at : startMs;
  const gpsUntil = trackers.length ? Math.max(...trackers.map((t) => t.plan.points[t.plan.points.length - 1].at)) + 60000 : 0;
  while (next < plan.crossings.length || Date.now() < gpsUntil) {
    const now = Date.now();
    const due = [];
    while (next < plan.crossings.length && plan.crossings[next].at <= now) due.push(plan.crossings[next++].rec);
    for (let i = 0; i < due.length; i += 200) {
      try { await post(url, due.slice(i, i + 200)); pushed += Math.min(200, due.length - i); } catch (e) { errors++; console.error(e.message); }
    }
    if (trackers.length && now - lastGps >= gpsEvery && now >= startMs) { await writeGps(race.id, trackers, contestKm, now); lastGps = now; }
    if (now - lastLog >= 15000) {
      const left = Math.max(0, Math.round((lastAt - now) / 1000));
      const alive = trackers.filter((t) => now < t.deadAt).length;
      console.log(`${new Date(now).toLocaleTimeString()}  pushed ${pushed}/${plan.crossings.length}${errors ? ` · ${errors} errors` : ''}${trackers.length ? ` · GPS ${alive}/${trackers.length} alive` : ''} · ${Math.floor(left / 60)}m${left % 60}s to go`);
      lastLog = now;
    }
    await sleep(1000);
  }
  console.log(`done: ${pushed} crossings pushed. Race left LIVE so you can look — end it with: node scripts/race-sim.js stop`);
}

/** --join: only the fake RaceMap poller, alongside a run that is already pushing crossings. */
async function gpsOnly(race, trackers, contestKm, every) {
  if (!trackers.length) throw new Error('no GPS trackers (bibs not in a tracking contest?)');
  const until = Math.max(...trackers.map((t) => t.plan.points[t.plan.points.length - 1].at)) + 60000;
  console.log(`joined race ${race.id}: GPS on ${trackers.map((t) => `#${t.plan.bib}`).join(', ')} every ${every / 1000}s`);
  while (Date.now() < until) {
    await writeGps(race.id, trackers, contestKm, Date.now());
    await sleep(every);
  }
  console.log('GPS done');
}

async function stop() {
  const race = await simRace();
  await pool.query(`UPDATE v2.races SET live_state = 'done', live_until = NOW() WHERE id = $1`, [race.id]);
  await redis.del(`v2:tracks:rr_event:${race.rr_raceid}`);
  console.log(`race ${race.id} → done`);
}

async function main() {
  const opts = args(process.argv.slice(2));
  const cmd = opts._[0];
  if (cmd === 'setup') await setup(opts);
  else if (cmd === 'run') await run(opts);
  else if (cmd === 'stop') await stop();
  else console.log('usage: node scripts/race-sim.js setup [--rebuild] | run [--scale 10] [--limit 100] [--gps 15] [--gps-dead 0.3] [--gps-bibs 2,5] [--join] [--seed 1] [--target URL] [--dry-run] | stop');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
