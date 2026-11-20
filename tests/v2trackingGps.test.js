/**
 * RaceMap GPS (docs/racemap-gps-integration.md): GET /v2/tracking/:event/gps,
 * GET /v2/tracking/:event/gps/ops and the GPS-vs-mat merge in tracking. DB + Redis mocked.
 *
 * Auth: the routes live under the `authed` wrapper in src/routes/v2/index.js
 * (install token / app key); here the module is registered bare, as the other
 * route tests do.
 */
const mockRedis = { mget: jest.fn(async () => []) };
jest.mock('../src/config/redis', () => mockRedis);
let mockOpsPin = null;
jest.mock('../src/config/database', () => ({
  query: jest.fn(async (sql, params) => {
    if (/FROM v2.races r WHERE r.event_id/.test(sql)) return { rows: params[0] === 'ghost' ? [] : [{ id: 158 }, { id: 159 }] };
    if (/SELECT ops_pin FROM v2.events/.test(sql)) return { rows: [{ ops_pin: mockOpsPin }] };
    return { rows: [] };
  }),
}));

const Fastify = require('fastify');
const { getTracksFromV2RedisSplits, renderTracks } = require('../src/services/tracking');
const { mergeGpsFixes } = require('../src/services/gps');

async function build() {
  const app = Fastify();
  await app.register(require('../src/routes/v2/tracking'), { prefix: '/v2/tracking' });
  return app;
}

const snap158 = { at: '2026-11-16T08:41:07Z', contests: { 4: 63 }, rows: [['412', 23.4, 18.2, '9001', 'Die Bummler', '4']] };
const snap159 = { at: '2026-11-16T08:41:30Z', contests: { 7: 40 }, rows: [['57', 10.1, 15.0, null, 'Unknown', '7']] };

beforeEach(() => { mockRedis.mget.mockReset(); mockRedis.mget.mockResolvedValue([]); mockOpsPin = null; delete process.env.GPS_MAX_AGE_S; });

// ---------------------------------------------------------------- /gps

test('/gps is 404 "No GPS feed" when no race has a snapshot (hides the Field button)', async () => {
  const app = await build();
  mockRedis.mget.mockResolvedValue([null, null]);
  const res = await app.inject({ method: 'GET', url: '/v2/tracking/epic-2026/gps' });
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ error: 'No GPS feed' });
  expect(mockRedis.mget).toHaveBeenCalledWith(['gps:race:158', 'gps:race:159']);
  const none = await app.inject({ method: 'GET', url: '/v2/tracking/ghost/gps' });
  expect(none.statusCode).toBe(404);
  await app.close();
});

test('/gps is 404 when the feed has no riders (only ops vehicles) — no GPS button', async () => {
  const app = await build();
  mockRedis.mget.mockResolvedValue([JSON.stringify({ ...snap158, rows: [] }), null]);
  const res = await app.inject({ method: 'GET', url: '/v2/tracking/epic-2026/gps' });
  expect(res.statusCode).toBe(404);
  await app.close();
});

test('/gps merges the races into one body with ETag + 10 s cache, and 304s on a matching ETag', async () => {
  const app = await build();
  mockRedis.mget.mockResolvedValue([JSON.stringify(snap158), JSON.stringify(snap159)]);
  const res = await app.inject({ method: 'GET', url: '/v2/tracking/epic-2026/gps' });
  expect(res.statusCode).toBe(200);
  expect(res.headers['cache-control']).toBe('public, max-age=10');
  expect(res.headers.etag).toMatch(/^"[0-9a-f]{32}"$/);
  expect(res.json()).toEqual({ at: '2026-11-16T08:41:30Z', contests: { 4: 63, 7: 40 }, rows: [...snap158.rows, ...snap159.rows] });
  const again = await app.inject({ method: 'GET', url: '/v2/tracking/epic-2026/gps', headers: { 'if-none-match': res.headers.etag } });
  expect(again.statusCode).toBe(304);
  expect(again.body).toBe('');
  await app.close();
});

// ---------------------------------------------------------------- /gps/ops

