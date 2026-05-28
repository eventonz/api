/**
 * Pull splits from a RaceResult feed URL, group by athlete ID, and write
 * each athlete's splits to Redis under
 *   `redis_splits:{eventoRaceId}:athlete:{athleteId}`
 *
 * Used by both:
 *   - POST /v1/raceresult/pull/:race_id (routes/v1/raceresult.js)
 *   - scripts/pull-rr-splits.js (standalone cron)
 *
 * The athlete ID is the RR `ID` field on each split record (not Bib).
 */

const redis = require('../config/redis');

async function fetchSplits(feedUrl) {
  const res = await fetch(feedUrl);
  if (!res.ok) throw new Error(`Feed HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('Feed payload is not a JSON array');
  return data;
}

function groupByAthlete(splits) {
  const byAthlete = new Map();
  for (const split of splits) {
    const athleteId = split.ID;
    if (athleteId === undefined || athleteId === null || athleteId === '') continue;
    if (!byAthlete.has(athleteId)) byAthlete.set(athleteId, []);
    byAthlete.get(athleteId).push(split);
  }
  return byAthlete;
}

async function writeToRedis(raceId, byAthlete) {
  const pipeline = redis.pipeline();
  for (const [athleteId, splits] of byAthlete) {
    pipeline.set(`redis_splits:${raceId}:athlete:${athleteId}`, JSON.stringify(splits));
  }
  await pipeline.exec();
  return byAthlete.size;
}

async function pullRaceResultSplits({ raceId, feedUrl }) {
  const t0 = Date.now();
  const splits = await fetchSplits(feedUrl);
  const tFetch = Date.now() - t0;

  const byAthlete = groupByAthlete(splits);
  const tGroup = Date.now() - t0 - tFetch;

  const athletes = await writeToRedis(raceId, byAthlete);
  const tWrite = Date.now() - t0 - tFetch - tGroup;

  return {
    raceId,
    rows: splits.length,
    athletes,
    ms: { fetch: tFetch, group: tGroup, write: tWrite, total: Date.now() - t0 },
  };
}

module.exports = { pullRaceResultSplits };
