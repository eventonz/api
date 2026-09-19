// Ugo's data (native RaceResult push) formats durations under an hour as
// "MM:SS". Everything downstream reads HH:MM:SS, so "25:05" was read as
// 25 h 5 min (tracking showed 25:05:36). The normaliser must pad.
jest.mock('../../src/config/redis', () => ({}));
const { normaliseNativeRR, normaliseEventoRR } = require('../../src/services/normalisers/raceresult');

const raceobj = { events: [{ contest_id: 1 }] };

// Todd's record from Philly, 19 Sep 2026
const ugo = {
  Bib: 100369, ID: 7510, SplitID: 2, RR_SplitID: 16, SplitName: 'Split2', SplitLabel: '5K',
  SplitToD: '15:48:52', SplitRaceTime: '25:05', SplitGunTime: '25:52', SplitChipTime: '25:05',
  SplitOverallRank: 1, SplitGenderRank: 1, SplitAgeGroupRank: 1, SplitPace: '8:04', SplitSpeed: '7.4',
  SplitPredictedToD: '15:48:52', SplitPredictedRaceTime: '25:05', Message_en: 'x',
};

test('native RR: MM:SS durations are padded to HH:MM:SS', () => {
  const td = normaliseNativeRR(ugo, raceobj);
  expect(td.race_time).toBe('00:25:05');
  expect(td.split_chip).toBe('00:25:05');
  expect(td.predicted_race_time).toBe('00:25:05');
  expect(td.tod).toBe('15:48:52');        // time of day untouched
  expect(td.split_pace).toBe('8:04');     // pace is min/km, not a duration
});

test('native RR: H:MM:SS gets a leading zero, HH:MM:SS and empty are untouched', () => {
  expect(normaliseNativeRR({ ...ugo, SplitRaceTime: '1:02:15' }, raceobj).race_time).toBe('01:02:15');
  expect(normaliseNativeRR({ ...ugo, SplitRaceTime: '01:02:15' }, raceobj).race_time).toBe('01:02:15');
  expect(normaliseNativeRR({ ...ugo, SplitRaceTime: '' }, raceobj).race_time).toBe('');
  expect(normaliseNativeRR({ ...ugo, SplitRaceTime: '', Start: 1 }, raceobj).race_time).toBe('00:00:00');
});

test('evento exporter path is unchanged (already hh:mm:ss)', () => {
  const td = normaliseEventoRR({ bib: 1, rr_splitid: 16, race_time: '00:25:05', tod: '15:48:52', evento_created: true }, raceobj);
  expect(td.race_time).toBe('00:25:05');
});
