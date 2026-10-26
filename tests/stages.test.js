/** Stage races: document builder, next-start selection, bib normalisation, POST validation + auth. */
jest.mock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../src/config/redis', () => ({
  get: jest.fn().mockResolvedValue(null), setex: jest.fn().mockResolvedValue('OK'), set: jest.fn().mockResolvedValue('OK'),
  mget: jest.fn().mockResolvedValue([]), lpush: jest.fn().mockResolvedValue(1),
}));

const crypto = require('crypto');
const pool  = require('../src/config/database');
const redis = require('../src/config/redis');
const { buildStagesDoc, nextStart, normaliseBib, validateStagesBody, stagesKey, STAGES_TTL_SECS } = require('../src/services/stages');

const results = [
  { stage_no: 2, stage_name: 'Stage 2', stage_time: '03:10:00', stage_rank: 4, gc_time: '06:05:00', gc_rank: 3, cat_rank: '1', gc_gap: '+00:02:10', updated_at: '2026-10-27T15:00:00Z' },
  { stage_no: 1, stage_name: 'Prologue', stage_time: '02:55:00', stage_rank: 2, gc_time: '02:55:00', gc_rank: 2, cat_rank: 1, gc_gap: '', updated_at: '2026-10-26T15:00:00Z' },
];
const starts = [
  { stage_no: 3, stage_name: 'Stage 3', start_date: '2026-10-28', start_time: '07:10', chute: 'A', updated_at: '2026-10-27T18:00:00Z' },
  { stage_no: 2, stage_name: 'Stage 2', start_date: '2026-10-27', start_time: '07:00', chute: 'B', updated_at: '2026-10-26T18:00:00Z' },
  { stage_no: 4, stage_name: 'Stage 4', start_date: new Date('2026-10-29T00:00:00Z'), start_time: '', chute: null, updated_at: null },
];

describe('buildStagesDoc', () => {
  test('sorted by stage_no; start-only stages carry null times; updated = latest row', () => {
    const doc = buildStagesDoc(results, starts);
    expect(doc.stages.map((s) => s.no)).toEqual([1, 2, 3, 4]);
    expect(doc.stages[1]).toEqual({ no: 2, name: 'Stage 2', time: '03:10:00', rank: 4, gc_time: '06:05:00', gc_rank: 3, cat_rank: 1, gap: '+00:02:10' });
    expect(doc.stages[0].gap).toBeNull();
    expect(doc.stages[2]).toEqual({ no: 3, name: 'Stage 3', time: null, rank: null, gc_time: null, gc_rank: null, cat_rank: null, gap: null });
    expect(doc.updated).toBe('2026-10-27T18:00:00.000Z');
  });
  test('empty inputs → empty stages, no next start', () => {
    const doc = buildStagesDoc([], []);
    expect(doc.stages).toEqual([]);
    expect(doc.next_start).toBeNull();
  });
});

describe('nextStart', () => {
  test('lowest stage in starts with no result row', () => {
    expect(nextStart(results, starts)).toEqual({ stage_no: 3, name: 'Stage 3', date: '2026-10-28', time: '07:10', chute: 'A' });
  });
  test('every start ridden → null; Date start_date → yyyy-mm-dd', () => {
    expect(nextStart(results, [starts[1]])).toBeNull();
    expect(nextStart(results, [starts[2]])).toEqual({ stage_no: 4, name: 'Stage 4', date: '2026-10-29', time: null, chute: null });
  });
});

describe('normaliseBib', () => {
  test('trims and strips leading zeros on numeric bibs only', () => {
    expect(normaliseBib(' 0042 ')).toBe('42');
    expect(normaliseBib('9001')).toBe('9001');
    expect(normaliseBib(9001)).toBe('9001');
    expect(normaliseBib('000')).toBe('0');
    expect(normaliseBib('9001-1')).toBe('9001-1');
    expect(normaliseBib('A07')).toBe('A07');
    expect(normaliseBib(null)).toBe('');
  });
});

