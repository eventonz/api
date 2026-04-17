/**
 * Track Push Service — Stage 5 of the tracks pipeline
 *
 * Mirrors sendPushtoQueue() in API/api/v4/modules/tracks.cfm.
 *
 * Compares split TOD against current time in the race timezone.
 * < 5 minutes stale → RPUSH to athlete_push_queue (worker sends it)
 * >= 5 minutes stale → RPUSH to didnotsend_push_queue (observability only)
 *
 * live_test_mode bypasses the staleness check entirely.
 * Always fire-and-forget from the caller — never blocks the 201 response.
 */

const redis = require('../config/redis');

async function sendPushToQueue(race_id, trackdata, raceobj, context, live_camera_url) {
  const minutesDiff = minutesSinceTod(trackdata.tod, raceobj.timezone);

  if (minutesDiff < 5 || raceobj.live_test_mode) {
    // Fresh enough — queue for delivery
    const entry = JSON.stringify({
      raceNo:          trackdata.race_no,
      athlete_id:      trackdata.athlete_id,
      race_id:         Number(race_id),
      name:            trackdata.name,
      race_name:       raceobj.race_name,
      splitname:       trackdata.split_name,
      racetime:        trackdata.race_time,
      os_appid:        raceobj.onesignal_id,
      os_restkey:      raceobj.onesignal_restkey,
      message:         trackdata.message,
      split_tod:       trackdata.tod,
      timezone:        raceobj.timezone,
      live_camera_url: live_camera_url ?? '',
    });

    await redis.rpush('athlete_push_queue', entry);
  } else {
    // Too stale — log to dead queue for observability
    const entry = JSON.stringify({
      raceNo:     trackdata.race_no,
      athlete_id: trackdata.athlete_id,
      race_id:    Number(race_id),
      name:       trackdata.name,
      splitname:  trackdata.split_name,
      racetime:   trackdata.race_time,
      os_appid:   raceobj.onesignal_id,
      os_restkey: raceobj.onesignal_restkey,
      message:    trackdata.message,
    });

    await redis.rpush('didnotsend_push_queue', entry);
  }
}

// ---------------------------------------------------------------------------
// How stale is this split? Returns minutes between tod and now (in race tz).
// Mirrors CF: datediff('n', split_time, Timeformat(now(),'HH:mm:ss', tz))
//
// Both tod and current time are treated as HH:MM:SS within the same day.
// Uses Intl to get the wall-clock time in the race timezone.
// ---------------------------------------------------------------------------
function minutesSinceTod(tod, timezone) {
  try {
    // Current time-of-day in the race timezone
    const nowStr = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || 'UTC',
      hour:     '2-digit',
      minute:   '2-digit',
      second:   '2-digit',
      hour12:   false,
    }).format(new Date());

    const nowSecs = timeToSeconds(nowStr);
    const todSecs = timeToSeconds(String(tod ?? ''));

    const diffSecs = nowSecs - todSecs;
    return diffSecs / 60;
  } catch {
    // If timezone or tod is malformed, treat as fresh (don't suppress pushes)
    return 0;
  }
}

function timeToSeconds(str) {
  const clean = str.split('.')[0];
  const parts = clean.split(':');
  return (parseInt(parts[0], 10) || 0) * 3600 +
         (parseInt(parts[1], 10) || 0) * 60  +
         (parseInt(parts[2], 10) || 0);
}

module.exports = { sendPushToQueue };
