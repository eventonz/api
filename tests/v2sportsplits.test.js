/** Sportsplits (W2W 2026): live team stage + GC fetched server side, merged with pushed crossings. */
const mockRedis = { get: jest.fn(), set: jest.fn(() => Promise.resolve('OK')) };
jest.mock('../src/config/redis', () => mockRedis);
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
const pool = require('../src/config/database');
const ss = require('../src/services/sportsplits');
const v2sportsplits = require('../src/services/splits/v2sportsplits');

const race = { id: 373, time_zone: 'Africa/Johannesburg', sportsplits_raceid: 19801, sportsplits_apikey: 'KEY', sportsplits_live_stage: '2', sportsplits_gc: '1',
  sportsplits_ebike_live_stage: '6', sportsplits_ebike_gc: '8' };
// Stage 1 = contest 2: Start 8, WP1 3, Finish 1 → keys 2008 / 2003 / 2001.
const raceobj = { timezone: 'Africa/Johannesburg', events: [{
  contest_id: '2', event_descr: 'Stage 1',
  splits: [
    { id: 1, rr_splitid: 2008, name: 'Start', order: 0, visible: 1, split_type: 'start' },
    { id: 2, rr_splitid: 2003, name: 'WP1 26km', order: 1, visible: 1, split_type: 'split' },
    { id: 3, rr_splitid: 2001, name: 'Finish', order: 2, visible: 1, split_type: 'finish' },
  ],
}] };
const stageTeam = {
  finish_time: '', overall_pos: null, type_pos: null,
  splits: [
    { split_id: 8, name: 'Start', tod: '07:00:00', race_time: '' },
    { split_id: 3, name: 'WP1', tod: '08:31:05', race_time: '01:31:05', leg_speed: 17.12, overall_pos: 12, type_pos: 3 },
  ],
};

beforeEach(() => { mockRedis.get.mockReset(); mockRedis.get.mockResolvedValue(null); global.fetch = jest.fn(); });

test('checkpoint key = contest * 1000 + split id', () => {
  expect(ss.splitKey(2, 8)).toBe(2008);
  expect(ss.splitKey('4', 1)).toBe(4001);
});

test('e-bike teams read the e-bike stage and GC; others the normal pair (GC defaults to event 1)', () => {
  expect(ss.stagesFor(race, '8')).toEqual({ live: '6', gc: '8', ebike: true });
  expect(ss.stagesFor(race, null)).toEqual({ live: '2', gc: '1', ebike: false });
  expect(ss.stagesFor({ ...race, sportsplits_gc: null }, '').gc).toBe('1');
});

test('fetchTeamResult calls the team endpoint with the key, caches, and treats 404 as no result', async () => {
  global.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ race_event_team: stageTeam }) });
  const t = await ss.fetchTeamResult(race, '2', '79');
  expect(t.splits).toHaveLength(2);
  const [url, opts] = global.fetch.mock.calls[0];
  expect(url).toBe('https://api.sportsplits.com/v2/races/19801/events/2/results/teams/race_no/79?splits=true');
  expect(opts.headers['X-API-KEY']).toBe('KEY');
  expect(mockRedis.set).toHaveBeenCalledWith('ss:team:19801:2:79', expect.any(String), 'EX', 30);

  global.fetch.mockResolvedValueOnce({ ok: false, status: 404 });
  expect(await ss.fetchTeamResult(race, '2', '1')).toBeNull();
  global.fetch.mockResolvedValueOnce({ ok: false, status: 500 });
  await expect(ss.fetchTeamResult(race, '2', '2')).rejects.toThrow(/500/);
});

test('live stage renders on the CMS checkpoints with Sportsplits times and ranks', async () => {
  const fetchTeam = jest.fn(async () => stageTeam);
  const { livetiming } = await v2sportsplits.transform({ race, team: { raceno: '79', athlete_id: '79' }, stage: '2', raceobj, fetchTeam });
  expect(fetchTeam).toHaveBeenCalledWith(race, '2', '79');
  expect(livetiming.finish_status).toBe(3);
  const byName = Object.fromEntries(livetiming.splits.map((s) => [s.name, s]));
  expect(byName['Start'].tod).toBe('07:00:00');
  expect(byName['WP1 26km']).toMatchObject({ RaceTime: '01:31:05', tod: '08:31:05', overall_place: '12' });
  expect(byName['Finish'].tod).toBe('');
});

