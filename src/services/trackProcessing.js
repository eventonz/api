/**
 * Track Processing Service — Stage 3 of the tracks pipeline
 *
 * Mirrors the helper functions in API/api/v4/modules/tracks.cfm:
 *   processContestandSplits()
 *   processSpeed()
 *   checkSplitIsNew()
 *   getLiveCameraUrl()
 *
 * trackdata is treated as a mutable object (matches CF behaviour).
 * processContestandSplits returns a context object used by subsequent steps.
 * Throws { status, message } on invalid contest/split — caller returns 400.
 */

const redis = require('../config/redis');

// ---------------------------------------------------------------------------
// processContestandSplits
//
// Finds the contest and split inside raceobj, resolves position flags,
// builds the push message, and returns a context struct for downstream steps.
// Mutates trackdata: sets split_name, message (if not already set).
// ---------------------------------------------------------------------------
function processContestandSplits(trackdata, raceobj) {
  // Default contest_id to 0 if missing
  if (trackdata.contest_id == null) {
    trackdata.contest_id = 0;
  }

  // Find the matching event in raceobj
  const arrayIndex = raceobj.events.findIndex(
    (e) => Number(e.contest_id) === Number(trackdata.contest_id)
  );

  if (arrayIndex === -1) {
    throw { status: 400, message: 'Contest/Event ID not found' };
  }

  const event = raceobj.events[arrayIndex];
  const splits            = event.splits;
  const total_distance    = event.distance;
  const is_tracking       = event.is_tracking;
  const await_at_next_split = event.await_at_next_split;
  const use_tracking_path = event.use_tracking_path;

  // Find the matching split
  const splitsIndex = splits.findIndex(
    (s) => Number(s.id) === Number(trackdata.split_id)
  );

  if (splitsIndex === -1) {
    throw { status: 400, message: 'Split ID not found' };
  }

  const split = splits[splitsIndex];

  // Extract split metadata
  const percent_course   = split.percent_course;
  const send_push_split  = split.push;
  const type_push        = split.push_type;
  const default_spd      = split.default_spd;
  const split_distance   = split.split_distance;
  const spd_adjust       = split.speed_adjust;
  const split_order      = split.order;

  trackdata.split_name = split.name;

  // Position flags — used for push message and downstream logic
  const is_first_split  = splitsIndex === 0;
  const is_last_split   = splitsIndex === splits.length - 1;
  const is_start_split  = split.split_type === 'start';
  const is_finish_split = split.split_type === 'finish';

  let split_position;
  if (is_start_split || is_first_split) {
    split_position = 'start';
  } else if (is_finish_split || is_last_split) {
    split_position = 'finish';
  } else {
    split_position = 'middle';
  }

  // Build push message if not already set by the normaliser
  if (!trackdata.message || trackdata.message === '') {
    switch (split_position) {
      case 'start':
        trackdata.message = `${trackdata.name} has started`;
        break;
      case 'finish':
        trackdata.message = `${trackdata.name} has finished in a time of ${trackdata.race_time} (Provisional)`;
        break;
      default:
        trackdata.message = `${trackdata.name} has reached ${trackdata.split_name} in a time of ${trackdata.race_time}`;
        break;
    }
  }

  // Next split percent — used for predictive map position
  let next_splitpercent = 100;
  const next_index = splitsIndex + 1;
  if (next_index < splits.length && await_at_next_split) {
    next_splitpercent = splits[next_index].percent_course;
  }

  return {
    arrayIndex,
    splits,
    total_distance,
    is_tracking,
    use_tracking_path,
    await_at_next_split,
    percent_course,
    send_push_split,
    type_push,
    default_spd,
    split_distance,
    spd_adjust,
    split_order,
    split_position,
    next_splitpercent,
    is_first_split,
    is_last_split,
    is_start_split,
    is_finish_split,
  };
}

