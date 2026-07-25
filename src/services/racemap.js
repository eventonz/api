/**
 * Race Map GPS refresh — port of API/cfc/RaceMap.cfc refreshRaceMap().
 *
 * Fetches GPS tracking data from the race's configured racemap_url,
 * merges athlete identity + latest timing-split data, and writes one
 * tracking:race:{race_id}:{athlete_id} key per athlete (same payload shape
 * the tracks pipeline writes, with isgps: true). Position changes are
 * appended to race_log; a summary lands in system_log.
 *
 * Called by EasyCron every 10 minutes when auto-refresh is enabled.
 */

const pool  = require('../config/database');
const redis = require('../config/redis');
const { raceconfigByRaceId } = require('./raceConfig');

const fmt1 = (n) => Number((Number(n) || 0).toFixed(1));

// "HH:mm:ss" in the given IANA timezone for a UTC date
function todInTz(date, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz || 'UTC',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (t) => {
    let v = Number(parts.find((p) => p.type === t)?.value || 0);
    if (t === 'hour' && v === 24) v = 0; // Intl quirk
    return String(v).padStart(2, '0');
  };
  return `${get('hour')}:${get('minute')}:${get('second')}`;
}

function hmsToSecs(hms) {
  const parts = String(hms || '').split('.')[0].split(':').map((n) => Number(n) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

function secsToHms(total) {
  const t = Math.max(0, Math.floor(total));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
}

// Initials, or race number, per races.marker_text setting
function markerTextFor(name, raceNo, setting) {
  if (setting === 'racenumber' || setting === 'raceno') return String(raceNo);
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  let out = '';
  if (words.length >= 1) out += words[0][0].toUpperCase();
  if (words.length >= 2) out += words[words.length - 1][0].toUpperCase();
  return out;
}

async function systemLog(action, message, details, status, raceId) {
  try {
    await pool.query(
      `INSERT INTO system_log (action, source, message, details, status, race_id)
       VALUES ($1, $2, $3, CAST($4 AS jsonb), $5, $6)`,
      [action, 'racemap.js', message, JSON.stringify(details), status, raceId]
    );
  } catch { /* best-effort */ }
}

async function refreshRaceMap(raceId) {
  const result = { success: false, message: '', records_updated: 0, race_id: raceId };

  const { rows: raceRows } = await pool.query(
    'SELECT racemap_url, racemap_contest_id, marker_text FROM races WHERE id = $1',
    [raceId]
  );
  if (!raceRows.length) {
    result.message = 'Race not found';
    return result;
  }
  const racemapUrl = String(raceRows[0].racemap_url || '').trim();
  if (!racemapUrl) {
    result.message = 'No racemap_url configured for this race';
    return result;
  }

  let gpsdata;
  try {
    const res = await fetch(racemapUrl, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      result.message = `Failed to fetch data from racemap URL: ${res.status}`;
      return result;
    }
    const data = await res.json();
    if (!data || !Array.isArray(data.starters)) {
      result.message = 'No starters data in response';
      return result;
    }
    gpsdata = data.starters;
  } catch (err) {
    result.message = `Failed to fetch data from racemap URL: ${err.message}`;
    return result;
  }

  const raceobj = await raceconfigByRaceId(raceId);
  const resultsTableRaw = (raceobj?.timing?.results_table || raceobj?.results_table || '').trim();
  const resultsTable = /^[a-z_][a-z0-9_]*$/.test(resultsTableRaw) ? resultsTableRaw : 'timit';
  const markerSetting = String(raceRows[0].marker_text || '').trim().toLowerCase();
  const tz = raceobj?.timezone || 'UTC';

  const gpsRaceNos = gpsdata
    .map((t) => t.startNumber)
    .filter((n) => n !== '' && n != null && Number.isFinite(Number(n)))
    .map((n) => Number(n));

  // Course splits only (legs live in event.legs, not event.splits)
  const validSplitIds = [...new Set(
    (raceobj?.events || []).flatMap((ev) => (ev.splits || []).map((s) => Number(s.id)))
      .filter((id) => Number.isFinite(id))
  )];

  // Athlete identity + latest timing split per race number
  const athleteLookup = new Map();
  if (gpsRaceNos.length) {
    const { rows: athletes } = await pool.query(
      `SELECT athlete_id, name, raceno AS race_no
       FROM athletes WHERE race_id = $1 AND raceno = ANY($2::varchar[])`,
      [raceId, gpsRaceNos.map(String)]
    );

    const splitFilter = validSplitIds.length ? 'AND split_id = ANY($3::int[])' : '';
    const splitParams = validSplitIds.length
      ? [raceId, gpsRaceNos, validSplitIds]
      : [raceId, gpsRaceNos];
    const { rows: splits } = await pool.query(
      `SELECT t.race_no, t.split_tod AS last_tod, t.split_chip AS last_racetime
       FROM ${resultsTable} t
       INNER JOIN (
         SELECT race_no, MAX(split_id) AS max_split_id
         FROM ${resultsTable}
         WHERE race_id = $1 AND race_no = ANY($2::int[])
           AND split_chip IS NOT NULL AND split_chip != ''
           AND split_tod  IS NOT NULL AND split_tod  != ''
           ${splitFilter}
         GROUP BY race_no
       ) latest ON t.race_no = latest.race_no AND t.split_id = latest.max_split_id
       WHERE t.race_id = $1`,
      splitParams
    );
    const splitLookup = new Map(splits.map((s) => [String(s.race_no), s]));

    for (const a of athletes) {
      const sd = splitLookup.get(String(a.race_no)) || {};
      athleteLookup.set(String(a.race_no), {
        athlete_id:    a.athlete_id,
        name:          a.name,
        marker_text:   markerTextFor(a.name, a.race_no, markerSetting),
        last_tod:      sd.last_tod      || '',
        last_racetime: sd.last_racetime || '',
      });
    }
  }

  // Contest + tracking path resolution
  const racemapContest = String(raceRows[0].racemap_contest_id ?? '').trim();
  const contestId = racemapContest !== ''
    ? Number(racemapContest)
    : Number(raceobj?.race_data?.contest_id ?? 0);
  let useTrackingPath = contestId;
  const ev = (raceobj?.events || []).find((e) => Number(e.contest_id) === Number(contestId));
  if (ev && String(ev.use_tracking_path ?? '').length) useTrackingPath = ev.use_tracking_path;

  let recordUpdated = 0, skippedNoAthlete = 0, skippedNotNumeric = 0, finishedCount = 0;
  const redisErrors = [];
  const sampleKeys = [];

  for (const track of gpsdata) {
    if (track.current == null) continue;
    try {
      const fromStart = Number(track.current.fromStart) || 0;
      const toFinish  = Number(track.current.toFinish)  || 0;
      const courseM   = fromStart + toFinish;

      const isFinished = toFinish <= 100;
      const percentCourse = isFinished ? 100 : fmt1(courseM > 0 ? (fromStart / courseM) * 100 : 0);
      const distance = fmt1(fromStart / 1000);
      const speed = isFinished ? 0 : fmt1(Math.max(0, Number(track.current.speed) || 0));
      const splitname = isFinished ? 'Finished' : `${distance}km`;
      const splitId = Math.round(distance);
      const raceNo = track.startNumber;

      const localTod = todInTz(new Date(track.current.time), tz);

      const athleteData = athleteLookup.get(String(raceNo));

      if (!Number.isFinite(Number(raceNo)) || raceNo === '' || raceNo == null) {
        skippedNotNumeric++;
        continue;
      }
      if (!athleteData || !String(athleteData.athlete_id ?? '').length) {
        skippedNoAthlete++;
        continue;
      }

      // racetime = last split racetime + elapsed since that split (per CF logic)
      let racetime = '';
      let splitTodToUse = localTod;
      if (athleteData.last_tod && athleteData.last_racetime) {
        const secsSince = hmsToSecs(localTod) - hmsToSecs(athleteData.last_tod);
        if (secsSince > 0) {
          racetime = secsToHms(hmsToSecs(athleteData.last_racetime) + secsSince);
        } else {
          // GPS TOD is before the timing split — trust the timing split
          racetime = athleteData.last_racetime;
          splitTodToUse = athleteData.last_tod;
        }
      }

      const payload = {
        raceNo:            Number(raceNo),
        athlete_id:        Number(athleteData.athlete_id),
        name:              athleteData.name || '',
        marker_text:       athleteData.marker_text || '',
        distance,
        splitname,
        percent_course:    percentCourse,
        next_splitpercent: 100,
        course_distance:   fmt1(courseM / 1000),
        speed,
        racetime,
        isgps:             true,
        isFinished,
        contest_id:        Number(contestId) || 0,
        use_tracking_path: Number(useTrackingPath) || 0,
        splittod:          splitTodToUse,
      };
      if (isFinished) finishedCount++;

      const key = `tracking:race:${raceId}:${athleteData.athlete_id}`;
      await redis.set(key, JSON.stringify(payload));
      if (sampleKeys.length < 3) sampleKeys.push(key);
      recordUpdated++;

      // race_log: append only when the position actually changed
      const { rows: lastLog } = await pool.query(
        `SELECT percent_course FROM race_log
         WHERE race_id = $1 AND athlete_id = $2 ORDER BY id DESC LIMIT 1`,
        [raceId, String(athleteData.athlete_id)]
      );
      if (!lastLog.length || Number(lastLog[0].percent_course) !== Number(percentCourse)) {
        await pool.query(
          `INSERT INTO race_log (race_id, athlete_id, race_no, contest_id, split_id,
             split_name, split_order, split_tod, percent_course,
             is_new_split, was_cached, tracking_inserted)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, false, true)`,
          [raceId, String(athleteData.athlete_id), String(raceNo), Number(contestId) || 0,
           splitId, splitname, splitId, splitTodToUse, percentCourse]
        );
      }
    } catch (err) {
      redisErrors.push(`Loop error: ${err.message}`);
    }
  }

  result.success = true;
  result.message = `Successfully updated ${recordUpdated} records`;
  result.records_updated = recordUpdated;
  result.debug = {
    total_starters:      gpsdata.length,
    athletes_in_db:      athleteLookup.size,
    skipped_no_athlete:  skippedNoAthlete,
    skipped_not_numeric: skippedNotNumeric,
    finished_count:      finishedCount,
    redis_errors:        redisErrors,
    sample_keys:         sampleKeys,
    contest_id:          contestId,
    results_table:       resultsTable,
  };

  await systemLog(
    'racemap_refresh',
    `Race Map refresh for race ${raceId}. Updated ${recordUpdated} athletes. Finished: ${finishedCount}.`,
    result.debug, 'success', raceId
  );

  return result;
}

module.exports = { refreshRaceMap };