test('finished stage: result + places from the team summary', async () => {
  const done = { ...stageTeam, finish_time: '03:02:11', overall_pos: 9, type_pos: 2,
    splits: [...stageTeam.splits, { split_id: 1, name: 'Finish', tod: '10:02:11', race_time: '03:02:11' }] };
  const { livetiming } = await v2sportsplits.transform({ race, team: { raceno: '79' }, stage: '2', raceobj, fetchTeam: async () => done });
  expect(livetiming).toMatchObject({ finish_status: 4, result: '03:02:11', overall_place: '9', overall_cat_place: '2' });
});

test('Sportsplits down → pushed crossings for THIS stage still show (other stages ignored)', async () => {
  mockRedis.get.mockResolvedValueOnce(JSON.stringify({ bib: 79, splits: [
    { rr_id: 2003, name: 'WP1', tod: '08:31:09', time: '1:31:09' },
    { rr_id: 3003, name: 'WP1', tod: '08:10:00', time: '1:10:00' },
  ] }));
  const fetchTeam = async () => { throw new Error('timeout'); };
  const { livetiming } = await v2sportsplits.transform({ race, team: { raceno: '79', athlete_id: '79' }, stage: '2', raceobj, fetchTeam });
  const wp1 = livetiming.splits.find((s) => s.name === 'WP1 26km');
  expect(wp1.tod).toBe('08:31:09');
});

test('GC result → stage rows (stage time, GC time, GC + category rank; Prologue = stage 0)', () => {
  const rows = ss.gcStageRows({ splits: [
    { name: 'Prologue', split_time: '00:25:01', race_time: '00:25:01', overall_pos: 4, type_pos: 1 },
    { name: 'Stage 1', split_time: '03:02:11', race_time: '03:27:12', overall_pos: 6, type_pos: 2 },
  ] }, 373, '79');
  expect(rows.map((r) => [r.stage_no, r.stage_name, r.stage_time, r.gc_time, r.gc_rank, r.cat_rank])).toEqual([
    [0, 'Prologue', '00:25:01', '00:25:01', 4, 1],
    [1, 'Stage 1', '03:02:11', '03:27:12', 6, 2],
  ]);
  expect(ss.gcStageRows(null, 373, '79')).toEqual([]);
});

test('stageStartRows: an e-bike team gets its start from the "Stage N E-Bike" list (Pinotage)', async () => {
  const events = async () => [
    { id: '2', name: 'Stage 1', date: '2026-11-09' }, { id: '5', name: 'Stage 1 E-Bike', date: '2026-11-09' },
    { id: '3', name: 'Stage 2', date: '2026-11-10' }, { id: '1', name: 'GC', date: '2026-11-09' }, { id: '8', name: 'GC E-Bike', date: '2026-11-09' },
  ];
  const starts = async (_race, ev) => ({
    '2': { '51': { chute: 'E', time: '07:30' } },
    '5': { '52': { chute: 'E-Bike Open C', time: '07:10' } },
    '3': {}, '1': {}, '8': {},
  })[ev];
  const ebike = await ss.stageStartRows(race, 158, '52', { events, starts });
  expect(ebike.map((r) => [r.stage_no, r.stage_name, r.start_date, r.start_time, r.chute])).toEqual([[1, 'Stage 1 E-Bike', '2026-11-09', '07:10', 'E-Bike Open C']]);
  const normal = await ss.stageStartRows(race, 158, '51', { events, starts });
  expect(normal.map((r) => [r.stage_no, r.start_time, r.chute])).toEqual([[1, '07:30', 'E']]);
});

