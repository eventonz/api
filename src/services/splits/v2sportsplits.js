/**
 * Sportsplits team splits for the LIVE stage — fetched from Sportsplits on the
 * server (services/sportsplits.js), merged with the crossings Sportsplits
 * pushed to us (redis_splits, via the worker), and rendered by the same
 * v2rr.transformRecords as RaceResult/RaceTec, so the app sees the usual
 * athlete-detail document. The app only ever calls /v2/splits/{event}.
 */

const { transformRecords, getAthleteRecords } = require('./v2rr');
const { mergePushed } = require('./v2racetec');
const { splitKey } = require('../sportsplits');

const str = (v) => (v == null ? '' : String(v)).trim();
const kmh = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? String(Math.round(n * 10) / 10) : '';
};

/** Sportsplits' race_event_team for one stage → compact records (rr_id = contest*1000 + split_id). */
function toRecords(team, contest, cfgSplits = []) {
  const splits = Array.isArray(team?.splits) ? team.splits : [];
  const ids = cfgSplits.map((s) => Number(s.rr_splitid)).filter((n) => n > 0);
  const firstId = ids[0], lastId = ids[ids.length - 1];
  const finished = str(team?.finish_time) !== '';
  return splits.map((sp) => {
    const id = splitKey(contest, sp.split_id);
    const isFinish = id === lastId;
    const rec = {
      rr_id: id, name: str(sp.name), label: str(sp.name),
      tod: str(sp.tod), time: str(sp.race_time), chip: '', gun: '',
      rank: str(sp.overall_pos), rank_gender: '', rank_ag: str(sp.type_pos),
      pace: '', speed: kmh(sp.leg_speed ?? sp.split_speed),
      predicted: '', predicted_tod: '',
      start: id === firstId ? 1 : 0, finish: isFinish ? 1 : 0,
    };
    if (rec.start) { rec.rank = ''; rec.rank_ag = ''; rec.speed = ''; if (!rec.time) rec.time = '00:00:00'; }
    if (isFinish && finished) {
      rec.time = rec.time || str(team.finish_time);
      rec.rank = str(team.overall_pos) || rec.rank;
      rec.rank_ag = str(team.type_pos) || rec.rank_ag;
    }
    return rec;
  });
}

/**
 * @param {object} args
 * @param {object} args.race      sportsplitsRace() row
 * @param {object} args.team      { raceno, athlete_id }
 * @param {string} args.stage     contest id of the live stage
 * @param {object} args.raceobj   v2RaceObj output
 * @param {Function} args.fetchTeam  (race, eventId, teamNo) → race_event_team|null (throws on failure)
 * @returns {Promise<{livetiming, contestType, team}|null>}
 */
async function transform({ race, team, stage, raceobj, fetchTeam }) {
  if (!race || !team?.raceno || !stage) return null;
  const event = (raceobj?.events || []).find((e) => String(e.contest_id) === String(stage));
  let live = null;
  try { live = await fetchTeam(race, stage, team.raceno); } catch { live = null; }
  const pushed = await getAthleteRecords(race.id, team.athlete_id || team.raceno);
  const pushedHere = (pushed?.splits || []).filter((r) => Math.floor(Number(r.rr_id) / 1000) === Number(stage));
  const records = mergePushed(live ? toRecords(live, stage, event?.splits || []) : [], pushedHere);
  const out = transformRecords({ records, raceobj, contest: stage });
  if (!out) return null;
  if (live && str(live.finish_time)) {
    out.livetiming.result = str(live.finish_time);
    out.livetiming.overall_place = str(live.overall_pos);
    out.livetiming.overall_cat_place = str(live.type_pos);
    out.livetiming.finish_status = 4;
  }
  return { ...out, team: live };
}

module.exports = { transform, toRecords };
