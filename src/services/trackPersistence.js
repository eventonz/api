/**
 * Track Persistence Service — Stage 4 of the tracks pipeline
 *
 * Mirrors the persistence helpers in API/api/v4/modules/tracks.cfm:
 *   insertResultsTable()
 *   insertRedis()
 *   logToProcessQueue()
 *
 * Called after processContestandSplits + processSpeed (Stage 3).
 * All three are fire-and-don't-block-the-response where appropriate —
 * the caller decides whether to await.
 */

const pool  = require('../config/database');
const redis = require('../config/redis');

// ---------------------------------------------------------------------------
// insertResultsTable
//
// Upserts one split record into the race's dynamic results table.
// Only updates when values actually changed (IS DISTINCT FROM — matches CF).
// No-ops silently if raceobj.results_table is blank.
//
// The table name comes from our own DB (raceobj.results_table), never from
// user input, so interpolation is safe. Validated as alphanumeric below.
// ---------------------------------------------------------------------------
async function insertResultsTable(race_id, trackdata, raceobj) {
  const resultsTable = raceobj.results_table?.trim();
  if (!resultsTable) return;

  // Sanity-check the table name before interpolating into SQL
  if (!/^[a-zA-Z0-9_]+$/.test(resultsTable)) {
    throw new Error(`Invalid results_table name: ${resultsTable}`);
  }

  const hasRRSplitId = trackdata.rr_splitid != null && Number(trackdata.rr_splitid) > 0;

  const params = [
    race_id,                              // $1
    trackdata.race_no,                    // $2
    trackdata.split_id,                   // $3
    trackdata.athlete_id,                 // $4
    trackdata.tod        ?? '',           // $5  split_tod
    trackdata.race_time  ?? '',           // $6  split_gun
    trackdata.split_chip ?? '',           // $7
    trackdata.overall_rank   ?? '',       // $8
    trackdata.gender_rank    ?? '',       // $9
    trackdata.agegroup_rank  ?? '',       // $10
    trackdata.split_pace     ?? '',       // $11 splitpace
    trackdata.predicted_tod       ?? '',  // $12 splitpredictedtod
    trackdata.predicted_race_time ?? '',  // $13 splitpredictedracetime
    trackdata.speed      ?? '',           // $14 splitspeed
  ];

  // rr_splitid added as last param when present
  if (hasRRSplitId) params.push(Number(trackdata.rr_splitid)); // $15

  const rrSplitCol    = hasRRSplitId ? ', rr_splitid'           : '';
  const rrSplitVal    = hasRRSplitId ? `, $${params.length}`    : '';
  const rrSplitUpdate = hasRRSplitId ? ', rr_splitid = EXCLUDED.rr_splitid' : '';

  const sql = `
    INSERT INTO ${resultsTable} (
      race_id, race_no, split_id, athlete_id,
      split_tod, split_gun, split_chip,
      overall_rank, gender_rank, agegroup_rank,
      splitpace, splitpredictedtod, splitpredictedracetime,
      splitspeed${rrSplitCol}
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6, $7,
      $8, $9, $10,
      $11, $12, $13,
      $14${rrSplitVal}
    )
    ON CONFLICT (race_id, race_no, split_id, athlete_id) DO UPDATE SET
      split_tod               = EXCLUDED.split_tod,
      split_gun               = EXCLUDED.split_gun,
      split_chip              = EXCLUDED.split_chip,
      overall_rank            = EXCLUDED.overall_rank,
      gender_rank             = EXCLUDED.gender_rank,
      agegroup_rank           = EXCLUDED.agegroup_rank,
      splitpace               = EXCLUDED.splitpace,
      splitpredictedtod       = EXCLUDED.splitpredictedtod,
      splitpredictedracetime  = EXCLUDED.splitpredictedracetime,
      splitspeed              = EXCLUDED.splitspeed
      ${rrSplitUpdate}
    WHERE
      ${resultsTable}.split_tod              IS DISTINCT FROM EXCLUDED.split_tod  OR
      ${resultsTable}.split_gun              IS DISTINCT FROM EXCLUDED.split_gun  OR
      ${resultsTable}.splitspeed             IS DISTINCT FROM EXCLUDED.splitspeed
  `;

  try {
    await pool.query(sql, params);
  } catch (err) {
    // Log to Redis so it can be inspected without blocking the tracking flow
    // Mirrors the CF debug Redis write in insertResultsTable()
    logInsertError(race_id, resultsTable, trackdata, err).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// insertRedis
//
// Writes the athlete's current tracking position to Redis.
// Key: tracking:race:{r_id}:{athlete_id}
// 2-day TTL (refreshed on every split) — tracking is race-day-only data, so
// dead races clean themselves out of Valkey instead of persisting forever.
// ---------------------------------------------------------------------------
const TRACKING_KEY_TTL_SECS = 2 * 24 * 3600;
async function insertRedis(race_id, trackdata, context, live_camera_url) {
  const {
    split_distance,
    use_tracking_path,
    percent_course,
    total_distance,
    next_splitpercent,
  } = context;

  const key = `tracking:race:${race_id}:${trackdata.athlete_id}`;

  const payload = {
    athlete_id:        trackdata.athlete_id,
    raceNo:            trackdata.race_no,
    distance:          split_distance,
    name:              trackdata.name,
    use_tracking_path,
    marker_text:       trackdata.marker_text,
    racetime:          trackdata.race_time,
    splitname:         trackdata.split_name,
    splitracetime:     trackdata.race_time,
    percent_course,
    course_distance:   total_distance,
    speed:             trackdata.speed,
    isgps:             false,
    next_splitpercent,
    contest_id:        trackdata.contest_id,
    splittod:          trackdata.tod,
    live_camera_url:   live_camera_url ?? '',
  };

  await redis.set(key, JSON.stringify(payload), 'EX', TRACKING_KEY_TTL_SECS);

  return { key, payload };
}

// ---------------------------------------------------------------------------
// upsertRedisSplits
//
// Merges one pushed split into the athlete's redis_splits key — the same
// key the scheduled pull (raceresultPull.js) writes and the live splits
// transformers read. Keeps push and pull data in one place so the splits
// page shows a mat crossing immediately instead of waiting for the next
// pull. Records are stored in the RR feed shape (PascalCase fields).
//
// Concurrency note: the pull SETs the whole key from the full feed, so a
// push merged in the window between a pull's fetch and its set can be
// overwritten — the next push or pull heals it, so no locking needed.
// ---------------------------------------------------------------------------
const SPLITS_KEY_TTL_SECS = 72 * 3600; // matches raceresultPull.js
async function upsertRedisSplits(race_id, trackdata) {
  const athleteId = String(trackdata.athlete_id ?? '');
  if (!athleteId) return;

  const rrSplitId = Number(trackdata.rr_splitid) || 0;
  const splitId   = rrSplitId > 0 ? rrSplitId : (Number(trackdata.split_id) || 0);
  if (!splitId) return;

  const record = {
    Bib:                    Number(trackdata.race_no) || 0,
    ID:                     athleteId,
    SplitID:                splitId,
    RR_SplitID:             rrSplitId,
    SplitToD:               String(trackdata.tod ?? ''),
    SplitRaceTime:          String(trackdata.race_time ?? ''),
    SplitChipTime:          String(trackdata.split_chip ?? ''),
    SplitOverallRank:       String(trackdata.overall_rank ?? ''),
    SplitGenderRank:        String(trackdata.gender_rank ?? ''),
    SplitAgeGroupRank:      String(trackdata.agegroup_rank ?? ''),
    SplitPace:              String(trackdata.split_pace ?? ''),
    SplitSpeed:             trackdata.speed ? String(trackdata.speed) : '',
    SplitPredictedToD:      String(trackdata.predicted_tod ?? ''),
    SplitPredictedRaceTime: String(trackdata.predicted_race_time ?? ''),
  };

  const key = `redis_splits:${race_id}:athlete:${athleteId}`;
  const raw = await redis.get(key);
  let records = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) records = parsed;
    } catch { /* corrupt value — rebuild from this record */ }
  }

  const matchId = (rec) => {
    const rr = Number(rec?.RR_SplitID ?? rec?.rr_splitid) || 0;
    return rr > 0 ? rr : (Number(rec?.SplitID ?? rec?.splitid) || 0);
  };
  const idx = records.findIndex((rec) => matchId(rec) === splitId);
  if (idx >= 0) records[idx] = { ...records[idx], ...record };
  else records.push(record);

  await redis.set(key, JSON.stringify(records), 'EX', SPLITS_KEY_TTL_SECS);
}

// ---------------------------------------------------------------------------
// logToProcessQueue
//
// Appends a timestamped entry to the Redis process_queue list.
// Used for observability / replay. Fire-and-forget — errors are swallowed.
// ---------------------------------------------------------------------------
async function logToProcessQueue(race_id, rawJson) {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
    race_id:   Number(race_id),
    payload:   rawJson,
  });

  await redis.rpush('process_queue', entry);
}

// ---------------------------------------------------------------------------
// Internal: write insert error details to Redis for debugging
// Mirrors CF's debug Redis write inside insertResultsTable catch block
// ---------------------------------------------------------------------------
async function logInsertError(race_id, resultsTable, trackdata, err) {
  const entry = JSON.stringify({
    message:       err.message,
    detail:        err.detail ?? '',
    race_id,
    results_table: resultsTable,
    split_id:      trackdata.split_id  ?? 0,
    race_no:       trackdata.race_no   ?? '',
    athlete_id:    trackdata.athlete_id ?? '',
  });
  await redis.set(`debug:insertResultsTable:${race_id}`, entry);
}

module.exports = {
  insertResultsTable,
  insertRedis,
  upsertRedisSplits,
  logToProcessQueue,
};
