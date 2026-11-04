/**
 * Finisher Snap — /v2/snap/* and /v2/finisher_photos/*. DB, Redis and Spaces mocked.
 */
process.env.JWT_SECRET = 'test-secret';
process.env.DO_SPACES_KEY = 'k';
process.env.DO_SPACES_SECRET = 's';

const mockQueries = [];
let mockEventRow = { id: 'chardonnay', event_json: { name: 'Chardonnay', date: '2026-11-06', finisherSnap: { code: 'GRAPE1' } } };
jest.mock('../src/config/database', () => ({
  query: jest.fn(async (sql, params) => {
    mockQueries.push({ sql, params });
    if (/finisherSnap'->>'code' AS code FROM v2.events/.test(sql)) return { rows: mockEventRow ? [{ code: mockEventRow.event_json.finisherSnap?.code }] : [] };
    if (/FROM v2.events\s+WHERE COALESCE/.test(sql)) return { rows: [mockEventRow] };
    if (/SELECT id, event_json FROM v2.events WHERE id/.test(sql)) return { rows: params[0] === mockEventRow?.id ? [mockEventRow] : [] };
    if (/search_athletes/.test(sql)) return { rows: [{ raceno: '246', name: 'Team 246', info: '', athlete_id: '246', race_id: '373', race_name: 'Chardonnay', athlete_details: [{ name: 'A Rider' }, { name: 'B Rider' }] }] };
    if (/FROM v2.races WHERE id/.test(sql)) return { rows: params[0] === 373 ? [{ id: 373 }] : [] };
    if (/INSERT INTO v2.finisher_photos/.test(sql)) return { rows: [{ id: '9', bib: params[2], athlete_id: params[3], url: params[5], thumb_url: params[6], width: params[7], height: params[8], orientation: params[9], created_at: new Date('2026-11-06T02:00:00Z') }] };
    if (/UPDATE v2.finisher_photos SET deleted_at/.test(sql)) return { rows: params[0] === 9 ? [{ bib: '246' }] : [] };
    if (/FROM v2.finisher_photos/.test(sql)) return { rows: [{ id: '9', bib: '246', athlete_id: '246', url: 'u', thumb_url: null, width: 1536, height: 2048, orientation: 'portrait', created_at: '2026-11-06T02:00:00.000Z' }] };
    return { rows: [] };
  }),
}));
const mockStore = new Map();
jest.mock('../src/config/redis', () => ({
  get: jest.fn(async (k) => mockStore.get(k) ?? null),
  setex: jest.fn(async (k, _t, v) => { mockStore.set(k, v); return 'OK'; }),
  del: jest.fn(async (k) => { mockStore.delete(k); return 1; }),
  incr: jest.fn(async (k) => { const n = (mockStore.get(k) || 0) + 1; mockStore.set(k, n); return n; }),
  expire: jest.fn(async () => 1),
}));

const Fastify = require('fastify');
const snap = require('../src/routes/v2/snap');
const { issueSnapToken, verifySnapToken, codesMatch } = require('../src/services/snapTokens');

const uploaded = new Set();
const { S3Client } = require('@aws-sdk/client-s3');
const fakeSpaces = new S3Client({ endpoint: 'https://fra1.digitaloceanspaces.com', region: 'fra1', credentials: { accessKeyId: 'k', secretAccessKey: 's' } });
fakeSpaces.send = jest.fn(async (cmd) => {
  if (cmd.constructor.name === 'HeadObjectCommand' && !uploaded.has(cmd.input.Key)) throw new Error('NotFound');
  return {};
});
snap.setSpacesClient(fakeSpaces);

async function build() {
  const app = Fastify();
  await app.register(snap, { prefix: '/v2/snap' });
  await app.register(snap.photosRead, { prefix: '/v2/finisher_photos' });
  return app;
}
const auth = (eventId = 'chardonnay') => ({ authorization: `Bearer ${issueSnapToken(eventId).token}` });

beforeEach(() => {
  mockQueries.length = 0; mockStore.clear(); uploaded.clear();
  mockEventRow = { id: 'chardonnay', event_json: { name: 'Chardonnay', date: '2026-11-06', finisherSnap: { code: 'GRAPE1' } } };
});

describe('snap tokens', () => {
  test('round-trips the event id and rejects tampering / expiry', () => {
    const { token } = issueSnapToken('chardonnay');
    expect(verifySnapToken(token)).toBe('chardonnay');
    expect(() => verifySnapToken(token.slice(0, -2) + 'xx')).toThrow('invalid');
    expect(() => verifySnapToken(token, Date.now() + 8 * 24 * 3600 * 1000)).toThrow('expired');
  });
  test('codes compare case-insensitively and never match empty', () => {
    expect(codesMatch(' grape1 ', 'GRAPE1')).toBe(true);
    expect(codesMatch('', '')).toBe(false);
    expect(codesMatch('GRAPE2', 'GRAPE1')).toBe(false);
  });
});

test('lists events with a code', async () => {
  const app = await build();
  const res = await app.inject({ url: '/v2/snap/events' });
  expect(res.json()).toEqual({ events: [{ id: 'chardonnay', name: 'Chardonnay', date: '2026-11-06', venue: null, image: null, accent: null }] });
});

test('login: right code → token; wrong code → 401; rate-limited after 10 tries', async () => {
  const app = await build();
  const ok = await app.inject({ method: 'POST', url: '/v2/snap/login', payload: { event_id: 'chardonnay', code: 'grape1' } });
  expect(ok.statusCode).toBe(200);
  expect(verifySnapToken(ok.json().token)).toBe('chardonnay');
  for (let i = 0; i < 10; i++) {
    const bad = await app.inject({ method: 'POST', url: '/v2/snap/login', payload: { event_id: 'chardonnay', code: 'nope' } });
    expect(bad.json().code).toBe('WRONG_CODE');
  }
  const limited = await app.inject({ method: 'POST', url: '/v2/snap/login', payload: { event_id: 'chardonnay', code: 'GRAPE1' } });
  expect(limited.statusCode).toBe(429);
});

test('snap calls need a token, and stop working when the code is removed', async () => {
  const app = await build();
  expect((await app.inject({ url: '/v2/snap/photos' })).statusCode).toBe(401);
  mockEventRow.event_json.finisherSnap = {};
  expect((await app.inject({ url: '/v2/snap/photos', headers: auth() })).statusCode).toBe(401);
});

test('athlete autocomplete returns bib, name and team riders', async () => {
  const app = await build();
  const res = await app.inject({ url: '/v2/snap/athletes?q=24', headers: auth() });
  expect(res.json().athletes[0]).toEqual({ bib: '246', name: 'Team 246', info: 'A Rider · B Rider', athlete_id: '246', race_id: 373, race_name: 'Chardonnay' });
  expect(mockQueries.find((q) => /search_athletes/.test(q.sql)).params).toEqual(['24', 'chardonnay', null, 20, 0]);
});

test('upload → commit → visible to the event app → delete', async () => {
  const app = await build();
  const up = await app.inject({ method: 'POST', url: '/v2/snap/uploads', headers: auth(), payload: { bib: '246' } });
  expect(up.statusCode).toBe(200);
  const { photo_key, upload, thumb_upload } = up.json();
  expect(photo_key).toMatch(/^finisher-snap\/chardonnay\/246\/[0-9a-f-]{36}\.jpg$/);
  expect(upload.url).toContain(encodeURIComponent(photo_key).replace(/%2F/g, '/'));
  expect(thumb_upload.url).toContain('_thumb.jpg');
  expect(upload.headers['Content-Type']).toBe('image/jpeg');

  // Not uploaded yet → refused.
  const early = await app.inject({ method: 'POST', url: '/v2/snap/photos', headers: auth(), payload: { photo_key, bib: '246', width: 1536, height: 2048 } });
  expect(early.json().code).toBe('NOT_UPLOADED');

  uploaded.add(photo_key); uploaded.add(photo_key.replace('.jpg', '_thumb.jpg'));
  mockStore.set('finisher_photos:chardonnay:246', '{"photos":[]}');
  const commit = await app.inject({ method: 'POST', url: '/v2/snap/photos', headers: auth(), payload: { photo_key, bib: '246', width: 1536, height: 2048, race_id: 999, athlete_id: '246' } });
  expect(commit.statusCode).toBe(200);
  const photo = commit.json().photo;
  expect(photo).toMatchObject({ id: 9, bib: '246', orientation: 'portrait', url: `https://evento-nz.fra1.cdn.digitaloceanspaces.com/${photo_key}` });
  expect(photo.thumb_url).toContain('_thumb.jpg');
  const ins = mockQueries.find((q) => /INSERT INTO v2.finisher_photos/.test(q.sql));
  expect(ins.params[1]).toBeNull(); // race 999 isn't this event's
  expect(mockStore.has('finisher_photos:chardonnay:246')).toBe(false); // cache cleared

  const read = await app.inject({ url: '/v2/finisher_photos/chardonnay/246' });
  expect(read.json().photos[0]).toMatchObject({ id: 9, orientation: 'portrait', thumb_url: 'u' });
  expect(mockStore.has('finisher_photos:chardonnay:246')).toBe(true);

  expect((await app.inject({ method: 'DELETE', url: '/v2/snap/photos/9', headers: auth() })).json()).toEqual({ ok: true });
  expect(mockStore.has('finisher_photos:chardonnay:246')).toBe(false);
  expect((await app.inject({ method: 'DELETE', url: '/v2/snap/photos/10', headers: auth() })).statusCode).toBe(404);
});

test('commit refuses another event’s key and bad bibs', async () => {
  const app = await build();
  const other = await app.inject({ method: 'POST', url: '/v2/snap/photos', headers: auth(), payload: { photo_key: 'finisher-snap/other/1/x.jpg', bib: '1', width: 10, height: 10 } });
  expect(other.json().code).toBe('BAD_KEY');
  const bib = await app.inject({ method: 'POST', url: '/v2/snap/uploads', headers: auth(), payload: { bib: '../x' } });
  expect(bib.json().code).toBe('BAD_BIB');
});

test('orientation derives from size', () => {
  const { orientationOf } = snap._internal;
  expect(orientationOf(2048, 1536)).toBe('landscape');
  expect(orientationOf(1536, 2048)).toBe('portrait');
  expect(orientationOf(100, 100)).toBe('square');
});
