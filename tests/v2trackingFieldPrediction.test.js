/** Field-based prediction in renderTracks: on only with the contest flag + a ready ratio table; otherwise the old method. */
const mockRedis = { mget: jest.fn() };
jest.mock('../src/config/redis', () => mockRedis);
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
const { getTracksFromV2RedisSplits, renderTracks, loadFieldRatios } = require('../src/services/tracking');

// Stage 3: 63 km, WP2 at 36, WP3 at 54. Rider crossed WP2 ten minutes ago at
// 16 km/h previous-segment speed; the field says the climb rides at 0.68.
const contest = (extra) => ({ contest_id: '4', event_descr: 'Stage 3', distance: 63, is_tracking: true, ...extra, splits: [
  { rr_splitid: 4008, name: 'Start', split_distance: 0 }, { rr_splitid: 4004, name: 'WP2', split_distance: 36, default_spd: 16 },
  { rr_splitid: 4005, name: 'WP3', split_distance: 54 }, { rr_splitid: 4001, name: 'Finish', split_distance: 63 }] });
const segments = [
  { from: 'Start', to: 'WP2', from_id: 4008, to_id: 4004, km: 36, ratio: null, spread: null, n: 0, ready: false },
  { from: 'WP2', to: 'WP3', from_id: 4004, to_id: 4005, km: 18, ratio: 0.68, spread: 0.1, n: 120, ready: true },
  { from: 'WP3', to: 'Finish', from_id: 4005, to_id: 4001, km: 9, ratio: null, spread: null, n: 3, ready: false },
];
const nowSecs = () => { const d = new Date(); return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds(); };
const hms = (s) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

async function render(flag, ratios, minsSinceWp2 = 10) {
  const now = nowSecs();
  if (now < 3 * 3600) return null; // avoid the midnight wrap in a late-night test run
  const wp2 = now - minsSinceWp2 * 60;
  const start = wp2 - 36 / 16 * 3600; // 16 km/h to WP2 → own pace 16
  mockRedis.mget.mockResolvedValue([JSON.stringify({ bib: 255, splits: [
    { rr_id: 4008, tod: hms(start), time: '00:00:00' }, { rr_id: 4004, tod: hms(wp2), time: '02:15:00' }] })]);
  const raceobj = { events: [contest({ field_prediction: flag })], field_ratios: ratios };
  const latest = await getTracksFromV2RedisSplits(['255'], 158, raceobj, null);
  return renderTracks(latest, raceobj, 'UTC')[0];
}

afterEach(() => { delete process.env.TRACKING_FIELD_PREDICTION; });

test('flag on + ready table: speed is own pace × ratio and the marker moves at that rate', async () => {
  const t = await render(true, { 4: segments }); if (!t) return;
  expect(t.speed).toBeCloseTo(16 * 0.68, 1);
  // 10 min at 10.9 km/h ≈ 1.8 km past WP2 (36 km of 63)
  expect(t.location).toBeCloseTo((36 + 10.88 / 6) / 63 * 100, 0);
});

test('flag off, no table, or kill switch: previous-segment speed as before', async () => {
  const a = await render(false, { 4: segments }); if (!a) return;
  expect(a.speed).toBe(16);
  const b = await render(true, {}); expect(b.speed).toBe(16);
  process.env.TRACKING_FIELD_PREDICTION = 'off';
  const c = await render(true, { 4: segments }); expect(c.speed).toBe(16);
});

test('a field prediction never runs past the next mat: holds at WP3 awaiting the read', async () => {
  const t = await render(true, { 4: segments }, 180); if (!t) return;
  expect(t.location).toBeCloseTo(54 / 63 * 100, 1);
  expect(t.info).toBe('Awaiting Update');
  const old = await render(false, { 4: segments }, 180);
  expect(old.location).toBe(100); // the old method ran them to the finish
});

test('a corrupt table in Redis falls back silently', async () => {
  const t = await render(true, { 4: 'garbage' }); if (!t) return;
  expect(t.speed).toBe(16);
});

test('loadFieldRatios reads only flagged tracked contests and survives bad JSON', async () => {
  mockRedis.mget.mockResolvedValue([JSON.stringify({ segments }), '{not json']);
  const raceobj = { events: [contest({ field_prediction: true }), { contest_id: '7', field_prediction: true, is_tracking: true, splits: [] },
    { contest_id: '1', field_prediction: false, is_tracking: true, splits: [] }] };
  const out = await loadFieldRatios(158, raceobj, null);
  expect(mockRedis.mget).toHaveBeenLastCalledWith(['tracking_ratios:158:4', 'tracking_ratios:158:7']);
  expect(Object.keys(out)).toEqual(['4']);
  expect(await loadFieldRatios(158, raceobj, new Set(['1']))).toEqual({});
  mockRedis.mget.mockRejectedValue(new Error('redis down'));
  expect(await loadFieldRatios(158, raceobj, null)).toEqual({});
});
