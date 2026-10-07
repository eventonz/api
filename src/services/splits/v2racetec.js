/**
 * RaceTec athlete splits — fetched LIVE from RaceTec on the server.
 *
 * RaceTec events don't keep an athlete's splits in Redis: like the old CF
 * transformer (API/api/v4/modules/split_scripts/transformers/racetec.cfm) the
 * API asks RaceTec for the athlete each time —
 *   GET {racetec_baseurl}/athletesplits.aspx?ApiKey=&EId={contest}&RaceNo={bib}
 * — and maps the answer onto the same compact records the Redis path uses, so
 * v2rr.transformRecords + athleteDetailV2 render the identical document. The
 * app only ever calls /v2/splits/{event}; it never talks to RaceTec.
 *
 * athletesplits.aspx → { start_tod, finish_tod, finish_time, net_time,
 *   overall_pos, gender_pos, category_pos, net_*_pos, webresults_link,
 *   splits: [{ split_id, order, name, split_overall_pos, split_gender_pos,
 *              split_category_pos, split_pace, split_speed, leg_pace,
 *              leg_speed, split_time, race_time, leg_time, tod,
 *              estimated_next_split_race_time, estimated_next_split_tod }] }
 */

const { transformRecords, getAthleteRecords } = require('./v2rr');

const TIMEOUT_MS = 10_000;
const str = (v) => (v == null ? '' : String(v)).trim();

async function fetchAthlete(race, contest, bib) {
  const url = new URL(`${race.racetec_baseurl.replace(/\/+$/, '')}/athletesplits.aspx`);
  url.searchParams.set('ApiKey', race.racetec_apikey);
  url.searchParams.set('EId', String(contest));
  url.searchParams.set('RaceNo', String(bib));
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 300) return null;   // RaceTec's "no such athlete / no data yet"
  if (!res.ok) throw new Error(`RaceTec athletesplits → HTTP ${res.status}`);
  const data = await res.json();
  return data && typeof data === 'object' && Array.isArray(data.splits) ? data : null;
}

/** RaceTec's per-split rows → the compact record shape v2rr renders. */
function toRecords(data, cfgSplits) {
  const ids = cfgSplits.map((s) => Number(s.rr_splitid)).filter((n) => n > 0);
  const firstId = ids[0], lastId = ids[ids.length - 1];
  const finished = str(data.finish_tod) !== '' || str(data.finish_time) !== '';
  return data.splits.map((sp) => {
    const id = Number(sp.split_id) || 0;
    const isStart = id === firstId;
    const isFinish = id === lastId;
    const rec = {
      rr_id: id, name: str(sp.name), label: str(sp.name),
      tod: str(sp.tod), time: str(sp.race_time), chip: '', gun: '',
      rank: str(sp.split_overall_pos), rank_gender: str(sp.split_gender_pos), rank_ag: str(sp.split_category_pos),
      pace: str(sp.split_pace), speed: sp.split_speed ? String(sp.split_speed) : '',
      predicted: '', predicted_tod: '',
      start: isStart ? 1 : 0, finish: isFinish ? 1 : 0,
    };
    if (isStart && rec.tod === '' && str(data.start_tod)) rec.tod = str(data.start_tod);
    if (isFinish && finished) {
      rec.chip = str(data.net_time);
      if (!rec.time) rec.time = str(data.finish_time);
      if (!rec.tod) rec.tod = str(data.finish_tod);
      rec.rank = str(data.overall_pos) || rec.rank;
      rec.rank_gender = str(data.gender_pos) || rec.rank_gender;
      rec.rank_ag = str(data.category_pos) || rec.rank_ag;
    }
    // Predictions only on points not yet crossed.
    if (rec.tod === '' && str(sp.estimated_next_split_race_time)) {
      rec.predicted = str(sp.estimated_next_split_race_time);
      rec.predicted_tod = str(sp.estimated_next_split_tod);
    }
    return rec;
  });
}

/**
 * RaceTec's answer wins, but a crossing the timer PUSHED to us (Redis, via
 * the worker) that RaceTec's own API doesn't show yet is added — or fills a
 * point RaceTec lists without a time. Without this the live fetch hid pushed
 * crossings whenever RaceTec answered at all.
 */
function mergePushed(records, pushed) {
  if (!pushed.length) return records;
  const byId = new Map(records.map((r) => [Number(r.rr_id), r]));
  for (const p of pushed) {
    const id = Number(p.rr_id);
    if (!(id > 0)) continue;
    const cur = byId.get(id);
    if (!cur) { records.push({ ...p, label: p.label || p.name || '' }); byId.set(id, p); continue; }
    if (str(cur.tod) === '' && str(p.tod) !== '') Object.assign(cur, { tod: p.tod, time: p.time || cur.time, chip: p.chip || cur.chip, pace: p.pace || cur.pace, speed: p.speed || cur.speed, rank: p.rank || cur.rank, rank_gender: p.rank_gender || cur.rank_gender, rank_ag: p.rank_ag || cur.rank_ag, predicted: '', predicted_tod: '' });
  }
  return records;
}

/**
 * @param {object} args
 * @param {object} args.race      v2.races row with racetec_baseurl + racetec_apikey
 * @param {string} args.bib       the athlete's race number (RaceTec identity)
 * @param {object} args.raceobj   v2RaceObj output
 * @param {string} args.contest   contest id (RaceTec event id)
 * @param {string} [args.athleteId] for the pushed-crossings merge (= bib for RaceTec)
 * @returns {Promise<{livetiming, contestType}|null>} null = RaceTec had nothing
 */
async function transform({ race, bib, raceobj, contest, athleteId }) {
  if (!bib || !race?.racetec_apikey || !race?.racetec_baseurl || !contest) return null;
  const data = await fetchAthlete(race, contest, bib);
  if (!data) return null;
  const event = (raceobj?.events || []).find((e) => String(e.contest_id) === String(contest));
  const pushed = await getAthleteRecords(race.id, athleteId || bib);
  const records = mergePushed(toRecords(data, event?.splits || []), pushed?.splits || []);
  const out = transformRecords({ records, raceobj, contest });
  if (out && str(data.webresults_link)) out.livetiming.webresults_link = str(data.webresults_link);
  return out;
}

module.exports = { transform, toRecords, mergePushed };