test('todayIn: a date in the race time zone, null without one', () => {
  expect(ss.todayIn('Africa/Johannesburg')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(ss.todayIn('')).toBeNull();
  expect(ss.todayIn('Not/AZone')).toBeNull();
});

test('GC team is_active=false (rider went IF) → no stage rows even though Sportsplits still ranks its splits', () => {
  const inactive = { is_active: false, finish_time: null, overall_pos: null, splits: [
    { name: 'Stage 1', split_time: '04:04:01', race_time: '04:04:01', overall_pos: 112, type_pos: 43 },
    { name: 'Stage 2', split_time: '03:40:24', race_time: '07:44:26', overall_pos: 73, type_pos: 31 },
  ] };
  expect(ss.gcStageRows(inactive, 373, '101')).toEqual([]);
  expect(ss.gcStageRows({ ...inactive, is_active: true }, 373, '101')).toHaveLength(2);
  expect(ss.gcStageRows({ ...inactive, is_active: undefined }, 373, '101')).toHaveLength(2);
});

test('sportsplitsRace: only races set up for Sportsplits', async () => {
  pool.query.mockResolvedValueOnce({ rows: [race] });
  expect(await ss.sportsplitsRace(373)).toBe(race);
  pool.query.mockResolvedValueOnce({ rows: [{ ...race, sportsplits_apikey: null }] });
  expect(await ss.sportsplitsRace(373)).toBeNull();
});

describe('Prologue for Elite only: teams not on the live stage show the next stage', () => {
  const obj = { events: [
    { contest_id: '1', event_descr: 'GC' }, { contest_id: '2', event_descr: 'Stage 1' },
    { contest_id: '3', event_descr: 'Stage 2' }, { contest_id: '5', event_descr: 'Prologue' },
    { contest_id: '6', event_descr: 'GC: UCI Riders' },
  ] };
  const entries = async () => new Set(['7', '12']);

  test('nextStage: Prologue → Stage 1, Stage 1 → Stage 2, last/unknown → empty', () => {
    expect(ss.nextStage(obj, '5')).toBe('2');
    expect(ss.nextStage(obj, '2')).toBe('3');
    expect(ss.nextStage(obj, '3')).toBe('');
    expect(ss.nextStage(obj, '1')).toBe('');
  });

  test('a normal stage never moves a team on, even when it is missing from the start-list', async () => {
    expect(await ss.stageForTeam(race, { raceno: '52' }, '2', obj, { entries: async () => new Set(['7']) })).toBe('2');
  });

  test('entered team keeps the live stage; others move on; empty or failed start-list keeps live', async () => {
    expect(await ss.stageForTeam(race, { raceno: '7' }, '5', obj, { entries })).toBe('5');
    expect(await ss.stageForTeam(race, { raceno: '118' }, '5', obj, { entries })).toBe('2');
    expect(await ss.stageForTeam(race, { raceno: '118' }, '5', obj, { entries: async () => new Set() })).toBe('5');
    expect(await ss.stageForTeam(race, { raceno: '118' }, '5', obj, { entries: async () => { throw new Error('x'); } })).toBe('5');
  });

  test('Prologue with no start-list yet: Racing teams from Stage 1 race it, the rest show Stage 1', async () => {
    const calls = [];
    const fake = async (_r, ev, opts = {}) => { calls.push([ev, !!opts.racingOnly]); return ev === '5' ? new Set() : new Set(['30']); };
    expect(await ss.stageForTeam(race, { raceno: '30' }, '5', obj, { entries: fake })).toBe('5');
    expect(await ss.stageForTeam(race, { raceno: '67' }, '5', obj, { entries: fake })).toBe('2');
    expect(calls).toContainEqual(['2', true]);
    // Not the Prologue: an empty start-list keeps everyone on the live stage.
    expect(await ss.stageForTeam(race, { raceno: '67' }, '2', obj, { entries: async () => new Set() })).toBe('2');
  });

  test('racingOnly keeps just the "Racing" team types', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [
      { race_no: 301, team1: { race_no: 30, type: { name: 'Racing (19+) - Women' } } },
      { race_no: 671, team1: { race_no: 67, type: { name: 'Grand Masters (50-59) Men' } } },
    ], next_page_url: null }) });
    expect([...await ss.fetchStageEntries(race, '2', { racingOnly: true })]).toEqual(['30']);
  });

  test('fetchStageEntries reads team numbers off every start-list page', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ race_no: 71, team1: { race_no: 7 } }, { race_no: 1041, team1_race_no: 398 }], next_page_url: 'p2' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ race_no: 122, team1: {} }], next_page_url: null }) });
    const set = await ss.fetchStageEntries(race, '5');
    expect([...set].sort()).toEqual(['12', '398', '7']);
    expect(global.fetch.mock.calls[0][0]).toBe('https://api.sportsplits.com/v2/races/19801/events/5/start-list?page=1');
  });
});

