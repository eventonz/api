/**
 * Header builder for the splits pipeline.
 * Mirrors API/api/v4/modules/split_scripts/build_header.cfm
 *
 * - Ensures livetiming has all expected default keys
 * - Rebuilds livetiming.splits from raceobj event config (config = source of truth)
 *   merging timing data by split id
 * - Builds the initial results.version2.items[]: summary (with live race clock)
 *   and external links (cert / photo) when finished.
 */

const { calcLiveRaceTime } = require('./timeHelpers');

const REQUIRED_KEYS = [
  'overall_gen_place', 'overall_cat_place', 'overall_place',
  'gen_pos_finishers', 'overall_pos_finishers', 'cat_pos_finishers',
  'result', 'contest_name', 'medal_url', 'finish_status',
  'photo_link', 'cert_link', 'return_server', 'showPace', 'showRank',
  'race_clock',
];

function ensureLivetiming(livetiming) {
  for (const k of REQUIRED_KEYS) {
    if (!(k in livetiming)) livetiming[k] = '';
  }
  if (!Array.isArray(livetiming.splits)) livetiming.splits = [];
  if (!Array.isArray(livetiming.legs))   livetiming.legs   = [];
  if (!livetiming.race_clock)            livetiming.race_clock = '00:00:00';
  return livetiming;
}

function mergeSplitsFromConfig(livetiming, raceobj, urlContest) {
  const contestId = urlContest || livetiming.contest_id || '';
  if (!contestId || !Array.isArray(raceobj.events)) return;

  const evt = raceobj.events.find((e) => String(e.contest_id) === String(contestId));
  if (!evt) return;

  if (!livetiming.contest_name?.trim()) {
    livetiming.contest_name = evt.event_descr || '';
  }

  if (!Array.isArray(evt.splits) || !evt.splits.length) return;

  const liveLookup = new Map();
  for (const ls of livetiming.splits) {
    if (ls?.id != null) liveLookup.set(String(ls.id), ls);
  }

  const merged = evt.splits.map((cfg) => {
    const splitId = cfg.id;
    const row = {
      id:              splitId,
      name:            cfg.name ?? '',
      order:           cfg.order ?? 0,
      visible:         cfg.visible ?? 1,
      split_distance:  cfg.split_distance ?? 0,
      fixed_elevation: cfg.fixed_elevation ?? '',
      split_type:      cfg.split_type ?? '',
      RaceTime: '', tod: '', leg_time: '', split_time: '',
      split_pace: '', split_speed: '', leg_pace: '', leg_speed: '',
      overall_place: '', gen_place: '', cat_place: '',
      estTOD: '', estRaceTime: '',
    };

    const live = liveLookup.get(String(splitId));
    if (live) {
      for (const k of [
        'RaceTime', 'tod', 'leg_time', 'split_time',
        'split_pace', 'split_speed', 'leg_pace', 'leg_speed',
        'overall_place', 'gen_place', 'cat_place',
        'estTOD', 'estRaceTime',
      ]) {
        if (k in live) row[k] = live[k];
      }
    }
    return row;
  });

  livetiming.splits = merged;
}

function buildSummaryItem(livetiming, raceobj) {
  const isFinished = String(livetiming.finish_status) === '4';
  const isStarted  = String(livetiming.finish_status) === '3';

  const summary = { top: {} };
  summary.top.subtitle = String(livetiming.contest_name ?? '');
  summary.top.result   = isFinished ? String(livetiming.result ?? '') : '';

  if (isFinished && livetiming.medal_url) {
    summary.top.medal = String(livetiming.medal_url);
  }

  // Live race clock — finished: result; started: calc from last split + now in tz.
  let liveRaceTime = '00:00:00';
  let shouldTick   = false;

  if (isFinished) {
    if (livetiming.race_clock && livetiming.race_clock !== '00:00:00') {
      liveRaceTime = livetiming.race_clock;
    } else if (livetiming.result) {
      liveRaceTime = livetiming.result;
    }
  } else if (isStarted && livetiming.splits.length) {
    let lastTOD = '';
    let lastRaceTime = '';
    for (const sp of livetiming.splits) {
      const hasTOD      = sp.tod      && !String(sp.tod).startsWith('*');
      const hasRaceTime = sp.RaceTime && !String(sp.RaceTime).startsWith('*');
      if (hasTOD && hasRaceTime) {
        lastTOD = sp.tod;
        lastRaceTime = sp.RaceTime;
      } else if (hasTOD && !hasRaceTime && lastTOD === '' && lastRaceTime === '') {
        lastTOD = sp.tod;
        lastRaceTime = '00:00:00';
      }
    }
    if (lastTOD && lastRaceTime) {
      liveRaceTime = calcLiveRaceTime(lastTOD, lastRaceTime, raceobj.timezone || 'UTC');
      shouldTick   = liveRaceTime !== '--:--:--';
    }
  }

  summary.top.live = { racetime: liveRaceTime, ticking: shouldTick };
  return { type: 'summary', data: summary };
}

function buildExternalLinks(livetiming, { bib, athleteId, contest }) {
  if (!livetiming.result?.trim() || (!livetiming.cert_link && !livetiming.photo_link)) {
    return null;
  }
  const subst = (template) => String(template)
    .replace(/\{\{RaceNo\}\}/g,    bib       || '')
    .replace(/\{\{AthleteID\}\}/g, athleteId || '')
    .replace(/\{\{Contest\}\}/g,   contest   || '');

  const data = [];
  if (livetiming.cert_link) {
    data.push({ icon: 'certificate', label: 'View Certificate', url: subst(livetiming.cert_link) });
  }
  if (livetiming.photo_link) {
    data.push({ icon: 'camera',      label: 'View Photos',      url: subst(livetiming.photo_link) });
  }
  return data.length ? { type: 'externallinks', data } : null;
}

/**
 * Run the header build. Mutates `livetiming` (merging splits from config) and
 * returns the initial results object plus state flags downstream needs.
 */
function buildHeader(livetiming, raceobj, { bib, athleteId, contest }) {
  ensureLivetiming(livetiming);
  mergeSplitsFromConfig(livetiming, raceobj, contest);

  const items = [];
  items.push(buildSummaryItem(livetiming, raceobj));

  const links = buildExternalLinks(livetiming, { bib, athleteId, contest });
  if (links) items.push(links);

  return {
    results: { version2: { items } },
    isFinished: String(livetiming.finish_status) === '4',
    isStarted:  String(livetiming.finish_status) === '3',
  };
}

module.exports = { buildHeader };
