/** RaceTec athlete splits: fetched from RaceTec on the server, rendered through the shared V2 builder. */
jest.mock('../src/config/redis', () => ({ get: jest.fn() }));
const v2racetec = require('../src/services/splits/v2racetec');

const race = { racetec_baseurl: 'https://evento.racetec.net/api/evento', racetec_apikey: 'KEY-1234' };
const raceobj = { timezone: 'Australia/Brisbane', events: [{
  contest_id: '4', event_descr: 'Half Marathon', distance: 21.1, use_net_times: false,
  splits: [
    { id: 1, rr_splitid: 1,  name: 'Start', order: 0, visible: 1, split_type: 'start' },
    { id: 2, rr_splitid: 20, name: '3km - Kirra', order: 1, visible: 1, split_type: 'split' },
    { id: 3, rr_splitid: 9,  name: '5.4km - Pacific Pde', order: 2, visible: 1, split_type: 'split' },
    { id: 4, rr_splitid: 99, name: 'Finish', order: 3, visible: 1, split_type: 'finish' },
  ],
}] };
const answer = {
  start_tod: '06:30:00', finish_tod: '', finish_time: '', net_time: '', overall_pos: '', webresults_link: 'https://results.example/4/1234',
  splits: [
    { split_id: 1,  order: 1, name: 'Start', race_time: '', tod: '06:30:00' },
    { split_id: 20, order: 3, name: '3km - Kirra', split_overall_pos: 127, split_gender_pos: 63, split_category_pos: 31,
      split_pace: '6:14', split_speed: 9.6, race_time: '00:18:42', tod: '06:48:42' },
    { split_id: 9,  order: 5, name: '5.4km - Pacific Pde', race_time: '', tod: '', estimated_next_split_race_time: '00:33:40', estimated_next_split_tod: '07:03:40' },
  ],
};

beforeEach(() => { global.fetch = jest.fn(async () => ({ ok: true, json: async () => answer })); });

test('calls RaceTec with the key, contest and bib — server side', async () => {
  await v2racetec.transform({ race, bib: '1234', raceobj, contest: '4' });
  const url = new URL(global.fetch.mock.calls[0][0]);
  expect(url.pathname).toMatch(/athletesplits\.aspx$/);
  expect(Object.fromEntries(url.searchParams)).toEqual({ ApiKey: 'KEY-1234', EId: '4', RaceNo: '1234' });
});

test('renders every configured split with RaceTec times, positions and predictions', async () => {
  const { livetiming } = await v2racetec.transform({ race, bib: '1234', raceobj, contest: '4' });
  expect(livetiming.contest_name).toBe('Half Marathon');
  expect(livetiming.finish_status).toBe(3);                  // started, not finished
  expect(livetiming.webresults_link).toBe('https://results.example/4/1234');
  const byName = Object.fromEntries(livetiming.splits.map((s) => [s.name, s]));
  expect(byName['Start'].tod).toBe('06:30:00');
  expect(byName['3km - Kirra']).toMatchObject({ RaceTime: '00:18:42', overall_place: '127', gen_place: '63', split_pace: '6:14' });
  expect(byName['5.4km - Pacific Pde'].estRaceTime).toBe('*00:33:40');
  expect(byName['Finish'].RaceTime).toBe('');
});

test('finished athlete: net time and final positions come from the top-level fields', async () => {
  answer.finish_tod = '08:12:00'; answer.finish_time = '01:42:00'; answer.net_time = '01:41:30';
  answer.overall_pos = 120; answer.gender_pos = 60; answer.category_pos = 25;
  answer.splits.push({ split_id: 99, order: 9, name: 'Finish', race_time: '01:42:00', tod: '08:12:00' });
  const { livetiming } = await v2racetec.transform({ race, bib: '1234', raceobj, contest: '4' });
  expect(livetiming.finish_status).toBe(4);
  expect(livetiming.result).toBe('01:42:00');
  expect(livetiming.overall_place).toBe('120');
});

test('RaceTec error or unknown athlete → null (caller falls through), never throws into the app', async () => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ Error: 'No athlete' }) }));
  expect(await v2racetec.transform({ race, bib: '1', raceobj, contest: '4' })).toBeNull();
  expect(await v2racetec.transform({ race: { racetec_apikey: null }, bib: '1', raceobj, contest: '4' })).toBeNull();
});

describe('mergePushed', () => {
  const { mergePushed } = require('../src/services/splits/v2racetec');
  test('adds a pushed crossing RaceTec does not list, and fills an untimed one', () => {
    const racetec = [
      { rr_id: 1, name: 'Start', tod: '05:05:00', time: '00:00:00' },
      { rr_id: 9, name: '3km', tod: '', time: '' },
    ];
    const pushed = [
      { rr_id: 9, name: '3km', tod: '05:39:00', time: '34:00' },
      { rr_id: 11, name: '6.3km', tod: '06:10:00', time: '65:00' },
    ];
    const out = mergePushed(racetec, pushed);
    expect(out.find((r) => r.rr_id === 9).tod).toBe('05:39:00');
    expect(out.find((r) => r.rr_id === 11).time).toBe('65:00');
    expect(out).toHaveLength(3);
  });
  test('RaceTec time wins over a pushed one', () => {
    const out = mergePushed([{ rr_id: 1, tod: '05:05:00', time: '00:00:00' }], [{ rr_id: 1, tod: '05:05:30', time: '00:00:30' }]);
    expect(out[0].tod).toBe('05:05:00');
  });
});