// ---------------------------------------------------------------------------
// processSpeed
//
// Resolves trackdata.speed from default_spd config, finish rule, or
// calculated from split_distance / race_time. Mutates trackdata.speed.
// ---------------------------------------------------------------------------
function processSpeed(trackdata, context) {
  const { default_spd, split_distance, percent_course } = context;

  if (trackdata.speed == null) {
    trackdata.speed = 0;
  }

  // Explicit override: default_spd set to a real value (not 0 = none, not 1 = calculate)
  if (default_spd !== 0 && default_spd !== 1) {
    trackdata.speed = default_spd;
    return;
  }

  if (Number(trackdata.speed) === 0) {
    if (default_spd !== 1) {
      // Use the configured default (0 = zero speed)
      trackdata.speed = default_spd;
    } else if (Number(percent_course) === 100) {
      // Finished — speed is 0
      trackdata.speed = 0;
    } else {
      // Calculate from distance and race time
      try {
        trackdata.speed = calcSpeed(split_distance, trackdata.race_time);
      } catch {
        trackdata.speed = 0;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// checkSplitIsNew
//
// Uses Redis SADD on a per-athlete seen-set to deduplicate split arrivals.
// Returns { isNewSplit, splitId, seenKey }.
// TTL: 86400s (24 hours after race end) — matches CF.
// ---------------------------------------------------------------------------
async function checkSplitIsNew(race_id, trackdata) {
  const seenKey = `seen:race:${race_id}:${trackdata.athlete_id}`;

  // Prefer rr_splitid if set, otherwise fall back to split_id
  const splitId = (trackdata.rr_splitid != null && Number(trackdata.rr_splitid) > 0)
    ? Number(trackdata.rr_splitid)
    : (Number(trackdata.split_id) || 0);

  // SADD returns 1 if element was new, 0 if already present
  const added = await redis.sadd(seenKey, String(splitId));
  await redis.expire(seenKey, 86400);

  return {
    isNewSplit: added === 1,
    splitId,
    seenKey,
  };
}

// ---------------------------------------------------------------------------
// getLiveCameraUrl
//
// Finds a live camera matching the current split_id and computes a YouTube
// deep-link with a time offset. Returns '' if no camera or offset <= 0.
// ---------------------------------------------------------------------------
function getLiveCameraUrl(raceobj, arrayIndex, trackdata) {
  const event = raceobj.events[arrayIndex];
  if (!event) return '';

  const cameras = event.live_cameras;
  if (!cameras || cameras.length === 0) return '';

  const cam = cameras.find((c) => Number(c.split_id) === Number(trackdata.split_id));
  if (!cam) return '';

  try {
    const todSecs   = timeToSeconds(String(trackdata.tod   ?? ''));
    const startSecs = timeToSeconds(String(cam.start_time  ?? ''));
    const offset    = todSecs - startSecs - 10;
    if (offset <= 0) return '';
    return `https://youtu.be/${cam.yt_video_id}`;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Converts a time string "HH:MM:SS[.mmm]" to total seconds.
 * Mirrors CF getSecondsFromTime() which uses Hour/Minute/Second on a time object.
 */
function timeToSeconds(timeStr) {
  // Strip anything after a dot (fractional seconds / date prefix)
  const clean = timeStr.split('.')[0];
  const parts = clean.split(':');
  const h = parseInt(parts[0], 10) || 0;
  const m = parseInt(parts[1], 10) || 0;
  const s = parseInt(parts[2], 10) || 0;
  return h * 3600 + m * 60 + s;
}

/**
 * Calculates speed in km/h from a split distance (km) and race_time string.
 * Mirrors CF calc_speed().
 */
function calcSpeed(distance, race_time) {
  const seconds = timeToSeconds(String(race_time ?? ''));
  if (!seconds) return 0;
  return Number(((distance / seconds) * 3600).toFixed(2));
}

/**
 * Calculates percentage of speed relative to total distance.
 * Mirrors CF percent_speed().
 */
function percentSpeed(speed, totalDistance) {
  if (!totalDistance) totalDistance = 1;
  return Number((((speed / 60) / totalDistance) * 100).toFixed(2));
}

module.exports = {
  processContestandSplits,
  processSpeed,
  checkSplitIsNew,
  getLiveCameraUrl,
  // Exported for use in Stage 4 (insertRedis speed calc)
  calcSpeed,
  percentSpeed,
  timeToSeconds,
};
