jest.mock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../src/config/redis', () => ({}));

const pool = require('../src/config/database');
const { isPlaceholderBib, insertResultsTable } = require('../src/services/trackPersistence');

describe('dynamic bibs — no results row for a placeholder bib', () => {
  beforeEach(() => pool.query.mockClear());

  test('isPlaceholderBib: at or above the limit, and only when a limit is set', () => {
    expect(isPlaceholderBib(10064, 10000)).toBe(true);
    expect(isPlaceholderBib(10000, 10000)).toBe(true);
    expect(isPlaceholderBib(737, 10000)).toBe(false);
    expect(isPlaceholderBib(10064, 0)).toBe(false);
    expect(isPlaceholderBib(10064, null)).toBe(false);
  });

  const raceobj = (limit) => ({ results_table: 'secondwind', raceno_bib_limit: limit });
  const track = (bib) => ({ race_no: bib, split_id: 2, athlete_id: '65', tod: '14:28:35.0' });

  test('insertResultsTable skips a placeholder bib', async () => {
    await insertResultsTable(1216, track(10064), raceobj(10000));
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('insertResultsTable writes a real bib, and any bib when no limit is set', async () => {
    await insertResultsTable(1216, track(737), raceobj(10000));
    await insertResultsTable(1216, track(10064), raceobj(0));
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});
