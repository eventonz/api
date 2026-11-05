/** /v2/config for a Sportsplits event builds from the v2 tables, never the linked old race. */
jest.mock('../src/config/database', () => ({
  query: jest.fn(async (sql) => {
    if (/FROM v2\.events WHERE id/.test(sql)) return { rows: [{ id: 'chardonnay', event_json: {} }] };
    if (/JOIN v2\.courses/.test(sql)) return { rows: [
      { contest_id: '2', contest_name: 'Stage 1', is_tracking: true, course_id: 30, course_name: 'S1', updated: 1 },
      { contest_id: '3', contest_name: 'Stage 2', is_tracking: true, course_id: 35, course_name: 'S2', updated: 1 },
    ] };
    return { rows: [] };
  }),
}));
const mockRaces = jest.fn();
jest.mock('../src/services/v2bridge', () => ({ platformRacesForEvent: (...a) => mockRaces(...a) }));
const Fastify = require('fastify');

async function build() {
  const app = Fastify();
  app.get('/v1/config/:id', async () => ({ tracking: { paths: [{ name: 'p_4', contest: 4 }] } }));
  await app.register(require('../src/routes/v2/config'), { prefix: '/v2/config' });
  return app;
}

test('Sportsplits race linked to an old race → v2 contests/courses, not last year\'s tracking', async () => {
  mockRaces.mockResolvedValue([{ id: 373, timer_platform: 'sportsplits', platform_race_id: 2690 }]);
  const res = await (await build()).inject({ method: 'GET', url: '/v2/config/chardonnay' });
  expect(res.statusCode).toBe(200);
  const d = res.json();
  expect(d.source).toBe('v2');
  expect(d.tracking.paths.map((p) => p.contest)).toEqual(['2', '3']);
});

test('other platforms with an old race still bridge', async () => {
  mockRaces.mockResolvedValue([{ id: 1, timer_platform: 'raceresult', platform_race_id: 2690 }]);
  const res = await (await build()).inject({ method: 'GET', url: '/v2/config/x' });
  expect(res.json().tracking.paths[0].name).toBe('p_4');
});
