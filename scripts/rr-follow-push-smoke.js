/**
 * Offline smoke test for the rr_follow_push endpoint.
 *
 * Stubs Postgres (the atomic-claim UPDATE), Redis (athlete_push_queue), and the
 * race-config lookup, then drives the real route via Fastify `inject` to verify:
 *   1. non-finish crossings are ignored (no enqueue)
 *   2. a finish enqueues once, with include_player_ids resolved
 *   3. a replayed finish is deduped (claim returns 0 rows → no second enqueue)
 *   4. stale finishes (>5 min old tod) are suppressed
 *
 * Run: node scripts/rr-follow-push-smoke.js
 */

const Module = require('module');
const assert = require('assert');

// --- in-memory fakes -------------------------------------------------------
const enqueued = [];
const fakeRedis = { rpush: async (_k, v) => { enqueued.push(JSON.parse(v)); return 1; } };

// `notified` per (rr_eventid, athlete_id); the claim flips false→true once.
const notified = new Set();
const fakePool = {
  query: async (sql, params) => {
    if (/UPDATE rr_follows SET notified/.test(sql)) {
      const key = `${params[0]}:${params[1]}`;
      if (notified.has(key)) return { rows: [] };   // already notified → deduped
      notified.add(key);
      return { rows: [{ player_id: 'os-player-1' }, { player_id: 'os-player-2' }] };
    }
    return { rows: [] };
  },
};

const fakeRaceConfig = {
  raceconfigByRaceResult: async () => ({
    r_id: 42,
    race_name: 'Smoke Test Race',
    timezone: 'Pacific/Auckland',
    onesignal_id: 'app-id',
    onesignal_restkey: 'rest-key',
    live_test_mode: false,
  }),
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (/config[\\/]redis$/.test(request)) return fakeRedis;
  if (/config[\\/]database$/.test(request)) return fakePool;
  if (/services[\\/]raceConfig$/.test(request)) return fakeRaceConfig;
  return origLoad.call(this, request, parent, isMain);
};

const Fastify = require('fastify');
const rrFollowPush = require('../src/routes/v1/rr_follow_push');

// Current time-of-day in the race tz, so the staleness guard sees it as fresh.
function nowTod() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Pacific/Auckland', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date());
}

(async () => {
  const app = Fastify();
  await app.register(rrFollowPush, { prefix: '/v1/rr_follow_push' });
  await app.ready();

  let passed = 0;
  const check = (name, cond) => { assert(cond, `FAILED: ${name}`); console.log(`ok   ${name}`); passed++; };

  const post = (body) => app.inject({ method: 'POST', url: '/v1/rr_follow_push/369231', payload: body });

  // 1. non-finish → ignored
  let r = await post({ athlete_id: '19928', finish: 0, start: 0, tod: nowTod() });
  check('non-finish ignored (202, no enqueue)', r.statusCode === 202 && enqueued.length === 0);

  // 2. fresh finish → one enqueue with both player ids + finish message
  r = await post({ athlete_id: '19928', firstname: 'Jane', lastname: 'Smith', finish: 1, race_time: '1:49:58', tod: nowTod() });
  const e = enqueued[0];
  check('finish enqueued once', r.statusCode === 202 && enqueued.length === 1);
  check('include_player_ids resolved', e && e.include_player_ids.length === 2);
  check('title (heading) = event name', e && e.headings && e.headings.en === 'Smoke Test Race');
  check('body translated en/fr/es/de', e && e.contents &&
    e.contents.en === 'Jane Smith has finished in a time of 1:49:58 (Provisional)' &&
    e.contents.fr.includes('a terminé') && e.contents.es.includes('ha terminado') &&
    e.contents.de.includes('Ziel erreicht'));
  check('race_id resolved from config', e && e.race_id === 42);

  // 3. replayed finish → deduped (no new enqueue)
  r = await post({ athlete_id: '19928', firstname: 'Jane', lastname: 'Smith', finish: 1, race_time: '1:49:58', tod: nowTod() });
  check('replayed finish deduped (still 1 enqueued)', r.statusCode === 202 && enqueued.length === 1);

  // 4. stale finish (tod hours ago) → suppressed
  r = await post({ athlete_id: '55555', firstname: 'Old', lastname: 'Timer', finish: 1, race_time: '3:00:00', tod: '01:00:00' });
  check('stale finish suppressed (still 1 enqueued)', r.statusCode === 202 && enqueued.length === 1);

  await app.close();
  console.log(`\n${passed} checks passed`);
  process.exit(0);
})().catch((err) => { console.error(err.message); process.exit(1); });
