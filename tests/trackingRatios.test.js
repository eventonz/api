const { computeSegmentRatios, expectedNextMat, matsFromContest, todSecs } = require('../src/services/trackingRatios');

// Stage with a flat 36 km then an 18 km climb, like Pinotage Stage 3.
const MATS = [
  { rr_splitid: 4008, km: 0, name: 'Start' },
  { rr_splitid: 4004, km: 36, name: 'WP2' },
  { rr_splitid: 4005, km: 54, name: 'WP3' },
  { rr_splitid: 4001, km: 63, name: 'Finish' },
];
const hms = (s) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// A team riding `flatKmh` to WP2 then `flatKmh * climbRatio` to WP3.
function team(flatKmh, climbRatio, start = 7 * 3600 + 35 * 60, throughWp3 = true) {
  const atWp2 = start + 36 / flatKmh * 3600;
  const atWp3 = atWp2 + 18 / (flatKmh * climbRatio) * 3600;
  const recs = [{ rr_id: 4008, tod: hms(start) }, { rr_id: 4004, tod: hms(atWp2) }];
  if (throughWp3) recs.push({ rr_id: 4005, tod: hms(atWp3) });
  return recs;
}

test('elites and back markers give the same ratio: the climb, not their speed', () => {
  const field = [];
  for (let i = 0; i < 25; i++) field.push(team(24 - i * 0.5, 0.70)); // fast teams
  for (let i = 0; i < 25; i++) field.push(team(11 + i * 0.1, 0.70)); // slow teams
  const table = computeSegmentRatios(MATS, field);
  expect(table.map((s) => s.to)).toEqual(['WP2', 'WP3', 'Finish']);
  expect(table[0].ratio).toBeNull();                 // Start → first mat: no prior pace, never a ratio
  expect(table[0].ready).toBe(false);
  expect(table[1].ready).toBe(true);
  expect(table[1].n).toBe(50);
  expect(table[1].ratio).toBeCloseTo(0.70, 2);
  expect(table[1].spread).toBeLessThan(0.02);
  expect(table[2].ready).toBe(false);                // nobody has finished
  expect(table[2].n).toBe(0);
});

test('a segment is not ready below 20 teams through its far mat', () => {
  const field = [];
  for (let i = 0; i < 19; i++) field.push(team(20 - i * 0.2, 0.7));
  for (let i = 0; i < 40; i++) field.push(team(16, 0.7, undefined, false)); // still on the climb
  const table = computeSegmentRatios(MATS, field);
  expect(table[1]).toMatchObject({ n: 19, ready: false, ratio: null });
  field.push(team(15, 0.7));
  expect(computeSegmentRatios(MATS, field)[1]).toMatchObject({ n: 20, ready: true });
});

test('a mid-pack team still on the climb is predicted from its own pace × the field ratio', () => {
  const field = [];
  for (let i = 0; i < 30; i++) field.push(team(22 - i * 0.2, 0.68));
  const table = computeSegmentRatios(MATS, field);
  const rider = team(16.2, 0.68, undefined, false); // 36 km in 2:13:20
  const p = expectedNextMat(table, rider, 4008);
  expect(p.segment).toBe('WP2 → WP3');
  expect(p.own_kmh).toBeCloseTo(16.2, 1);
  expect(p.expected_kmh).toBeCloseTo(11.0, 1);
  const wp2 = todSecs(rider[1].tod);
  expect(p.expected_tod_secs - wp2).toBeCloseTo(18 / (16.2 * 0.68) * 3600, 0);
  expect(p.earliest_tod_secs).toBeLessThanOrEqual(p.expected_tod_secs);
  expect(p.latest_tod_secs).toBeGreaterThanOrEqual(p.expected_tod_secs);
});

test('before the first mat, or with no ready ratio → null, so the caller keeps the old method', () => {
  const field = [];
  for (let i = 0; i < 30; i++) field.push(team(22 - i * 0.2, 0.68));
  const table = computeSegmentRatios(MATS, field);
  // Started, no mat yet: on the Start → WP2 segment, which never has a ratio.
  expect(expectedNextMat(table, [{ rr_id: 4008, tod: '07:35:00' }], 4008)).toBeNull();
  // Thin field: WP2 → WP3 not ready.
  expect(expectedNextMat(computeSegmentRatios(MATS, [team(20, 0.7)]), team(16, 0.7, undefined, false), 4008)).toBeNull();
  expect(expectedNextMat(table, [], 4008)).toBeNull();
  expect(computeSegmentRatios([], [])).toEqual([]);
});

