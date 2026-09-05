/**
 * V2-native splits transformer.
 *
 * Reads the athlete's compact records from redis_splits:{v2_race_id}:athlete:
 * {athlete_id} (written by services/raceresult/v2Pull.js from the provisioned
 * `evento|full-results` list) and produces the same `livetiming` object the
 * raceresult transformer emits, so buildHeader + athleteDetailV2 render it
 * unchanged.
 *
 * Record shape (see listTemplate.buildColumnFields):
 *   { name, label, rr_id, tod, time, gun, chip, rank, rank_gender, rank_ag,
 *     pace, speed, predicted, leg?, start, finish }
 * Only splits with a time or a prediction are present in the feed.
 *
 * Config is an enhancement, not a requirement:
 *   - With v2 contest config (raceobj.events[].splits), the page shows every
 *     CONFIGURED split — dashes for uncrossed ones — matched on
 *     cfg.rr_splitid ↔ rec.rr_id, with config visibility/distances.
 *   - Without config, the page renders the athlete's records in feed order —
 *     everything RaceResult knows about them.
 */

const redis = require('../../config/redis');

async function getAthleteRecords(v2RaceId, athleteId) {
  try {
    const raw = await redis.get(`redis_splits:${v2RaceId}:athlete:${athleteId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.splits) ? parsed : null;
  } catch {
    return null;
  }
}

function emptySplitRow(base) {
  return {
    id: '', name: '', order: 0, visible: 1,
    split_distance: 0, fixed_elevation: '', split_type: '',
    RaceTime: '', tod: '', leg_time: '', split_time: '',
    split_pace: '', split_speed: '', leg_pace: '', leg_speed: '',
    overall_place: '', gen_place: '', cat_place: '',
    estTOD: '', estRaceTime: '',
    ...base,
  };
}

function fillFromRecord(row, rec, useNetTimes) {
  // Gun-time display uses the race time ([name] itself), matching the v1
  // feed where SplitRaceTime fed the split_gun column — rec.gun is the
  // gun-offset variant and reads wrong for wave starts.
  row.RaceTime      = useNetTimes ? (rec.chip || '') : (rec.time || '');
  row.tod           = rec.tod || '';
  row.split_pace    = rec.pace || '';
  row.split_speed   = rec.speed || '';
  row.overall_place = rec.rank || '';
  row.gen_place     = rec.rank_gender || '';
  row.cat_place     = rec.rank_ag || '';
  if ((rec.predicted || '') !== '') {
    row.estRaceTime = `*${rec.predicted}`;
    if (row.tod === '') {
      row.estTOD = `*${rec.predicted}`;
      row.tod = row.estTOD;
    }
  }
  return row;
}

/**
 * @param {object} args
 * @param {number|string} args.v2RaceId    v2.races id (the Redis key id)
 * @param {string}        args.athleteId   athlete_id (RR participant ID)
 * @param {object|null}   args.raceobj     v2RaceObj output (may have events: [])
 * @param {string}        args.contest     contest id the app sent ('' if unknown)
 * @returns {Promise<{livetiming: object, contestType: string}|null>}
 *          null = no cached data for this athlete (caller falls through)
 */
async function transform({ v2RaceId, athleteId, raceobj, contest }) {
  if (!athleteId) return null;
  const cached = await getAthleteRecords(v2RaceId, athleteId);
  if (!cached) return null;

  const records = cached.splits;
  const legs    = records.filter((r) => r.leg);
  const splits  = records.filter((r) => !r.leg);
  const byRRId  = new Map();
  for (const r of splits) byRRId.set(String(r.rr_id), r);

  const events = Array.isArray(raceobj?.events) ? raceobj.events : [];
  let event = events.find((e) => String(e.contest_id) === String(contest ?? ''));
  if (!event && events.length === 1) event = events[0];

  const livetiming = {
    return_server: true,
    contest_id:       event?.contest_id ?? (contest || ''),
    contest_name:     event?.event_descr ?? '',
    contest_distance: event?.distance ?? '',
    medal_url:        event?.medal || '',
    use_net_times:    !!event?.use_net_times,
    use_estimates:    !!event?.use_estimates,
    cert_link:        event?.cert_link  || '',
    photo_link:       event?.photo_link || '',
    showPace:         !!event?.showPace,
    showRank:         !!event?.showRank,
    finish_status: 2,
    result: '', overall_place: '', overall_gen_place: '', overall_cat_place: '',
    avg_pace: '', avg_speed: '',
    splits: [], legs: [],
  };
  const useNet = livetiming.use_net_times;

  const cfgSplits = Array.isArray(event?.splits) ? event.splits : [];
  if (cfgSplits.length) {
    // Config-driven: every configured split, dashes where no record exists.
    cfgSplits.forEach((cfg, i) => {
      const rec = cfg.rr_splitid > 0 ? byRRId.get(String(cfg.rr_splitid)) : null;
      const row = emptySplitRow({
        id: cfg.id, name: cfg.name, order: cfg.order ?? 0,
        visible: cfg.visible ?? 1,
        split_distance: cfg.split_distance ?? 0,
        fixed_elevation: cfg.fixed_elevation ?? '',
        split_type: cfg.split_type ?? '',
      });
      if (rec) fillFromRecord(row, rec, useNet);
      if (i === 0 && row.tod !== '' && !row.tod.startsWith('*')) livetiming.finish_status = 3;
      if (i === cfgSplits.length - 1 && row.tod !== '' && !row.tod.startsWith('*')) livetiming.finish_status = 4;
      livetiming.splits.push(row);
    });
  } else {
    // Config-less: render the athlete's records chronologically. Feed order
    // is the template's block order across ALL contests, so another
    // contest's splits interleave — time-of-day is the truth. Records with
    // no tod (prediction-only) sort last in their feed position.
    const todKey = (r) => {
      const t = String(r.tod || '');
      return /^\d/.test(t) ? (t.length === 7 ? '0' + t : t) : '~';
    };
    splits.sort((a, b) => (todKey(a) < todKey(b) ? -1 : todKey(a) > todKey(b) ? 1 : 0));
    splits.forEach((rec, i) => {
      const row = emptySplitRow({
        id: rec.rr_id, name: rec.label || rec.name, order: i,
      });
      fillFromRecord(row, rec, useNet);
      livetiming.splits.push(row);
      if (rec.tod && rec.start) livetiming.finish_status = Math.max(livetiming.finish_status, 3);
      if (rec.tod && rec.finish) livetiming.finish_status = 4;
    });
  }

  // Roll up the overall result from the finish.
  const finishRec = splits.find((r) => r.finish && (r.tod || '') !== '');
  if (finishRec) {
    livetiming.result            = useNet ? (finishRec.chip || finishRec.time || '') : (finishRec.time || '');
    livetiming.overall_place     = finishRec.rank || '';
    livetiming.overall_gen_place = finishRec.rank_gender || '';
    livetiming.overall_cat_place = finishRec.rank_ag || '';
    livetiming.avg_pace          = finishRec.pace || '';
    livetiming.finish_status     = 4;
  }

  // Legs section — config legs matched by rr_splitid when present, else raw.
  const cfgLegs = Array.isArray(event?.legs) ? event.legs : [];
  if (cfgLegs.length) {
    const legByRRId = new Map(legs.map((r) => [String(r.rr_id), r]));
    for (const leg of cfgLegs) {
      const rec = leg.rr_splitid > 0 ? legByRRId.get(String(leg.rr_splitid)) : null;
      let leg_pace = '';
      if (rec) {
        leg_pace = (leg.speed_type === 'pace' && rec.pace) ? rec.pace : (rec.speed || '');
      }
      livetiming.legs.push({
        label: leg.label || 'Leg',
        icon:  leg.icon || '',
        leg_result: rec ? (rec.time || '') : '',
        leg_pace,
      });
    }
  } else {
    for (const rec of legs) {
      if ((rec.time || '') === '') continue;
      livetiming.legs.push({
        label: rec.label || rec.name,
        icon: '',
        leg_result: rec.time || '',
        leg_pace: rec.pace || rec.speed || '',
      });
    }
  }

  const contestType = event?.contest_type || 'other';
  return { livetiming, contestType };
}

module.exports = { transform, getAthleteRecords };
