/**
 * RaceResult transformer.
 * Mirrors API/api/v4/modules/split_scripts/transformers/therace.cfm
 *
 * Used for every RaceResult timer (timit, popupraces, secondwind, solemotive,
 * chronoconsult, racebase, therace, …) — therace.cfm is the single basis per
 * the migration decision; the legacy timit.cfm / popupraces.cfm variants are
 * not ported separately.
 *
 * Source of truth is the per-timer Postgres results table named by
 * raceobj.timing.results_table (NOT the redis_splits cache). Produces a
 * `livetiming` object with the same shape sportsplits.js emits, so downstream
 * build_header + athlete_detail_v2 consume it identically.
 */

const pool = require('../../../config/database');

// Postgres folds unquoted identifiers to lowercase, so the columns the legacy
// CF read in mixed case (SplitPredictedToD, SplitPredictedRaceTime) most likely
// come back lowercased. Look them up case-insensitively so the port is robust
// regardless of how each timer's table was created.
function makeRowReader(row) {
  const lower = {};
  for (const k of Object.keys(row || {})) lower[k.toLowerCase()] = row[k];
  return (name) => {
    const v = lower[String(name).toLowerCase()];
    return v == null ? '' : String(v);
  };
}

/**
 * Run the raceresult transformer.
 * @returns {{ livetiming: object, contestType: string|null, error: string|null }}
 */
