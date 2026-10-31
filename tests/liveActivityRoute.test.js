/**
 * POST /push/live_activity — Live Activity token registry. DB, Redis and FCM mocked.
 */
const queries = [];
jest.mock('../src/config/database', () => ({
  query: jest.fn(async (sql, params) => {
    queries.push({ sql, params });
    if (/FROM v2.device_tokens/.test(sql)) return { rows: [{ id: 77 }] };
    if (/FROM v2.races/.test(sql)) return { rows: [{ id: 870 }] };
    if (/INSERT INTO v2.live_activities/.test(sql)) return { rows: [{ id: 5 }] };
    return { rows: [] };
  }),
  connect: jest.fn(),
}));
jest.mock('../src/config/redis', () => ({ get: jest.fn(async () => null), set: jest.fn(async () => 'OK') }));
jest.mock('../src/services/fcm', () => ({ normLang: (l) => l || 'en', validTopic: () => true, stripLang: (t) => t, langTopic: (t) => t, LANGS: ['en'] }));

const Fastify = require('fastify');
const redis = require('../src/config/redis');

async function build() {
  const app = Fastify();
  await app.register(require('../src/routes/v1/push'), { prefix: '/push' });
  return app;
}

beforeEach(() => { queries.length = 0; });

test('registers an activity token against the device and race, flags the race in Redis', async () => {
  const app = await build();
  const res = await app.inject({ method: 'POST', url: '/push/live_activity', payload: {
    app_id: 38, kind: 'activity', token: 'a'.repeat(64), platform: 'ios', device_id: 'ios-dev-1',
    event_id: 'run-canberra-2026', athlete_key: 'A1', bib: '8161', activity_id: 'act-1',
  } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, id: 5, race_id: 870, device_token_id: 77 });
  const ins = queries.find((q) => /INSERT INTO v2.live_activities/.test(q.sql));
  expect(ins.params).toEqual([38, 'ios-dev-1', 77, 'activity', 'a'.repeat(64), 'run-canberra-2026', 870, 'A1', '8161', 'act-1']);
  // An older card for the same device + athlete is superseded.
  expect(queries.some((q) => /SET ended_at = NOW\(\) WHERE kind = 'activity'/.test(q.sql))).toBe(true);
  expect(redis.set).toHaveBeenCalledWith('live:race:870', '1', 'EX', 36 * 3600);
  await app.close();
});

test('push-to-start token needs no event and supersedes nothing', async () => {
  const app = await build();
  const res = await app.inject({ method: 'POST', url: '/push/live_activity', payload: {
    app_id: 38, kind: 'push_to_start', token: 'b'.repeat(64), device_id: 'ios-dev-1',
  } });
  expect(res.statusCode).toBe(200);
  expect(res.json().race_id).toBeNull();
  expect(queries.some((q) => /SET ended_at = NOW\(\) WHERE kind = 'activity'/.test(q.sql))).toBe(false);
  await app.close();
});

test('rejects an unknown kind', async () => {
  const app = await build();
  const res = await app.inject({ method: 'POST', url: '/push/live_activity', payload: { app_id: 38, kind: 'widget', token: 'c'.repeat(64) } });
  expect(res.statusCode).toBe(400);
  await app.close();
});
