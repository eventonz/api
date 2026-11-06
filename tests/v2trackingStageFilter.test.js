/** Stage races: a tracking marker only comes from the live stage's checkpoints. */
const mockRedis = { mget: jest.fn() };
jest.mock('../src/config/redis', () => mockRedis);
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
const { getTracksFromV2RedisSplits } = require('../src/services/tracking');

const raceobj = { events: [
  { contest_id: '5', event_descr: 'Prologue', distance: 18, splits: [
    { rr_splitid: 5001, name: 'Start', split_distance: 0 }, { rr_splitid: 5009, name: 'Finish', split_distance: 18 }] },
  { contest_id: '2', event_descr: 'Stage 1', distance: 61, splits: [
    { rr_splitid: 2008, name: 'Start', split_distance: 0 }, { rr_splitid: 2003, name: 'WP1', split_distance: 26 }] },
] };

test("yesterday's Prologue finish does not place the marker; today's crossing does", async () => {
  mockRedis.mget.mockResolvedValue([JSON.stringify({ bib: 2, splits: [{ rr_id: 5009, tod: '18:50:00', time: '00:51:11', finish: 1 }] })]);
  expect(await getTracksFromV2RedisSplits(['2'], 373, raceobj, new Set(['2']))).toEqual([]);
  expect((await getTracksFromV2RedisSplits(['2'], 373, raceobj, null))[0].percent_course).toBe(100);
  mockRedis.mget.mockResolvedValue([JSON.stringify({ bib: 2, splits: [
    { rr_id: 5009, tod: '18:50:00', time: '00:51:11', finish: 1 }, { rr_id: 2003, tod: '08:40:00', time: '01:40:00' }] })]);
  const t = await getTracksFromV2RedisSplits(['2'], 373, raceobj, new Set(['2']));
  expect(t[0]).toMatchObject({ contest_id: '2', splitname: 'WP1', distance: 26 });
});
