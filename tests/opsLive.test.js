/** /v2/ops/live — folding raw timer pushes and the race log for the CMS Live dashboard. */
const { summarisePushes, summariseLog } = require('../src/services/opsLive');

const T0 = Date.parse('2026-10-31T19:40:00Z');
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
const entry = (sec, body) => JSON.stringify({ at: at(sec), platform: 'raceresult', body });

test('evento pushes: split ids, split 0 / empty, distinct bibs, RaceResult empty-expression repair', () => {
  const rows = [
    entry(50, '{"bib":1003,"rr_splitid":"1392","athlete_id":"489","race_time":"00:00:00","tod":"07:00:01","start":1,"finish":0,"split_speed":,"evento_created":true}'),
    entry(49, '{"bib":1004,"rr_splitid":"1393","race_time":"00:21:10","tod":"07:21:11","start":0,"finish":0,"split_speed":12.1,"evento_created":true}'),
    entry(48, '{"bib":1003,"rr_splitid":"1393","race_time":"00:21:40","evento_created":true}'),
    entry(47, '{"bib":1818,"rr_splitid":"0","race_time":"","tod":"","start":0,"finish":0,"split_speed":"","evento_created":true}'),
    entry(-5, '{"bib":1,"rr_splitid":"1392","evento_created":true}'), // outside window
  ];
  const s = summarisePushes(rows, T0);
  expect(s).toMatchObject({ pushes: 4, evento: 4, native: 0, unparseable: 0, with_split: 3, no_split: 1, bibs: 3, newest: at(50) });
  expect(s.split_ids).toEqual({ 1392: 1, 1393: 2, 0: 1 });
});

test("Ugo's native array and junk bodies are counted but not mistaken for the Evento exporter", () => {
  const rows = [
    entry(10, '[{"Bib":7,"RR_SplitID":12,"Message_en":"x"},{"Bib":8,"RR_SplitID":12}]'),
    entry(9, 'not json at all'),
  ];
  const s = summarisePushes(rows, T0);
  expect(s).toMatchObject({ pushes: 2, evento: 0, native: 1, unparseable: 1, with_split: 2, bibs: 2 });
  expect(s.split_ids).toEqual({ 12: 2 });
});

test('log summary: three latest pulls, startlist, first errors, recent lines without push/notify noise', () => {
  const log = [
    { at: at(60), kind: 'push', msg: 'received 1 record' },
    { at: at(59), kind: 'notify', msg: 'sent → x' },
    { at: at(58), kind: 'pull', msg: '15488 records / 3915 athletes' },
    { at: at(57), kind: 'webhook', msg: 'participant added: bib 1' },
    { at: at(56), kind: 'athletes', msg: 'startlist refreshed: 3917 in RaceResult' },
    { at: at(55), kind: 'error', msg: 'boom' },
    { at: at(54), kind: 'pull', msg: '10608 records' },
    { at: at(53), kind: 'pull', msg: '6592 records' },
    { at: at(52), kind: 'pull', msg: '576 records' },
    { at: at(51), kind: 'state', msg: 'live (CMS Go live)' },
  ];
  const s = summariseLog(log, { recent: 4 });
  expect(s.pulls.map((p) => p.msg)).toEqual(['15488 records / 3915 athletes', '10608 records', '6592 records']);
  expect(s.startlist.at).toBe(at(56));
  expect(s.state.msg).toBe('live (CMS Go live)');
  expect(s.errors).toHaveLength(1);
  expect(s.recent.map((r) => r.kind)).toEqual(['pull', 'webhook', 'athletes', 'error']);
});
