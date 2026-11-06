/** Sportsplits (W2W 2026): live team stage + GC fetched server side, merged with pushed crossings. */
const mockRedis = { get: jest.fn(), set: jest.fn(() => Promise.resolve('OK')) };
jest.mock('../src/config/redis', () => mockRedis);
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
const pool = require('../src/config/database');
const ss = require('../src/services/sportsplits');
const v2sportsplits = require('../src/services/splits/v2sportsplits');

const race = { id: 373, sportsplits_raceid: 19801, sportsplits_apikey: 'KEY', sportsplits_live_stage: '2', sportsplits_gc: '1',
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
    global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: events.map((e) => ({ event_id: e.id, name: e.name })) }) });
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
