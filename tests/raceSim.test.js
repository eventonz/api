/** Race simulator plan (scripts/lib/raceSim.js): crossings a RaceResult box would push. */
const { planRace, positionAt } = require('../scripts/lib/raceSim');

const contests = [{ contest_id: 1, distance_km: 10 }, { contest_id: 2, distance_km: 5 }];
const splits = [
  { contest_id: 1, name: 'Start', rr_splitid: 1, accum_km: 0, split_type: 'start', sort_order: 1 },
  { contest_id: 1, name: '5K', rr_splitid: 2, accum_km: 5, split_type: 'checkpoint', sort_order: 2 },
  { contest_id: 1, name: 'Finish', rr_splitid: 3, accum_km: 10, split_type: 'finish', sort_order: 3 },
  { contest_id: 2, name: 'Start', rr_splitid: 4, accum_km: 0, split_type: 'start', sort_order: 1 },
  { contest_id: 2, name: 'Finish', rr_splitid: 5, accum_km: 5, split_type: 'finish', sort_order: 2 },
];
const athletes = Array.from({ length: 40 }, (_, i) => ({ athlete_id: String(100 + i), raceno: String(i + 1), name: `Runner Number${i}`, contest: i % 2 ? 2 : 1 }));
const startMs = Date.UTC(2026, 10, 21, 20, 0, 0); // 09:00 NZDT
const base = { athletes, contests, splits, startMs, tz: 'Pacific/Auckland', dnsRate: 0, dnfRate: 0, missRate: 0 };

test('every athlete crosses every mat in order, as exporter structs the worker accepts', () => {
  const { crossings, athletes: planned } = planRace(base);
  expect(crossings).toHaveLength(20 * 3 + 20 * 2);
  expect(planned.every((a) => a.status === 'finished')).toBe(true);
  for (let i = 1; i < crossings.length; i++) expect(crossings[i].at).toBeGreaterThanOrEqual(crossings[i - 1].at);

  const start = crossings.find((c) => c.rec.start === 1).rec;
  expect(start).toMatchObject({ evento_created: true, race_time: '', split_speed: '' });
  expect(start.tod.startsWith('09:0')).toBe(true); // race-local wall clock
  // The fields evento-worker's raceresult normaliser reads.
  expect(Object.keys(start).sort()).toEqual(['athlete_id', 'bib', 'contestid', 'evento_created', 'finish', 'firstname', 'lastname',
    'race_time', 'rr_splitid', 'split_name', 'split_speed', 'start', 'tod'].sort());
  expect(start.rr_splitid).toBeGreaterThan(0);

  const fin = crossings.find((c) => c.rec.finish === 1 && c.rec.contestid === 1).rec;
  const [h, m] = fin.race_time.split(':').map(Number);
  expect(h * 60 + m).toBeGreaterThanOrEqual(38);   // 10 km at 8–15 km/h
  expect(h * 60 + m).toBeLessThanOrEqual(80);
  expect(fin.split_speed).toBeGreaterThan(6);
});

test('scale makes athletes faster but keeps race_time = real elapsed time', () => {
  const { crossings } = planRace({ ...base, scale: 10 });
  const one = crossings.filter((c) => c.athlete_id === '100');
  const elapsedS = (one[2].at - one[0].at) / 1000;
  const [h, m, s] = one[2].rec.race_time.split(':').map(Number);
  expect(Math.abs(h * 3600 + m * 60 + s - elapsedS)).toBeLessThanOrEqual(1);
  expect(elapsedS).toBeLessThan(8 * 60);
});

test('same seed = same race; DNS, DNF and missed mats drop crossings', () => {
  expect(planRace({ ...base, seed: 7 }).crossings).toEqual(planRace({ ...base, seed: 7 }).crossings);
  const rough = planRace({ ...base, seed: 3, dnsRate: 0.2, dnfRate: 0.2, missRate: 0.2 });
  const st = (s) => rough.athletes.filter((a) => a.status === s).length;
  expect(st('dns')).toBeGreaterThan(0);
  expect(st('dnf')).toBeGreaterThan(0);
  expect(rough.crossings.length).toBeLessThan(100);
  for (const a of rough.athletes.filter((x) => x.status === 'dns')) expect(rough.crossings.some((c) => c.athlete_id === a.athlete_id)).toBe(false);
});

test('positionAt interpolates between mats and parks at the finish', () => {
  const { athletes: planned } = planRace(base);
  const a = planned[0];
  expect(positionAt(a, a.points[0].at - 1)).toBeNull();
  const mid = positionAt(a, (a.points[0].at + a.points[1].at) / 2);
  expect(mid.km).toBeCloseTo(2.5, 1);
  expect(mid.pct).toBeCloseTo(25, 0);
  expect(mid.moving).toBe(true);
  expect(positionAt(a, a.points[2].at + 60000)).toMatchObject({ km: 10, pct: 100, moving: false });
});
