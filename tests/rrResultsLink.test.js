/**
 * "Full results" link — the timer's own results page, per event (CMS results
 * display) or per app (app defaults pattern). Never my.raceresult.com.
 */

const mockStore = new Map();
jest.mock('../src/config/redis', () => ({
  get: async (k) => (mockStore.has(k) ? mockStore.get(k) : null),
  setex: async (k, _ttl, v) => { mockStore.set(k, v); },
  hincrby: async () => 1,
  expire: async () => 1,
}));
const mockDb = { overrides: null, appUrl: null };
jest.mock('../src/config/database', () => ({
  query: async (sql) => (/rr_display_config/.test(sql)
    ? { rows: mockDb.overrides ? [{ overrides: mockDb.overrides }] : [] }
    : { rows: [{ url: mockDb.appUrl }] }),
}));

const { resultsPageUrl } = require('../src/services/rrpublish/client');

beforeEach(() => { mockStore.clear(); mockDb.overrides = null; mockDb.appUrl = null; });

test('nothing set → no link', async () => {
  expect(await resultsPageUrl(376986, 901)).toBe('');
});

test('app pattern fills in the RR event id', async () => {
  mockDb.appUrl = 'https://timit.pro/events/results/?page=results&eventid={id}';
  expect(await resultsPageUrl(376986, 901))
    .toBe('https://timit.pro/events/results/?page=results&eventid=376986');
});

test('per-event address wins over the app pattern; a pasted #fragment is dropped', async () => {
  mockDb.appUrl = 'https://timit.pro/events/results/?eventid={id}';
  mockDb.overrides = { v: 1, lists: {}, resultsUrl: 'https://www.popupraces.ie/race/belfast-5k/#1_D8DF98_details0_2973' };
  expect(await resultsPageUrl(434149, 901)).toBe('https://www.popupraces.ie/race/belfast-5k/');
});

test('only https addresses are accepted', async () => {
  mockDb.appUrl = 'javascript:alert(1)';
  expect(await resultsPageUrl(1, 901)).toBe('');
});
