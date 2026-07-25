/**
 * Finalise a RaceResult event when it stops being live.
 *
 * 1. One last full pull of the RR feed.
 * 2. Upsert every record (splits AND legs — the splits page needs both) into
 *    the race's Postgres results table, mirroring insertBatch() in
 *    API/cfc/eventssplits/splits.cfc: same columns, same
 *    (race_id, race_no, split_id, athlete_id) conflict key, same
 *    split_id = RR_SPLITID > 0 ? RR_SPLITID : SplitID resolution.
 * 3. Shorten the TTL on the race's redis_splits keys to one hour — readers
 *    are back on Postgres the moment islive flips to 0, so the cache only
 *    needs a short grace period before it evaporates.
 *
 * Triggered by the CMS stop-live action via
 * GET/POST /v1/raceresult/finalise/:race_id (background by default).
 */

const pool  = require('../config/database');
const redis = require('../config/redis');
const { fetchSplits } = require('./raceresultPull');

const ROWS_PER_INSERT   = 1000;  // 15 params/row, well under PG's 65535 cap
const POST_FINALISE_TTL = 3600;  // grace period before redis_splits keys expire

const COLUMNS = [
  'race_id', 'race_no', 'split_id', 'rr_splitid', 'athlete_id',
  'split_tod', 'split_gun', 'split_chip',
  'overall_rank', 'gender_rank', 'agegroup_rank', 'splitpace',
  'splitpredictedtod', 'splitpredictedracetime', 'splitspeed',
];

const UPDATE_SET = COLUMNS.slice(3) // everything not in the conflict key except race_no
  .filter((c) => c !== 'athlete_id')
  .map((c) => `${c} = EXCLUDED.${c}`)
  .join(', ');

// Case-insensitive feed-field reader (feed casing varies: SplitToD, RR_SplitID…)
function makeReader(rec) {
  const lower = {};
  for (const k of Object.keys(rec || {})) lower[k.toLowerCase()] = rec[k];
  return (name, dflt = '') => {
    const v = lower[name.toLowerCase()];
    return v == null ? dflt : v;
  };
}

function recordToValues(raceId, rec) {
  const get = makeReader(rec);
  const rrSplitId  = Number(get('rr_splitid', 0)) || 0;
  const splitIdRaw = Number(get('splitid', 0)) || 0;
  const athleteId  = String(get('id', ''));
  if (athleteId === '') return null;
  return [
    raceId,
    Number(get('bib', 0)) || 0,
    rrSplitId > 0 ? rrSplitId : splitIdRaw,
    rrSplitId,
    athleteId,
    String(get('splittod')),
    String(get('splitracetime')),
    String(get('splitchiptime')),
    String(get('splitoverallrank')),
    String(get('splitgenderrank')),
    String(get('splitagegrouprank')),
    String(get('splitpace')),
    String(get('splitpredictedtod')),
    String(get('splitpredictedracetime')),
    String(get('splitspeed')),
  ];
}

const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

async function upsertBatch(table, batch) {
  const params = [];
  const lines  = batch.map((vals) => {
    const base = params.length;
    params.push(...vals);
    return `(${vals.map((_, i) => `$${base + i + 1}`).join(',')})`;
  });
  await pool.query(
    `INSERT INTO ${table} (${COLUMNS.join(', ')})
     VALUES ${lines.join(',')}
     ON CONFLICT (race_id, race_no, split_id, athlete_id) DO UPDATE
     SET ${UPDATE_SET}`,
    params
  );
}

async function expireRedisSplits(raceId, ttlSecs) {
  let cursor = '0';
  let touched = 0;
  do {
    const [next, keys] = await redis.scan(
      cursor, 'MATCH', `redis_splits:${raceId}:athlete:*`, 'COUNT', 5000
    );
    cursor = next;
    if (keys.length) {
      const pipeline = redis.pipeline();
      for (const k of keys) pipeline.expire(k, ttlSecs);
      await pipeline.exec();
      touched += keys.length;
    }
  } while (cursor !== '0');
  return touched;
}

// Delete the race's EasyCron pull job (mirrors deletecronjob in the CMS
// easycron.cfc) and clear races.live_cron_job_id. Best-effort: a failure
// here must not block persisting the results.
async function deleteLiveCronJob(raceId) {
  const token = process.env.EASYCRON_TOKEN || 'eac22c05b94fba92e7ba604a1060e7ba';
  try {
    const { rows } = await pool.query(
      'SELECT live_cron_job_id FROM races WHERE id = $1', [raceId]
    );
    const jobId = Number(rows[0]?.live_cron_job_id) || 0;
    if (jobId > 0) {
      await fetch(
        `https://www.easycron.com/rest/delete?token=${token}&id=${jobId}`
      );
    }
    await pool.query(
      'UPDATE races SET live_cron_job_id = 0 WHERE id = $1', [raceId]
    );
    return jobId;
  } catch {
    return 0;
  }
}

async function finaliseRaceResult({ raceId, feedUrl, resultsTable }) {
  const table = String(resultsTable || '').trim();
  if (!table || !/^[a-z_][a-z0-9_]*$/.test(table)) {
    throw new Error(`Invalid results table for race ${raceId}: "${resultsTable}"`);
  }

  const t0 = Date.now();

  // Stop the scheduled pulls first so no fresh pull races the final import.
  const cronJobDeleted = await deleteLiveCronJob(raceId);

  const records = await fetchSplits(feedUrl);
  const tFetch = Date.now() - t0;

  let batch = [];
  let inserted = 0;
  let skipped = 0;
  for (const rec of records) {
    const vals = recordToValues(raceId, rec);
    if (!vals) { skipped++; continue; }
    batch.push(vals);
    if (batch.length >= ROWS_PER_INSERT) {
      await upsertBatch(table, batch);
      inserted += batch.length;
      batch = [];
      await yieldLoop();
    }
  }
  if (batch.length) {
    await upsertBatch(table, batch);
    inserted += batch.length;
  }
  const tDb = Date.now() - t0 - tFetch;

  const expired = await expireRedisSplits(raceId, POST_FINALISE_TTL);

  return {
    raceId,
    table,
    rows: records.length,
    upserted: inserted,
    skipped,
    cronJobDeleted,
    redisKeysExpiring: expired,
    ms: { fetch: tFetch, db: tDb, total: Date.now() - t0 },
  };
}

module.exports = { finaliseRaceResult };