describe('validateStagesBody', () => {
  test('accepts results and starts bodies, normalises race_id', () => {
    const r = validateStagesBody({ format: 'evento', results: [{ bib: '9001', stage_no: 1 }], race_id: '653' });
    expect(r).toEqual({ ok: true, body: { format: 'evento', results: [{ bib: '9001', stage_no: 1 }], race_id: 653 } });
    expect(validateStagesBody({ format: 'starts', starts: [{ bib: '9001', stage_no: 2 }] }).ok).toBe(true);
    expect(validateStagesBody({ format: 'raceresult_list', results: [{}] }).ok).toBe(true);
  });
  test('rejects bad format, wrong/empty list, bad race_id', () => {
    expect(validateStagesBody({ format: 'csv', results: [{}] }).ok).toBe(false);
    expect(validateStagesBody({ format: 'evento', starts: [{}] }).error).toMatch(/results must be an array/);
    expect(validateStagesBody({ format: 'starts', starts: [] }).error).toMatch(/empty/);
    expect(validateStagesBody({ format: 'evento', results: ['x'] }).ok).toBe(false);
    expect(validateStagesBody({ format: 'evento', results: [{}], race_id: 'abc' }).error).toMatch(/race_id/);
    expect(validateStagesBody([]).ok).toBe(false);
  });
});

describe('POST /v2/stages/:event_id', () => {
  const fastify = require('fastify');
  const serverKey = 'srv-key', appKey = 'app-key';
  const hash = (k) => crypto.createHash('sha256').update(k).digest('hex');
  let app;
  beforeAll(async () => {
    app = fastify();
    app.register(require('../src/routes/v2/stages').ingest, { prefix: '/v2/stages' });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    pool.query.mockReset(); redis.lpush.mockClear(); redis.get.mockResolvedValue(null);
    pool.query.mockImplementation(async (sql, params) => {
      if (/FROM api_keys/.test(sql)) {
        if (params[0] === hash(serverKey)) return { rows: [{ id: 9, name: 'CMS', app_id: null, kind: 'server' }] };
        if (params[0] === hash(appKey)) return { rows: [{ id: 3, name: 'iOS', app_id: 7, kind: 'app' }] };
        return { rows: [] };
      }
      if (/FROM timer_api_tokens/.test(sql)) return params[0] === hash('evt_good') ? { rows: [{ id: 1, org_id: 28, app_id: null }] } : { rows: [] };
      if (/FROM v2\.races WHERE event_id/.test(sql)) return params[0] === 'epic' ? { rows: [{ id: 653 }, { id: 654 }] } : { rows: [] };
      return { rows: [] };
    });
  });
  const post = (key, body, event = 'epic') => app.inject({
    method: 'POST', url: `/v2/stages/${event}`, headers: key ? { authorization: `Bearer ${key}` } : {}, payload: body,
  });
  const body = { format: 'evento', results: [{ bib: '9001', stage_no: 1, stage_time: '02:55:00' }] };

  test('server key → 202 queued on the event\'s first race, envelope on ingest_queue', async () => {
    const res = await post(serverKey, body);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'queued', race_id: 653 });
    expect(redis.lpush).toHaveBeenCalledTimes(1);
    const [queue, raw] = redis.lpush.mock.calls[0];
    expect(queue).toBe('ingest_queue');
    expect(JSON.parse(raw)).toMatchObject({ race_id: 653, endpoint: 'v2/stages', payload: body });
  });
  test('evt_ timer token accepted; race_id in body picks a race of the event', async () => {
    const res = await post('evt_good', { ...body, race_id: 654 });
    expect(res.statusCode).toBe(202);
    expect(res.json().race_id).toBe(654);
    expect(JSON.parse(redis.lpush.mock.calls[0][1]).payload.race_id).toBeUndefined();
    expect((await post(serverKey, { ...body, race_id: 999 })).statusCode).toBe(404);
  });
  test('missing, unknown, app key and bad evt_ token are refused; nothing queued', async () => {
    expect((await post(null, body)).statusCode).toBe(401);
    expect((await post('nope', body)).statusCode).toBe(401);
    expect((await post(appKey, body)).statusCode).toBe(403);
    expect((await post('evt_bad', body)).statusCode).toBe(401);
    expect(redis.lpush).not.toHaveBeenCalled();
  });
  test('invalid body → 400, unknown event → 404', async () => {
    expect((await post(serverKey, { format: 'evento' })).statusCode).toBe(400);
    expect((await post(serverKey, body, 'nope')).statusCode).toBe(404);
    expect(redis.lpush).not.toHaveBeenCalled();
  });
});

