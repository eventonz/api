/**
 * Once a race is finalised the athlete page is built from v2.rr_results
 * (buildFromV2Config), not Redis. Legs are stored there like any other RR
 * timing point, keyed on the leg's rr_legid — they must come back on that
 * path too (Hobsons Bay Run report, 27 Oct 2026: legs vanished after live).
 */
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/config/redis', () => ({ get: jest.fn(), scan: jest.fn() }));
const { legsFromResults } = require('../src/routes/v2/splits');
const athleteDetailV2 = require('../src/services/splits/athleteDetailV2');
const { buildHeader } = require('../src/services/splits/buildHeader');

const evt = {
  contest_id: '1', event_descr: 'Olympic Tri', distance: 51.5,
  splits: [{ id: 1, rr_splitid: 100, name: 'Finish', order: 0, visible: 1, split_type: 'finish' }],
  legs: [
    { id: 11, rr_splitid: 501, label: 'Swim', icon: 'swim', speed_type: 'pace_100m', distance: 1.5 },
    { id: 12, rr_splitid: 502, label: 'Bike', icon: 'bike', speed_type: 'speed_kmh', distance: 40 },
    { id: 13, rr_splitid: 0,   label: 'Run',  icon: 'run',  speed_type: 'pace_km',   distance: 10 },
  ],
};

// rr_results rows for the athlete, keyed by rr_splitid (what buildFromV2Config builds)
const byRr = new Map([
  ['100', { rr_splitid: 100, split_tod: '09:12:10', split_gun: '02:12:10', splitpace: '', splitspeed: '' }],
  ['501', { rr_splitid: 501, split_tod: '07:28:30', split_gun: '00:28:30', splitpace: '1:54', splitspeed: '' }],
  ['502', { rr_splitid: 502, split_tod: '08:40:00', split_gun: '01:09:30', splitpace: '', splitspeed: '34.5' }],
]);

test('every configured leg comes back, with the rr_results time where the athlete has one', () => {
  const legs = legsFromResults(evt, byRr);
  expect(legs.map((l) => l.label)).toEqual(['Swim', 'Bike', 'Run']);
  expect(legs[0]).toMatchObject({ leg_result: '00:28:30', leg_pace: '1:54', pace_minkm: '1:54', speed_type: 'pace_100m', distance: 1.5 });
  expect(legs[1]).toMatchObject({ leg_result: '01:09:30', leg_pace: '34.5', speed_kmh: '34.5' });
  expect(legs[2]).toMatchObject({ leg_result: '', leg_pace: '' });   // no rr id → never matched
});

test('no configured legs → empty list (nothing to render)', () => {
  expect(legsFromResults({ ...evt, legs: [] }, byRr)).toEqual([]);
  expect(legsFromResults({}, byRr)).toEqual([]);
});

test('the rendered document carries a Legs section on the finalised path', () => {
  const livetiming = {
    contest_id: '1', contest_name: 'Olympic Tri', contest_distance: 51.5, finish_status: 4,
    result: '02:12:10', overall_place: '12', overall_gen_place: '10', overall_cat_place: '3',
    avg_pace: '', showPace: true, showRank: true,
    splits: [{ id: 1, RaceTime: '02:12:10', tod: '09:12:10', split_pace: '', split_speed: '',
               overall_place: '12', gen_place: '10', cat_place: '3' }],
    legs: legsFromResults(evt, byRr),
  };
  const raceobj = { timezone: 'Australia/Melbourne', events: [evt] };
  const header = buildHeader(livetiming, raceobj, { bib: '7', athleteId: '7', contest: '1' });
  const doc = athleteDetailV2.build(livetiming, raceobj, {}, header);
  const items = doc.version2.items;
  const title = items.findIndex((i) => i.type === 'title' && i.data?.label === 'Legs');
  expect(title).toBeGreaterThan(-1);
  const text = JSON.stringify(items.slice(title + 1));
  expect(text).toContain('Swim');
  expect(text).toContain('Bike');
});
