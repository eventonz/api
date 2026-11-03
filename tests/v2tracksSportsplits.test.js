/** POST /v2/tracks/sportsplits/:raceid — Sportsplits pushes resolve by race id, gate on live, queue for the worker. */
const mockQueries = [];
let mockLiveState = 'live';
jest.mock('../src/config/database', () => ({
  query: jest.fn(async (sql, params) => {
    mockQueries.push({ sql, params });
    if (/sportsplits_raceid = \$1/.test(sql)) return { rows: params[0] === 19801 ? [{ id: 373, live_state: mockLiveState, status: 'active' }] : [] };
    return { rows: [] };
  }),
}));
const mockPushed = [];
const mockChain = { lpush: () => mockChain, ltrim: () => mockChain, expire: () => mockChain, exec: async () => [] };
jest.mock('../src/config/redis', () => ({
  get: jest.fn(async () => null),
  set: jest.fn(async () => 'OK'),
  incr: jest.fn(async () => 1),
  expire: jest.fn(async () => 1),
  lpush: jest.fn(async (key, ...jobs) => { mockPushed.push({ key, jobs }); return jobs.length; }),
  multi: () => mockChain,
}));
jest.mock('../src/services/raceLog', () => ({ raceLog: jest.fn() }));

const Fastify = require('fastify');

async function build() {
  const app = Fastify();
  await app.register(require('../src/routes/v2/tracks'), { prefix: '/v2/tracks' });
  return app;
}

const crossing = { race_no: '792', event_id: 2, split_id: 3, split_name: 'WP1', tod: '08:41:12', race_time: '01:41:12' };

beforeEach(() => { mockQueries.length = 0; mockPushed.length = 0; mockLiveState = 'live'; });

test('a live race gets the push queued for the worker as v2/tracks/sportsplits', async () => {
  const app = await build();
  const res = await app.inject({ method: 'POST', url: '/v2/tracks/sportsplits/19801', payload: crossing });
  expect(res.statusCode).toBe(202);
  expect(mockQueries.some((q) => /timer_platform = 'sportsplits'/.test(q.sql))).toBe(true);
  expect(mockPushed).toHaveLength(1);
  expect(mockPushed[0].key).toBe('ingest_queue');
  const job = JSON.parse(mockPushed[0].jobs[0]);
  expect(job).toMatchObject({ race_id: 373, endpoint: 'v2/tracks/sportsplits', payload: crossing });
});

test('not live → accepted but not queued; unknown race → 400', async () => {
  mockLiveState = 'idle';
  const app = await build();
  const res = await app.inject({ method: 'POST', url: '/v2/tracks/sportsplits/19801', payload: crossing });
  expect(res.statusCode).toBe(202);
  expect(res.json().message).toMatch(/not accepting/);
  expect(mockPushed).toHaveLength(0);
  expect((await app.inject({ method: 'POST', url: '/v2/tracks/sportsplits/1', payload: crossing })).statusCode).toBe(400);
});
