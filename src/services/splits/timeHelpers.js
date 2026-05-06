/**
 * Time helpers for the splits pipeline.
 * Mirrors functions in API/api/v4/modules/split_scripts/transformers/sportsplits.cfm
 * and API/api/v4/modules/split_scripts/functions.cfm (calcLiveRaceTime).
 */

function stripEstimatePrefix(s) {
  if (!s) return '';
  const t = String(s).trim();
  return t.startsWith('*') ? t.slice(1) : t;
}

/** "HH:mm:ss" or "mm:ss" → total seconds. Strips leading "*" from estimates. */
function raceTimeToSeconds(timeString) {
  const clean = stripEstimatePrefix(timeString);
  if (clean === '') return 0;
  const parts = clean.split(':');
  let seconds = 0;
  let multiplier = 1;
  for (let i = parts.length - 1; i >= 0; i--) {
    seconds += (Number(parts[i]) || 0) * multiplier;
    multiplier *= 60;
  }
  return seconds;
}

/** TOD string → seconds since midnight. Returns -1 if unparseable. */
function timeOfDayToSeconds(timeString) {
  let clean = stripEstimatePrefix(timeString);
  if (clean === '') return -1;

  // AM/PM handling
  const ampm = clean.match(/(.*?)\s*([ap]m)\s*$/i);
  if (ampm) {
    const body = ampm[1].trim();
    const isPm = ampm[2].toLowerCase() === 'pm';
    const parts = body.split(':').map((p) => Number(p) || 0);
    if (parts.length < 2) return -1;
    let h = parts[0];
    if (isPm && h < 12) h += 12;
    if (!isPm && h === 12) h = 0;
    const m = parts[1] || 0;
    const s = parts[2] || 0;
    return h * 3600 + m * 60 + s;
  }

  const parts = clean.split(':');
  if (parts.length < 2) return -1;
  const h = Number(parts[0]) || 0;
  const m = Number(parts[1]) || 0;
  const s = parts.length >= 3 ? Number(parts[2]) || 0 : 0;
  if (h < 0 || h > 48 || m < 0 || m > 59 || s < 0 || s > 59) return -1;
  return h * 3600 + m * 60 + s;
}

/** Seconds → "HH:mm:ss" (supports >24h). */
function secondsToRaceTime(totalSeconds) {
  const t = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Current time-of-day (seconds since midnight) in `tz`. */
function nowInTzSeconds(tz) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz || 'UTC',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  let h = get('hour');
  if (h === 24) h = 0;
  return h * 3600 + get('minute') * 60 + get('second');
}

/**
 * Live race time = race time at last split + (now − tod at last split), in race tz.
 * Mirrors calcLiveRaceTime() in functions.cfm.
 */
function calcLiveRaceTime(lastSplitTOD, lastSplitRaceTime, raceTimezone) {
  const todSecs = timeOfDayToSeconds(lastSplitTOD);
  const rtSecs  = raceTimeToSeconds(lastSplitRaceTime);
  if (todSecs < 0 || !lastSplitRaceTime) return '--:--:--';

  const nowSecs = nowInTzSeconds(raceTimezone);
  let elapsed = nowSecs - todSecs;
  if (elapsed < 0) elapsed += 86400; // midnight cross
  const total = rtSecs + elapsed;
  if (total < 0) return '--:--:--';
  return secondsToRaceTime(total);
}

/** TimeFormat(parsed, 'h:mm tt') equivalent for sportsplits estTOD. */
function formatEstTod(value) {
  if (!value) return '';
  // sportsplits returns ISO timestamps for estimated_tod
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

module.exports = {
  stripEstimatePrefix,
  raceTimeToSeconds,
  timeOfDayToSeconds,
  secondsToRaceTime,
  nowInTzSeconds,
  calcLiveRaceTime,
  formatEstTod,
};