describe('Elite GC: teams missing from the main GC are looked up in the other GC events', () => {
  const events = [{ id: '5', name: 'Prologue' }, { id: '2', name: 'Stage 1' }, { id: '1', name: 'GC' }, { id: '6', name: 'GC: Elite Women' }, { id: '8', name: 'GC E-Bike' }];
  const gcRace = { ...race, sportsplits_ebike_gc: '8' };

  test('gcCandidates: configured GC first, then other GC events, never the e-bike GC', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: events.map((e) => ({ event_id: e.id, name: e.name, date: '2026-11-06T00:00:00.000000Z' })) }) });
    expect(await ss.gcCandidates(gcRace, '1')).toEqual(['1', '6']);
    expect(global.fetch.mock.calls[0][0]).toBe('https://api.sportsplits.com/v2/races/19801/events');
  });

  test('fetchGcResult: main GC empty → Elite GC result; nowhere → null', async () => {
    const candidates = async () => ['1', '6'];
    const elite = { finish_time: '', splits: [{ name: 'Prologue', race_time: '00:47:45', overall_pos: 1 }] };
    const fetchTeam = jest.fn(async (_r, ev, no) => (ev === '6' && no === '4') ? elite : (ev === '1' ? { splits: [] } : null));
    const got = await ss.fetchGcResult(gcRace, '1', '4', { candidates, fetchTeam });
    expect(got.gc_event).toBe('6');
    expect(got.splits[0].race_time).toBe('00:47:45');
    expect(await ss.fetchGcResult(gcRace, '1', '999', { candidates, fetchTeam })).toBeNull();
  });
});

describe('Start sheet from Sportsplits waves (next-start card)', () => {
  const events = [{ id: '5', name: 'Prologue', date: '2026-11-05' }, { id: '2', name: 'Stage 1', date: '2026-11-06' },
    { id: '3', name: 'Stage 2', date: '2026-11-07' }, { id: '1', name: 'GC', date: '2026-11-06' }];

  test('fetchStageStarts: one entry per team from the riders\' wave (batch + gun time HH:MM)', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [
      { race_no: 1181, team1_race_no: 118, wave: { name: 'D', gun_time: '07:20:00' } },
      { race_no: 1182, team1_race_no: 118, wave: { name: 'D', gun_time: '07:20:00' } },
      { race_no: 21, team1_race_no: 2, wave_name: 'Elite Women', wave_gun_time: '07:00:00' },
      { race_no: 991, team1_race_no: 99, wave: null },
    ], next_page_url: null }) });
    const got = await ss.fetchStageStarts(race, '2');
    expect(got).toEqual({ 118: { chute: 'D', time: '07:20' }, 2: { chute: 'Elite Women', time: '07:00' } });
    expect(global.fetch.mock.calls[0][0]).toBe('https://api.sportsplits.com/v2/races/19801/events/2/start-list?page=1');
    expect(mockRedis.set).toHaveBeenCalledWith('ss:starts:19801:2', expect.any(String), 'EX', 300);
  });

  test('stageStartRows: a row per stage list the team is on; unpublished stage lists add nothing; GC skipped', async () => {
    const starts = jest.fn(async (_r, ev) => (ev === '2' ? { 118: { chute: 'D', time: '07:20' } } : {}));
    const rows = await ss.stageStartRows(race, 373, '118', { events: async () => events, starts });
    expect(rows).toEqual([{ race_id: 373, raceno: '118', event_id: '2', stage_no: 1, stage_name: 'Stage 1', start_date: '2026-11-06', start_time: '07:20', chute: 'D', updated_at: null }]);
    expect(starts.mock.calls.map((c) => c[1])).toEqual(['5', '2', '3']);   // never the GC event
  });

  test('stageStartRows: Sportsplits down → no rows (card stays quiet, nothing throws)', async () => {
    expect(await ss.stageStartRows(race, 373, '118', { events: async () => { throw new Error('boom'); } })).toEqual([]);
  });

  test('buildStagesDoc with wave rows: next_start = first stage without a result', () => {
    const { buildStagesDoc } = require('../src/services/stages');
    const results = [{ stage_no: 1, stage_name: 'Stage 1', stage_time: '03:10:00', gc_time: '03:10:00', updated_at: '2026-11-06T09:00:00Z' }];
    const starts = [
      { stage_no: 1, stage_name: 'Stage 1', start_date: '2026-11-06', start_time: '07:20', chute: 'D' },
      { stage_no: 2, stage_name: 'Stage 2', start_date: '2026-11-07', start_time: '07:15', chute: 'B' },
    ];
    expect(buildStagesDoc(results, starts).next_start).toEqual({ stage_no: 2, name: 'Stage 2', date: '2026-11-07', time: '07:15', chute: 'B' });
    expect(buildStagesDoc([], starts.slice(0, 1)).next_start).toEqual({ stage_no: 1, name: 'Stage 1', date: '2026-11-06', time: '07:20', chute: 'D' });
  });
});

