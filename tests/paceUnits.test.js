const p = require('../src/services/splits/paceUnits');

test('units normalise, including the legacy leg values', () => {
  expect(p.normaliseUnit('speed')).toBe('speed_kmh');
  expect(p.normaliseUnit('pace')).toBe('pace_km');
  expect(p.normaliseUnit('pace_100m')).toBe('pace_100m');
  expect(p.normaliseUnit('bogus')).toBeNull();
  expect(p.contestUnit(null, 'mi')).toBe('pace_mi');
  expect(p.contestUnit('speed_kmh', 'mi')).toBe('speed_kmh');
});

test('formats RR pace 6:24/km in every unit', () => {
  const rr = { paceMinKm: '6:24', speedKmh: '9.4' };
  expect(p.format('pace_km', rr)).toBe('6:24');
  expect(p.format('pace_mi', rr)).toBe('10:18');
  expect(p.format('speed_kmh', rr)).toBe('9.4');
  expect(p.format('speed_mph', rr)).toBe('5.8');
  expect(p.format('pace_100m', rr)).toBe('0:38');
});

test('derives from time over distance when RR sends nothing (swim leg)', () => {
  const swim = { seconds: 30 * 60, distanceKm: 1.5 };   // 30:00 for 1500 m
  expect(p.format('pace_100m', swim)).toBe('2:00');
  expect(p.format('speed_kmh', swim)).toBe('3.0');
  expect(p.format('pace_km', {})).toBe('');
});