async function transform(raceobj, { athleteId, raceId, contest }) {
  const livetiming = {};

  // --- Resolve + validate the results table name (pg can't parameterize it) ---
  const table = (raceobj.timing?.results_table || raceobj.results_table || '').trim();
  if (!table || !/^[a-z_][a-z0-9_]*$/.test(table)) {
    return { livetiming, contestType: 'nodata', error: null };
  }

  // --- Row selection: always keyed on athlete_id (the stable Evento identifier) ---
  if (!athleteId) return { livetiming, contestType: 'nodata', error: null };
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT * FROM ${table} WHERE athlete_id = $1 AND race_id = $2`,
      [String(athleteId), Number(raceId)]
    ));
  } catch (err) {
    return { livetiming, contestType: 'nodata', error: err.message };
  }

  // --- Contest resolution (therace: livetiming.contest_id = url.contest) ---
  const events = raceobj.events || [];
  let event = events.find((e) => String(e.contest_id) === String(contest ?? ''));
  // Fall back to the only contest when none was supplied (single-contest races).
  if (!event && events.length === 1) event = events[0];

  // Build a lookup of result rows by their split_id (= rr_splitid value).
  const rowsBySplit = new Map();
  for (const r of (rows || [])) {
    const reader = makeRowReader(r);
    const sid = Number(reader('split_id'));
    if (Number.isFinite(sid)) rowsBySplit.set(sid, reader);
  }

  livetiming.return_server = true;

  if (!event) {
    // No matching contest config — emit minimal shape.
    livetiming.finish_status = 2;
    livetiming.legs   = [];
    livetiming.splits = [];
    return { livetiming, contestType: 'nodata', error: null };
  }

  // --- Display fields from event config ---
  livetiming.contest_id       = event.contest_id;
  livetiming.contest_name     = event.event_descr || '';
  livetiming.contest_distance = event.distance;
  livetiming.medal_url        = event.medal || '';
  livetiming.use_net_times    = !!event.use_net_times;
  livetiming.use_estimates    = !!event.use_estimates;
  livetiming.cert_link        = event.cert_link  || '';
  livetiming.photo_link       = event.photo_link || '';
  livetiming.showPace         = !!event.showPace;
  livetiming.showRank         = !!event.showRank;

  livetiming.finish_status     = 2;
  livetiming.result            = '';
  livetiming.overall_place     = '';
  livetiming.overall_gen_place = '';
  livetiming.overall_cat_place = '';

  const contestType = event.contest_type || 'other';

  // --- Splits: iterate config splits, match DB rows by rr_splitid ---
  livetiming.splits = [];
  const cfgSplits = Array.isArray(event.splits) ? event.splits : [];
  let loopcount = 0;

  for (const cfg of cfgSplits) {
    loopcount++;
    const reader = (cfg.rr_splitid > 0 && rowsBySplit.has(Number(cfg.rr_splitid)))
      ? rowsBySplit.get(Number(cfg.rr_splitid))
      : null;

    const thesplit = {
      id:              cfg.id,
      name:            cfg.name,
      order:           cfg.order,
      visible:         cfg.visible,
      split_distance:  cfg.split_distance,
      fixed_elevation: cfg.fixed_elevation ?? '',
      split_type:      cfg.split_type ?? '',
      RaceTime:        '',
      tod:             '',
      leg_time:        '',
      split_time:      '',
      split_pace:      '',
      split_speed:     '',
      leg_pace:        '',
      leg_speed:       '',
      overall_place:   '',
      gen_place:       '',
      cat_place:       '',
      estTOD:          '',
      estRaceTime:     '',
    };

    if (reader) {
      // chip vs gun
      thesplit.RaceTime = livetiming.use_net_times ? reader('split_chip') : reader('split_gun');
      thesplit.tod      = reader('split_tod');
    }

    // Status checks use the ACTUAL tod (before any estimate override) — therace order.
    if (loopcount === 1 && thesplit.tod !== '') {
      livetiming.finish_status = 3;
    }
    if (loopcount === cfgSplits.length && thesplit.tod !== '') {
      livetiming.finish_status = 4;
    }

    if (reader) {
      // estimates
      const estTod = reader('splitpredictedtod');
      const estRt  = reader('splitpredictedracetime');
      if (estTod !== '') thesplit.estTOD     = '*' + estTod;
      if (estRt  !== '') thesplit.estRaceTime = '*' + estRt;
      if (thesplit.tod === '' && thesplit.estTOD !== '') {
        thesplit.tod = thesplit.estTOD;
      }

      // pace / speed
      thesplit.split_pace  = reader('splitpace');
      thesplit.split_speed = reader('splitspeed');

      // ranks
      thesplit.cat_place     = reader('agegroup_rank');
      thesplit.overall_place = reader('overall_rank');
      thesplit.gen_place     = reader('gender_rank');
    }

    livetiming.splits.push(thesplit);

    // Final split → roll up the overall result + placements.
    if (loopcount === cfgSplits.length) {
      livetiming.avg_pace          = thesplit.split_pace;
      livetiming.avg_speed         = '';
      livetiming.result            = thesplit.RaceTime;
      livetiming.overall_place     = thesplit.overall_place;
      livetiming.overall_gen_place = thesplit.gen_place;
      livetiming.overall_cat_place = thesplit.cat_place;
    }
  }

  // --- Legs: match each config leg's rr_splitid against a result row ---
  livetiming.legs = [];
  const cfgLegs = Array.isArray(event.legs) ? event.legs : [];
  for (const leg of cfgLegs) {
    const reader = (leg.rr_splitid > 0 && rowsBySplit.has(Number(leg.rr_splitid)))
      ? rowsBySplit.get(Number(leg.rr_splitid))
      : null;

    let leg_result = '';
    let leg_pace   = '';
    if (reader) {
      leg_result = reader('split_gun');               // legs always use gun time (therace)
      const speedType = leg.speed_type || 'speed';
      const pace  = reader('splitpace');
      const speed = reader('splitspeed');
      if (speedType === 'pace' && pace !== '') leg_pace = pace;
      else if (speed !== '')                   leg_pace = speed;
    }

    livetiming.legs.push({
      label:      leg.label || 'Leg',
      icon:       leg.icon  || '',
      leg_result,
      leg_pace,
    });
  }

  return { livetiming, contestType, error: null };
}

module.exports = { transform };