describe('/v2/stages for Sportsplits: today\'s start is the CMS live stage', () => {
  jest.mock('../src/services/v2RaceConfig', () => ({ v2RaceObj: async () => null }), { virtual: false });
  test('live stage wave wins even when the team already has that stage\'s time', async () => {
    const stagesRoute = require('../src/routes/v2/stages');
    const Fastify = require('fastify');
    const app = Fastify();
    jest.spyOn(ss, 'sportsplitsRace').mockResolvedValue(race);
    jest.spyOn(ss, 'findTeam').mockResolvedValue({ raceno: '118', contest: '2' });
    jest.spyOn(ss, 'fetchGcResult').mockResolvedValue({ finish_time: '03:10:00', splits: [{ name: 'Stage 1', split_time: '03:10:00', race_time: '03:10:00', overall_pos: 5 }] });
    jest.spyOn(ss, 'stageStartRows').mockResolvedValue([
      { race_id: 373, raceno: '118', event_id: '2', stage_no: 1, stage_name: 'Stage 1', start_date: '2026-11-06', start_time: '07:25', chute: 'D', updated_at: null },
      { race_id: 373, raceno: '118', event_id: '3', stage_no: 2, stage_name: 'Stage 2', start_date: '2026-11-07', start_time: '07:15', chute: 'B', updated_at: null },
    ]);
    pool.query.mockImplementation(async (sql) => (/FROM v2\.races/.test(sql) ? { rows: [{ id: 373 }] } : { rows: [] }));
    app.addHook('onRequest', async (req) => { req.auth = { api_key_id: 1 }; });
    await app.register(stagesRoute, { prefix: '/v2/stages' });
    const res = await app.inject({ method: 'GET', url: '/v2/stages/chardonnay?bib=118' });
    expect(res.statusCode).toBe(200);
    // Dated today (race clock), not with Sportsplits' per-event date, which is the race's first day for every stage.
    expect(res.json().next_start).toEqual({ stage_no: 1, name: 'Stage 1', date: ss.todayIn('Africa/Johannesburg'), time: '07:25', chute: 'D' });
    jest.restoreAllMocks();
  });

  test('GC team is_active=false (IF rider) → empty stages, next start kept', async () => {
    const stagesRoute = require('../src/routes/v2/stages');
    const Fastify = require('fastify');
    const app = Fastify();
    jest.spyOn(ss, 'sportsplitsRace').mockResolvedValue(race);
    jest.spyOn(ss, 'findTeam').mockResolvedValue({ raceno: '101', contest: '3' });
    jest.spyOn(ss, 'fetchGcResult').mockResolvedValue({ is_active: false, finish_time: null, overall_pos: null,
      splits: [{ name: 'Stage 1', split_time: '04:04:01', race_time: '04:04:01', overall_pos: 112 }] });
    jest.spyOn(ss, 'stageStartRows').mockResolvedValue([
      { race_id: 373, raceno: '101', event_id: '3', stage_no: 2, stage_name: 'Stage 2', start_date: '2026-11-07', start_time: '07:25', chute: 'D', updated_at: null },
    ]);
    pool.query.mockImplementation(async (sql) => (/FROM v2\.races/.test(sql) ? { rows: [{ id: 373 }] } : { rows: [] }));
    app.addHook('onRequest', async (req) => { req.auth = { api_key_id: 1 }; });
    await app.register(stagesRoute, { prefix: '/v2/stages' });
    const res = await app.inject({ method: 'GET', url: '/v2/stages/chardonnay?bib=101' });
    expect(res.statusCode).toBe(200);
    expect(res.json().stages).toEqual([]);
    expect(res.json().gc).toBeUndefined();
    // Not the live stage (event 3 vs live '2'): the first stage without a result, with Sportsplits' own date.
    expect(res.json().next_start).toEqual({ stage_no: 2, name: 'Stage 2', date: '2026-11-07', time: '07:25', chute: 'D' });
    jest.restoreAllMocks();
  });
});
