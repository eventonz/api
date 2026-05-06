/**
 * SportSplits transformer.
 * Mirrors API/api/v4/modules/split_scripts/transformers/sportsplits.cfm
 *
 * Produces a `livetiming` object with the same shape the CF version emits, then
 * downstream stages (build_header, athlete_detail_v2) consume it identically.
 */

const pool = require('../../../config/database');
const {
  raceTimeToSeconds,
  timeOfDayToSeconds,
  secondsToRaceTime,
  nowInTzSeconds,
  formatEstTod,
} = require('../timeHelpers');

const SS_API_KEY  = 'BGE7FS8EY98DFAT57K7XL527F6CA58CJ';
const SS_BASE     = 'https://api.sportsplits.com/v2';
const SS_TIMEOUT  = 10000;

async function lookupBibFromAthleteId(athleteId, raceId) {
  const { rows } = await pool.query(
    'SELECT raceno FROM athletes WHERE athlete_id = $1 AND race_id = $2 LIMIT 1',
    [String(athleteId), Number(raceId)]
  );
  return rows[0]?.raceno || '';
}

async function fetchSportsplits(raceobj, { bib, athleteId, raceId }) {
  // Mirror CF endpoint selection:
  //   - script=sportsplits + athlete_key=raceno → race_no=
  //   - script=sportsplits (default)            → import_key=
  //   - non-sportsplits scripts                 → race_no=
  const useRaceNo =
    (raceobj.timing.script === 'sportsplits' && raceobj.athlete_key === 'raceno') ||
    raceobj.timing.script !== 'sportsplits';

  let lookupBib = bib || '';
  if (useRaceNo && !lookupBib && athleteId) {
    lookupBib = await lookupBibFromAthleteId(athleteId, raceId);
  }

  const param = useRaceNo
    ? `race_no=${encodeURIComponent(lookupBib)}`
    : `import_key=${encodeURIComponent(athleteId || '')}`;

  const url = `${SS_BASE}/races/${raceobj.ss_raceid}/results/individuals/?${param}&estimated_splits=true&splits=true`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SS_TIMEOUT);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'X-API-KEY': SS_API_KEY },
      signal: controller.signal,
    });
    if (!res.ok) return { status: res.status, data: null };
    const json = await res.json();
    return { status: 200, data: json };
  } catch (err) {
    return { status: 408, data: null, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the sportsplits transformer.
 * @returns {{ livetiming: object, contestType: string|null, error: string|null }}
 */
async function transform(raceobj, { bib, athleteId, raceId }) {
  const livetiming = { race_clock: '00:00:00' };
  let error = null;

  const httpRes = await fetchSportsplits(raceobj, { bib, athleteId, raceId });

  let data = null;
  let splitdata = [];
  let estimates = [];
  let noData = false;
  let returnServer = false;

  if (httpRes.status === 200 && httpRes.data) {
    try {
      const root = httpRes.data;
      data = Array.isArray(root.data) ? root.data[0] : null;
      if (!data) throw new Error('empty data array');

      splitdata = Array.isArray(data.splits) ? data.splits : [];
      estimates = Array.isArray(data.estimated_splits) ? data.estimated_splits : [];
      returnServer = true;

      livetiming.contest_id     = data.event?.id;
      livetiming.contest_name   = data.event?.name ?? '';
      livetiming.finish_status  = data.finish_status?.id ?? 2;
      livetiming.gender_name    = data.gender?.name?.trim()   || 'Gender';
      livetiming.category_name  = data.category?.name?.trim() || 'Category';
    } catch {
      noData = true;
      data = null;
      splitdata = [];
      estimates = [];
      livetiming.finish_status = 2;
      livetiming.contest_name  = ' ';
      livetiming.contest_id    = 99;
    }
  } else if (httpRes.status === 408) {
    noData = true;
    error = 'timeout';
    livetiming.finish_status = 2;
    livetiming.contest_name  = ' ';
    livetiming.contest_id    = 99;
  } else {
    noData = true;
    livetiming.finish_status = 2;
    livetiming.contest_name  = ' ';
    livetiming.contest_id    = 99;
  }

  if (noData && livetiming.contest_id === 99) {
    return {
      livetiming,
      contestType: error === 'timeout' ? 'timeout' : 'nodata',
      error,
    };
  }

  // -- Build the rest of livetiming from raceobj.events + sportsplits data -----
  const events = raceobj.events || [];
  if (!events.length) {
    return { livetiming, contestType: 'nodata', error: null };
  }

  const event = events.find((e) => String(e.contest_id) === String(livetiming.contest_id));
  if (!event) {
    return { livetiming, contestType: 'nodata', error: null };
  }

  livetiming.return_server     = returnServer;
  livetiming.gen_place         = '';
  livetiming.cat_place         = '';
  livetiming.overall_place     = '';
  livetiming.legs              = [];
  livetiming.medal_url         = event.medal || '';
  livetiming.use_net_times     = !!event.use_net_times;
  livetiming.use_estimates     = !!event.use_estimates;
  livetiming.cert_link         = event.cert_link || '';
  livetiming.photo_link        = event.photo_link || '';
  livetiming.showRank          = !!event.showRank;
  livetiming.showPace          = !!event.showPace;
  livetiming.contest_distance  = event.distance;
  const contestType            = event.contest_type;

  // --- Finish placements ---
  const isFinished = String(livetiming.finish_status) === '4';
  if (isFinished) {
    if (livetiming.use_net_times) {
      livetiming.result            = data.net_time != null ? String(data.net_time) : '';
      livetiming.overall_gen_place = data.net_gender_pos   != null && String(data.net_gender_pos).trim()   ? String(data.net_gender_pos)   : '';
      livetiming.overall_cat_place = data.net_category_pos != null && String(data.net_category_pos).trim() ? String(data.net_category_pos) : '';
      livetiming.overall_place     = data.net_overall_pos  != null && String(data.net_overall_pos).trim()  ? String(data.net_overall_pos)  : '';
    } else {
      livetiming.result            = data.finish_time != null ? String(data.finish_time) : '';
      livetiming.overall_gen_place = data.gender_pos   != null ? String(data.gender_pos)   : '';
      livetiming.overall_cat_place = data.category_pos != null ? String(data.category_pos) : '';
      livetiming.overall_place     = data.overall_pos  != null ? String(data.overall_pos)  : '';
    }
    livetiming.cat_pos_finishers     = data.category_pos_finishers ? '/' + String(data.category_pos_finishers) : '';
    livetiming.gen_pos_finishers     = data.gender_pos_finishers   ? '/' + String(data.gender_pos_finishers)   : '';
    livetiming.overall_pos_finishers = data.overall_pos_finishers  ? '/' + String(data.overall_pos_finishers)  : '';
  } else {
    livetiming.result = '';
    livetiming.overall_gen_place = '';
    livetiming.overall_cat_place = '';
    livetiming.overall_place = '';
    livetiming.cat_pos_finishers = '';
    livetiming.gen_pos_finishers = '';
    livetiming.overall_pos_finishers = '';
  }

  // --- Build splits + legs from event config matched against splitdata ---
  livetiming.splits = [];
  const lastBoth = { tod: '', racetime: '', todSeconds: -1, raceTimeSeconds: 0 };

  for (const split of (event.splits || [])) {
    const sd = splitdata.find((s) => String(s.split_id) === String(split.id)) || null;

    const thesplit = {
      id:              split.id,
      name:            split.name,
      order:           split.order,
      visible:         split.visible,
      split_distance:  split.split_distance,
      fixed_elevation: split.fixed_elevation || '',
      split_type:      split.split_type || '',
      RaceTime:        sd?.race_time != null ? String(sd.race_time) : '',
      tod:             sd?.tod       != null ? String(sd.tod)       : '',
      leg_time:        sd?.leg_time  != null ? String(sd.leg_time)  : '',
      split_time:      sd?.split_time != null ? String(sd.split_time) : '',
      split_speed:     sd?.leg_speed != null ? `${Number(sd.leg_speed).toFixed(1)}km/hr` : '',
      split_pace:      '',
      leg_pace:        sd?.leg_pace  != null ? String(sd.leg_pace)  : '',
      leg_speed:       sd?.leg_speed != null ? String(sd.leg_speed) : '',
      gen_place:       sd?.split_gender_pos   != null ? String(sd.split_gender_pos)   : '',
      cat_place:       sd?.split_category_pos != null ? String(sd.split_category_pos) : '',
      overall_place:   sd?.split_overall_pos  != null ? String(sd.split_overall_pos)  : '',
      estTOD:          '',
      estRaceTime:     '',
    };

    // split_pace: "#tostring(splitdata[ssIndex].split_pace)#min/k", with leading
    // colon stripped & leading zeros removed (CF: REReplace + Replace one).
    if (sd?.split_pace != null && String(sd.split_pace).trim() !== '') {
      const raw = String(sd.split_pace);
      // remove first ':' (one), then strip leading zeros
      const oneless = raw.replace(':', '');
      thesplit.split_pace = oneless.replace(/^0+/, '') + 'min/k';
    }

    // Estimates — only when use_estimates and we don't already have a RaceTime
    if (livetiming.use_estimates && estimates.length) {
      const est = estimates.find((e) => String(e.split_id) === String(split.id));
      if (est) {
        if (thesplit.RaceTime === '') {
          const formatted = formatEstTod(est.estimated_tod);
          thesplit.estTOD = '*' + formatted;
          thesplit.tod    = '*' + formatted;
        }
      }
    }

    // Legs — match against event.legs by end split id
    if (Array.isArray(event.legs) && event.legs.length && sd) {
      for (const leg of event.legs) {
        const endSplitId = leg.end ?? leg.end_id ?? 0;
        if (String(split.id) === String(endSplitId)) {
          const legSpeedType = leg.speed_type || 'speed';
          let leg_pace = '';
          if (legSpeedType === 'pace' && sd.leg_pace) {
            const oneless = String(sd.leg_pace).replace(':', '');
            leg_pace = oneless.replace(/^0+/, '') + 'min/k';
          } else if (sd.leg_speed != null && Number(sd.leg_speed) > 0) {
            leg_pace = `${Number(sd.leg_speed).toFixed(1)}km/hr`;
          }
          livetiming.legs.push({
            label:      leg.label || 'Leg',
            icon:       leg.icon  || '',
            leg_result: sd.leg_time != null ? String(sd.leg_time) : '',
            leg_pace,
          });
        }
      }
    }

    livetiming.splits.push(thesplit);

    // Track last split with both tod and racetime (estimates stripped)
    const cleanTod = thesplit.tod.startsWith('*') ? thesplit.tod.slice(1) : thesplit.tod;
    if (cleanTod !== '' && thesplit.RaceTime !== '') {
      const sTod = timeOfDayToSeconds(cleanTod);
      const sRt  = raceTimeToSeconds(thesplit.RaceTime);
      if (sTod >= 0 && sRt >= 0) {
        lastBoth.tod = thesplit.tod;
        lastBoth.racetime = thesplit.RaceTime;
        lastBoth.todSeconds = sTod;
        lastBoth.raceTimeSeconds = sRt;
      }
    }
  }

  // --- race_clock ---
  const isStarted = String(livetiming.finish_status) === '3';
  if (isFinished) {
    if (livetiming.result?.trim()) {
      livetiming.race_clock = livetiming.result.trim();
    } else if (lastBoth.raceTimeSeconds >= 0) {
      livetiming.race_clock = secondsToRaceTime(lastBoth.raceTimeSeconds);
    } else {
      livetiming.race_clock = '00:00:00';
    }
  } else if (isStarted) {
    const raceNow = nowInTzSeconds(raceobj.timezone);
    if (lastBoth.todSeconds >= 0 && lastBoth.raceTimeSeconds >= 0 && raceNow >= 0) {
      let elapsed = raceNow - lastBoth.todSeconds;
      if (elapsed < 0) {
        elapsed = lastBoth.todSeconds > 43200 ? elapsed + 86400 : 0;
      }
      livetiming.race_clock = secondsToRaceTime(lastBoth.raceTimeSeconds + elapsed);
    } else {
      livetiming.race_clock = '00:00:00';
    }
  } else {
    livetiming.race_clock = lastBoth.raceTimeSeconds > 0
      ? secondsToRaceTime(lastBoth.raceTimeSeconds)
      : '00:00:00';
  }

  return { livetiming, contestType, error: null };
}

module.exports = { transform };