describe('GET /v2/stages/:event_id', () => {
  const fastify = require('fastify');
  let app;
  beforeAll(async () => {
    app = fastify();
    app.register(require('../src/routes/v2/stages'), { prefix: '/v2/stages' });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    pool.query.mockReset(); redis.mget.mockReset(); redis.set.mockClear();
    pool.query.mockImplementation(async (sql) => {
      if (/FROM v2\.races WHERE event_id/.test(sql)) return { rows: [{ id: 653 }] };
      if (/FROM v2\.stage_results/.test(sql)) return { rows: results.map((r) => ({ ...r, race_id: 653 })) };
      if (/FROM v2\.stage_starts/.test(sql)) return { rows: starts.map((s) => ({ ...s, race_id: 653 })) };
      return { rows: [] };
    });
  });
  test('Redis hit wins', async () => {
    redis.mget.mockResolvedValue([JSON.stringify({ stages: [{ no: 1 }], next_start: null, updated: 'x' })]);
    const res = await app.inject({ url: '/v2/stages/epic?bib=09001' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBe('HIT');
    expect(res.json()).toEqual({ race_id: 653, bib: '9001', stages: [{ no: 1 }], next_start: null, updated: 'x' });
    expect(redis.mget).toHaveBeenCalledWith([stagesKey(653, '9001')]);
  });
  test('miss → built from Postgres and written back with the splits TTL', async () => {
    redis.mget.mockResolvedValue([null]);
    const res = await app.inject({ url: '/v2/stages/epic?bib=9001' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBe('MISS');
    const doc = res.json();
    expect(doc.stages.map((s) => s.no)).toEqual([1, 2, 3, 4]);
    expect(doc.next_start.stage_no).toBe(3);
    expect(redis.set).toHaveBeenCalledWith(stagesKey(653, '9001'), expect.any(String), 'EX', STAGES_TTL_SECS);
  });
  test('no rows anywhere → 404', async () => {
    redis.mget.mockResolvedValue([null]);
    pool.query.mockImplementation(async (sql) => (/FROM v2\.races/.test(sql) ? { rows: [{ id: 653 }] } : { rows: [] }));
    expect((await app.inject({ url: '/v2/stages/epic?bib=1' })).statusCode).toBe(404);
  });
});

describe('scripts/lib/stagesCsv', () => {
  const { parseCsv, rowsToBody } = require('../scripts/lib/stagesCsv');
  test('CSV header → canonical result fields', () => {
    const rows = parseCsv('Bib,Stage,Stage Name,stage_time,Rank,GC,gc_rank,cat_rank,gap\n"9001",1,"Prologue, Day 0",02:55:00,2,02:55:00,2,1,\n');
    expect(rowsToBody(rows, 'evento')).toEqual({ format: 'evento', results: [
      { bib: '9001', stage_no: 1, stage_name: 'Prologue, Day 0', stage_time: '02:55:00', stage_rank: 2, gc_time: '02:55:00', gc_rank: 2, cat_rank: 1 },
    ] });
  });
  test('starts CSV, rows without bib/stage dropped', () => {
    const rows = parseCsv('bib,stage_no,stage_name,date,time,chute\r\n9001,2,Stage 2,2026-10-27,07:00,A\r\n,,,,,\r\n');
    expect(rowsToBody(rows, 'starts')).toEqual({ format: 'starts', starts: [{ bib: '9001', stage_no: 2, stage_name: 'Stage 2', date: '2026-10-27', time: '07:00', chute: 'A' }] });
  });
});

describe('PATCH /v2/athletes/:event_id — follow stubs carry riders', () => {
  const fastify = require('fastify');
  let app;
  beforeAll(async () => {
    app = fastify();
    app.register(require('../src/routes/v2/athletes'), { prefix: '/v2/athletes' });
    await app.ready();
  });
  afterAll(() => app.close());
  test('returns members with status, country, entry_type and extras', async () => {
    pool.query.mockReset();
    pool.query.mockResolvedValue({ rows: [{
      athlete_id: 'T9001', raceno: '9001', name: 'Toyota Specialized Imbuko', info: '', category: 'Men', profile_image: null, contest: 1,
      country: 'ZA', entry_type: 'team', extras: { sponsor: 'Toyota' },
      athlete_details: [{ name: 'Matthew Beers', country: 'ZA', athletenumber: '9001-1', status: 'BB' }, { name: 'Tristan Nortje', country: 'ZA', athletenumber: '9001-2' }],
    }] });
    const res = await app.inject({ method: 'PATCH', url: '/v2/athletes/epic', payload: { athletes: ['T9001'] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().patchedathletes[0]).toEqual({
      id: 'T9001', name: 'Toyota Specialized Imbuko', number: '9001', info: 'Men', contest_id: '1',
      members: [{ name: 'Matthew Beers', bib: '9001-1', country: 'ZA', status: 'BB' }, { name: 'Tristan Nortje', bib: '9001-2', country: 'ZA' }],
      country: 'ZA', entry_type: 'team', extras: { sponsor: 'Toyota' },
    });
    expect(pool.query.mock.calls[0][0]).toMatch(/a\.country_name AS country/);
  });
});
