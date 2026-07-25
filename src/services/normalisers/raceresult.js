/**
 * RaceResult push normaliser — port of
 * API/api/v4/modules/convert_data/raceresult.cfm.
 *
 * Two formats arrive at the raceresult ingest endpoint:
 *
 * 1. Ugo's data (native RR): JSON ARRAY of timing records, PascalCase fields
 *    (Bib, ID, SplitID, RR_SplitID, SplitToD, SplitRaceTime, Message_en, …).
 *    Only records with a non-empty Message_en are athlete triggers; the rest
 *    are background timing data and are ignored.
 *
 * 2. RR API data (Evento-created exporter): single JSON STRUCT per athlete
 *    trigger, lowercase fields (bib, rr_splitid, athlete_id, race_time, tod,
 *    …), always carrying "evento_created": true. A comprehensive variant
 *    arrives as an ARRAY whose records carry the same flag.
 *
 * Records without a positive rr_splitid cannot be matched to a split and are
 * dropped with an entry on the Redis `data_issues` list (mirrors CF).
 */

const redis = require('../../config/redis');

// CF struct access is case-insensitive; JSON in JS is not. Read defensively.
function makeReader(rec) {
  const lower = {};
  for (const k of Object.keys(rec || {})) lower[k.toLowerCase()] = rec[k];
  return (name, dflt = '') => {
    const v = lower[name.toLowerCase()];
    return v == null ? dflt : v;
  };
}

const num = (v) => Number(v) || 0;
const str = (v) => (v == null ? '' : String(v));

// Ugo's data record (PascalCase) → trackdata
function normaliseNativeRR(item, raceobj) {
  const get = makeReader(item);
  const td = {};

  td.race_no = num(get('bib', 0));

  const rrSplitId = num(get('rr_splitid', 0));
  td.rr_splitid = rrSplitId > 0 ? rrSplitId : 0;
  td.split_id   = rrSplitId > 0 ? rrSplitId : num(get('splitid', 0));

  td.tod        = str(get('splittod'));
  td.race_time  = str(get('splitracetime'));
  td.split_name = str(get('splitname'));

  // Start splits always have empty race/gun/chip times — default to 00:00:00
  if (num(get('start', 0)) === 1 && td.race_time.trim() === '') {
    td.race_time = '00:00:00';
  }

  const speed = num(get('splitspeed', 0));
  td.speed = speed > 0 ? speed : 0;

  if (num(get('contestid', 0)) > 0)     td.contest_id = num(get('contestid'));
  else if (num(get('contest', 0)) > 0)  td.contest_id = num(get('contest'));
  else if (raceobj.events?.length)      td.contest_id = raceobj.events[0].contest_id;
  else                                  td.contest_id = 0;

  const id = str(get('id')).trim();
  if (raceobj.athlete_key === 'raceno') td.athlete_id = td.race_no;
  else if (id !== '')                   td.athlete_id = id;
  else                                  td.athlete_id = td.race_no;

  const firstname = str(get('firstname')).trim();
  const lastname  = str(get('lastname')).trim();
  td.name = (firstname || lastname) ? `${firstname} ${lastname}`.trim() : td.race_no;

  td.marker_text = td.race_no;

  // Use RaceResult's own message if present; tracks pipeline builds one if empty
  td.message = str(get('message_en')).trim();

  // Ranking and timing detail fields
  td.split_chip          = str(get('splitchiptime'));
  td.overall_rank        = str(get('splitoverallrank'));
  td.gender_rank         = str(get('splitgenderrank'));
  td.agegroup_rank       = str(get('splitagegrouprank'));
  td.split_pace          = str(get('splitpace'));
  td.predicted_tod       = str(get('splitpredictedtod'));
  td.predicted_race_time = str(get('splitpredictedracetime'));

  return td;
}

// Evento exporter record (lowercase) → trackdata
function normaliseEventoRR(item, raceobj) {
  const get = makeReader(item);
  const td = {};

  td.race_no = num(get('bib', 0));

  const rrSplitId = num(get('rr_splitid', 0));
  td.rr_splitid = rrSplitId > 0 ? rrSplitId : 0;
  // Use rr_splitid as split_id so both matching paths in processContestandSplits work
  td.split_id = td.rr_splitid;

  td.tod        = str(get('tod'));
  td.race_time  = str(get('race_time'));
  td.split_name = str(get('split_name')).trim();

  if (num(get('start', 0)) === 1 && td.race_time.trim() === '') {
    td.race_time = '00:00:00';
  }

  const speed = num(get('split_speed', 0));
  td.speed = speed > 0 ? speed : 0;

  if (num(get('contestid', 0)) > 0)  td.contest_id = num(get('contestid'));
  else if (raceobj.events?.length)   td.contest_id = raceobj.events[0].contest_id;
  else                               td.contest_id = 0;

  const athleteId = str(get('athlete_id')).trim();
  if (raceobj.athlete_key === 'raceno') td.athlete_id = td.race_no;
  else if (athleteId !== '')            td.athlete_id = athleteId;
  else                                  td.athlete_id = td.race_no;

  const firstname = str(get('firstname')).trim();
  const lastname  = str(get('lastname')).trim();
  td.name = (firstname || lastname) ? `${firstname} ${lastname}`.trim() : td.race_no;

  td.marker_text = td.race_no;
  td.message     = '';

  return td;
}

function logDataIssue(raceId, error, payload) {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
    race_id:   Number(raceId),
    error,
    payload:   JSON.stringify(payload),
  });
  redis.rpush('data_issues', entry).catch(() => {});
}

function isEventoCreated(rec) {
  if (rec == null || typeof rec !== 'object') return false;
  const flag = makeReader(rec)('evento_created', false);
  return flag === true || flag === 'true' || flag === 1;
}

function normalise(payload, raceobj, raceId) {
  if (Array.isArray(payload)) {
    const trackdataarray = [];

    if (payload.length > 0 && isEventoCreated(payload[0])) {
      // Comprehensive Evento exporter — each element is one split for the athlete
      for (const item of payload) {
        const td = normaliseEventoRR(item, raceobj);
        if (td.rr_splitid > 0) trackdataarray.push(td);
        else logDataIssue(raceId, 'rr_splitid missing or zero in batch record — skipped', td);
      }
    } else {
      // Ugo's data — full array of timing records for every chip read.
      // Only records with Message_en present and non-empty are triggers.
      for (const item of payload) {
        if (str(makeReader(item)('message_en')).trim() === '') continue;
        const td = normaliseNativeRR(item, raceobj);
        if (td.rr_splitid > 0) trackdataarray.push(td);
        else logDataIssue(raceId, 'rr_splitid missing or zero in batch record — skipped', td);
      }
    }
    return { trackdataarray };
  }

  // Single struct — format detected by the evento_created flag
  const td = isEventoCreated(payload)
    ? normaliseEventoRR(payload, raceobj)
    : normaliseNativeRR(payload, raceobj);

  if (td.rr_splitid === 0) {
    logDataIssue(raceId, 'rr_splitid missing or zero — cannot match split', td);
    return { trackdataarray: [] }; // dropped — queued jobs have no 400 path
  }
  return { trackdata: td };
}

module.exports = { normalise, normaliseNativeRR, normaliseEventoRR };
