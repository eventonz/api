/**
 * POST /v2/ops/clear-gps/:race_id — CMS "Remove RaceMap data": deletes the
 * race's gps:race:* keys only. Redis + raceLog mocked.
 */
const mockRedis = {
  del: jest.fn(async (...keys) => keys.length),
  scan: jest.fn(async () => ['0', ['gps:race:1027:athlete:36', 'gps:race:1027:athlete:41']]),
};
jest.mock('../src/config/redis', () => mockRedis);
jest.mock('../src/config/database', () => ({ query: jest.fn(async () => ({ rows: [] })) }));
jest.mock('../src/services/raceLog', () => ({ raceLog: jest.fn() }));

const Fastify = require('fastify');

async function build(kind) {
  const app = Fastify();
  app.addHook('preHandler', async (request) => { request.auth = { kind }; });
  await app.register(require('../src/routes/v2/ops'), { prefix: '/v2/ops' });
  return app;
}

beforeEach(() => { mockRedis.del.mockClear(); mockRedis.scan.mockClear(); });

test('deletes the field snapshot, ops vehicles and every athlete fix for the race', async () => {
  const app = await build('server');
  const res = await app.inject({ method: 'POST', url: '/v2/ops/clear-gps/1027' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, race_id: 1027, gps_keys_deleted: 4 });
  expect(mockRedis.del).toHaveBeenCalledWith('gps:race:1027', 'gps:race:1027:ops');
  expect(mockRedis.scan).toHaveBeenCalledWith('0', 'MATCH', 'gps:race:1027:athlete:*', 'COUNT', 5000);
  expect(mockRedis.del).toHaveBeenCalledWith('gps:race:1027:athlete:36', 'gps:race:1027:athlete:41');
  await app.close();
});

test('needs a server key', async () => {
  const app = await build('install');
  const res = await app.inject({ method: 'POST', url: '/v2/ops/clear-gps/1027' });
  expect(res.statusCode).toBe(403);
  expect(mockRedis.del).not.toHaveBeenCalled();
  await app.close();
});