test('mats come from a raceobj contest in course order, legs and unkeyed splits skipped', () => {
  const contest = { splits: [
    { rr_splitid: 4001, split_distance: 63, order: 5, name: 'Finish' },
    { rr_splitid: 4008, split_distance: 0, order: 0, name: 'Start' },
    { rr_splitid: 0, split_distance: 10, order: 1, name: 'unkeyed' },
    { rr_splitid: 4004, split_distance: 36, order: 3, name: 'WP2', is_leg: false },
    { rr_splitid: 9999, split_distance: 20, order: 2, name: 'leg', is_leg: true },
  ] };
  expect(matsFromContest(contest).map((m) => m.name)).toEqual(['Start', 'WP2', 'Finish']);
  expect(todSecs('07:35:00')).toBe(27300);
  expect(todSecs('bad')).toBeNull();
});

describe('fieldSpeed guards — anything doubtful → null, the old method runs', () => {
  const { fieldSpeed, KMH_MIN, KMH_MAX } = require('../src/services/trackingRatios');
  const field = []; for (let i = 0; i < 30; i++) field.push(team(22 - i * 0.2, 0.68));
  const table = computeSegmentRatios(MATS, field);
  const rider = team(16.2, 0.68, undefined, false); // on the WP2 → WP3 climb

  test('a good table gives own pace × ratio', () => {
    const f = fieldSpeed(table, rider, 4008);
    expect(f.segment).toBe('WP2 → WP3');
    expect(f.kmh).toBeCloseTo(11.0, 1);
  });
  test('garbage tables', () => {
    expect(fieldSpeed(null, rider, 4008)).toBeNull();
    expect(fieldSpeed('nope', rider, 4008)).toBeNull();
    expect(fieldSpeed([], rider, 4008)).toBeNull();
    expect(fieldSpeed([{ bad: true }], rider, 4008)).toBeNull();
    expect(fieldSpeed(table.map((s) => ({ ...s, ratio: 'abc' })), rider, 4008)).toBeNull();
    expect(fieldSpeed(table.map((s) => ({ ...s, km: 0 })), rider, 4008)).toBeNull();
  });
  test('ratio outside 0.3–3.0, spread over 50 %, or thin field', () => {
    const tweak = (patch) => table.map((s) => (s.to === 'WP3' ? { ...s, ...patch } : s));
    expect(fieldSpeed(tweak({ ratio: 0.2 }), rider, 4008)).toBeNull();
    expect(fieldSpeed(tweak({ ratio: 3.5 }), rider, 4008)).toBeNull();
    // A doubled speed after a neutralised opener is real (Shiraz Stage 1).
    expect(fieldSpeed(tweak({ ratio: 2.04 }), rider, 4008)).not.toBeNull();
    expect(fieldSpeed(tweak({ spread: 0.6 }), rider, 4008)).toBeNull();
    expect(fieldSpeed(tweak({ n: 5 }), rider, 4008)).toBeNull();
    expect(fieldSpeed(tweak({ ready: false, ratio: null }), rider, 4008)).toBeNull();
  });
  test('speed is clamped to a plausible range', () => {
    const tweak = (patch) => table.map((s) => (s.to === 'WP3' ? { ...s, ...patch } : s));
    expect(fieldSpeed(tweak({ ratio: 0.3 }), team(5, 0.3, undefined, false), 4008).kmh).toBe(KMH_MIN);
    expect(fieldSpeed(tweak({ ratio: 2 }), team(40, 2, undefined, false), 4008).kmh).toBe(KMH_MAX);
  });
  test('garbage rider records', () => {
    expect(fieldSpeed(table, null, 4008)).toBeNull();
    expect(fieldSpeed(table, [{ rr_id: 'x', tod: 42 }], 4008)).toBeNull();
    expect(fieldSpeed(table, rider, 0)).toBeNull();
    expect(fieldSpeed(table, [{ rr_id: 4008, tod: '07:35:00' }], 4008)).toBeNull(); // before first mat
  });
});
