const { hmsToSecs } = require('../src/services/tracking');

test('durations: two groups are MM:SS (RaceResult / worker drop zero hours), three are H:MM:SS', () => {
  expect(hmsToSecs('17:32')).toBe(17 * 60 + 32);          // 5 km split, 17 minutes — not 17 hours
  expect(hmsToSecs('0:00:47')).toBe(47);
  expect(hmsToSecs('07:42:32')).toBe(7 * 3600 + 42 * 60 + 32);
  expect(hmsToSecs('1:05:23.4')).toBe(3600 + 5 * 60 + 23);
  expect(hmsToSecs('')).toBe(0);
});