test('/gps/ops is 403 "PIN required" without a pin, with the wrong pin, and when the event has no pin', async () => {
  const app = await build();
  mockOpsPin = '4821';
  for (const url of ['/v2/tracking/epic-2026/gps/ops', '/v2/tracking/epic-2026/gps/ops?pin=0000']) {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'PIN required' });
  }
  mockOpsPin = null;
  const res = await app.inject({ method: 'GET', url: '/v2/tracking/epic-2026/gps/ops', headers: { 'x-ops-pin': '4821' } });
  expect(res.statusCode).toBe(403);
  expect(res.json()).toEqual({ error: 'PIN required' });
  expect(res.headers['cache-control']).toBe('no-store');
  expect(mockRedis.mget).not.toHaveBeenCalled();
  await app.close();
});

test('/gps/ops with the right pin (header or query) returns the merged ops rows, 404 when the feed is empty', async () => {
  const app = await build();
  mockOpsPin = '4821';
  const ops = { at: '2026-11-16T08:40:58Z', rows: [{ callsign: 'Sweep 2', kind: 'sweep', lat: -33.91, lng: 18.42, speed: 41, pct: 23.4, km: 23.2, seen: '2026-11-16T08:40:58Z', online: true }] };
  mockRedis.mget.mockResolvedValue([JSON.stringify(ops), null]);
  const res = await app.inject({ method: 'GET', url: '/v2/tracking/epic-2026/gps/ops', headers: { 'x-ops-pin': '4821' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual(ops);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(mockRedis.mget).toHaveBeenCalledWith(['gps:race:158:ops', 'gps:race:159:ops']);
  const q = await app.inject({ method: 'GET', url: '/v2/tracking/epic-2026/gps/ops?pin=4821' });
  expect(q.statusCode).toBe(200);
  mockRedis.mget.mockResolvedValue([null, null]);
  const empty = await app.inject({ method: 'GET', url: '/v2/tracking/epic-2026/gps/ops?pin=4821' });
  expect(empty.statusCode).toBe(404);
  expect(empty.json()).toEqual({ error: 'No ops feed' });
  await app.close();
});

// ---------------------------------------------------------------- GPS-vs-mat merge

// Stage 3: 63 km, WP2 at 36 km. Rider crossed WP2 at 16 km/h.
const contest = (extra) => ({ contest_id: '4', event_descr: 'Stage 3', distance: 63, is_tracking: true, use_tracking_path: '4', ...extra, splits: [
  { rr_splitid: 4008, name: 'Start', split_distance: 0 }, { rr_splitid: 4004, name: 'WP2', split_distance: 36, default_spd: 16 },
  { rr_splitid: 4005, name: 'WP3', split_distance: 54 }, { rr_splitid: 4001, name: 'Finish', split_distance: 63 }] });
const iso = (secsAgo) => new Date(Date.now() - secsAgo * 1000).toISOString();

async function merge({ matAgoSecs = 600, fix, ids = ['255'], raceobj = { events: [contest()] }, withSplits = true } = {}) {
  const splitsDoc = withSplits ? JSON.stringify({ bib: 255, splits: [
    { rr_id: 4008, tod: '08:00:00', time: '00:00:00' },
    { rr_id: 4004, tod: '10:15:00', time: '02:15:00', speed: 16, pushed_at: iso(matAgoSecs) }] }) : null;
  mockRedis.mget.mockResolvedValueOnce([splitsDoc]);
  mockRedis.mget.mockResolvedValueOnce([fix ? JSON.stringify(fix) : null]);
  const latest = await getTracksFromV2RedisSplits(ids, 158, raceobj, null);
  const merged = await mergeGpsFixes({ latest, trackIds: ids, v2RaceId: 158, raceobj, tz: 'UTC' });
  return { merged, tracks: renderTracks(merged, raceobj, 'UTC') };
}

const fixAt = (secsAgo, extra = {}) => ({ bib: '255', pct: 65.08, km: 41, to_go_km: 22, speed: 20, at: iso(secsAgo), mapped: true, lat: -33.9, lng: 18.4, contest_id: '4', ...extra });

test('a GPS fix newer than the last mat re-anchors the marker: position + speed from GPS, isgps', async () => {
  const { merged, tracks } = await merge({ matAgoSecs: 600, fix: fixAt(60) });
  expect(mockRedis.mget).toHaveBeenLastCalledWith(['gps:race:158:athlete:255']);
  expect(merged[0]).toMatchObject({ isgps: true, splitname: 'GPS', percent_course: 65.08, distance: 41, speed: 20 });
  const t = tracks[0];
  expect(t.speed).toBe(20);
  // 60 s at 20 km/h ≈ 0.33 km past the 41 km fix
  expect(t.location).toBeCloseTo((41 + 20 / 60) / 63 * 100, 1);
  expect(t.info).toMatch(/^GPS Update, GPS @ \d\d:\d\d/);
  expect(t.info).toContain('Speed: 20 km/h');
  expect(t).toMatchObject({ status: 'gps', split_name: 'GPS', predicted: false });
  expect(t.split_tod).toMatch(/^\d\d:\d\d$/);
});

test('a GPS fix older than the last mat crossing is ignored', async () => {
  const { merged, tracks } = await merge({ matAgoSecs: 60, fix: fixAt(600) });
  expect(merged[0].isgps).toBe(false);
  expect(merged[0].percent_course).toBeCloseTo(36 / 63 * 100, 1);
  expect(tracks[0].info).toMatch(/^Last Timing Split, WP2/);
  expect(tracks[0].speed).toBe(16);
  // Structured status for the app's 3-line card: 60 s past WP2 at 16 km/h is a prediction.
  expect(tracks[0]).toMatchObject({ status: 'split', split_name: 'WP2', predicted: true });
});

test('a GPS fix older than GPS_MAX_AGE_S is ignored even with no newer mat', async () => {
  process.env.GPS_MAX_AGE_S = '120';
  const { merged } = await merge({ matAgoSecs: 3600, fix: fixAt(300) });
  expect(merged[0].isgps).toBe(false);
  delete process.env.GPS_MAX_AGE_S;
  const fresh = await merge({ matAgoSecs: 3600, fix: fixAt(300) });
  expect(fresh.merged[0].isgps).toBe(true); // default 600 s
});

test('an athlete with a GPS fix but no splits record gets a track on the fix contest', async () => {
  const { merged, tracks } = await merge({ withSplits: false, fix: fixAt(30) });
  expect(merged).toHaveLength(1);
  expect(merged[0]).toMatchObject({ athlete_id: '255', raceNo: '255', contest_id: '4', use_tracking_path: '4', isgps: true, course_distance: 63 });
  expect(tracks[0].path).toBe('p_4');
  expect(tracks[0].location).toBeGreaterThan(65);
  // Unknown contest → no track (nothing to place it on).
  const none = await merge({ withSplits: false, fix: fixAt(30, { contest_id: '99' }) });
  expect(none.merged).toHaveLength(0);
});

test('no fixes at all costs one MGET and changes nothing; a GPS-anchored track skips field prediction but keeps the await cap', async () => {
  const plain = await merge({ fix: null });
  expect(plain.merged[0].isgps).toBe(false);
  // Field prediction on with a ready table: the GPS speed still wins, and the
  // marker holds at WP3 (next mat after the fix) rather than overrunning it.
  const segments = [{ from_id: 4004, to_id: 4005, km: 18, ratio: 0.5, ready: true }];
  const raceobj = { events: [contest({ field_prediction: true, await_at_next_split: true })], field_ratios: { 4: segments } };
  // 500 s at 100 km/h would run 14 km past the 50.4 km fix — WP3 (54 km) holds it.
  const { tracks } = await merge({ raceobj, fix: fixAt(500, { pct: 80, km: 50.4, speed: 100 }) });
  expect(tracks[0].location).toBeCloseTo(54 / 63 * 100, 1);
  expect(tracks[0].info).toBe('Awaiting Update');
  const quick = await merge({ raceobj, fix: fixAt(10, { pct: 80, km: 50.4 }) });
  expect(quick.tracks[0].speed).toBe(20); // GPS speed, not own pace × 0.5
});
