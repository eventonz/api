/**
 * Pace / speed units for the athlete page (CMS Contests › Pace unit, and per
 * leg › Speed type). RaceResult gives us pace as "m:ss" per km and speed in
 * km/h; everything else is derived here so the app never converts.
 *
 *   pace_km    m:ss /km        pace_mi    m:ss /mi
 *   speed_kmh  n.n km/h        speed_mph  n.n mph
 *   pace_100m  m:ss /100m      (swim legs; needs a distance)
 *
 * Legacy values still stored on v2.legs: 'speed' = speed_kmh, 'pace' = pace_km.
 */

const UNITS = {
  pace_km:   { label: '/km',   kind: 'pace'  },
  pace_mi:   { label: '/mi',   kind: 'pace'  },
  speed_kmh: { label: 'km/h',  kind: 'speed' },
  speed_mph: { label: 'mph',   kind: 'speed' },
  pace_100m: { label: '/100m', kind: 'pace'  },
};
const MI = 1.609344;

function normaliseUnit(u) {
  const v = String(u || '').trim().toLowerCase();
  if (v === 'speed') return 'speed_kmh';
  if (v === 'pace') return 'pace_km';
  return UNITS[v] ? v : null;
}

/** The contest's unit: explicit, else from the event's distance units. */
function contestUnit(paceUnit, eventUnits) {
  return normaliseUnit(paceUnit) || (String(eventUnits || '').toLowerCase() === 'mi' ? 'pace_mi' : 'pace_km');
}

function unitLabel(u) { return UNITS[normaliseUnit(u) || 'pace_km'].label; }
function unitKind(u)  { return UNITS[normaliseUnit(u) || 'pace_km'].kind; }

function toSecs(hms) {
  if (hms == null || hms === '') return null;
  const p = String(hms).split('.')[0].split(':').map(Number);
  if (p.some((n) => Number.isNaN(n))) return null;
  return p.reduce((acc, n) => acc * 60 + n, 0);
}
function mss(secs) {
  if (!Number.isFinite(secs) || secs <= 0) return '';
  const s = Math.round(secs);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Seconds per km from whatever we have: RR pace "m:ss", RR speed km/h, or a
 * time over a distance. Null when nothing usable.
 */
function secsPerKm({ paceMinKm, speedKmh, seconds, distanceKm } = {}) {
  const p = toSecs(paceMinKm);
  if (p && p > 0) return p;
  const v = Number(speedKmh);
  if (v > 0) return 3600 / v;
  if (Number.isFinite(seconds) && seconds > 0 && Number(distanceKm) > 0) return seconds / Number(distanceKm);
  return null;
}

/** Format a pace/speed in `unit` (value only — the label travels separately). */
function format(unit, inputs) {
  const u = normaliseUnit(unit) || 'pace_km';
  const spk = secsPerKm(inputs);
  if (!spk) return '';
  switch (u) {
    case 'pace_km':   return mss(spk);
    case 'pace_mi':   return mss(spk * MI);
    case 'pace_100m': return mss(spk / 10);
    case 'speed_kmh': return (3600 / spk).toFixed(1);
    case 'speed_mph': return (3600 / spk / MI).toFixed(1);
    default:          return mss(spk);
  }
}

module.exports = { UNITS, normaliseUnit, contestUnit, unitLabel, unitKind, format, secsPerKm, toSecs, mss };
