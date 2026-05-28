#!/usr/bin/env node
/**
 * Standalone CLI: pull splits from a RaceResult feed URL into Redis.
 *
 * Wraps src/services/raceresultPull.js so cron/PM2/CI can invoke the same
 * code path used by POST /v1/raceresult/pull/:race_id without going through
 * the HTTP layer (no Bearer token needed when run on the droplet).
 *
 * Usage:
 *   node scripts/pull-rr-splits.js \
 *     --race-id=560 \
 *     --feed-url="https://api.raceresult.com/278719/4UKCV7RFYU2FH42OQL4MMGH95R23CQ8K"
 *
 * Env fallback: RR_RACE_ID, RR_FEED_URL
 */

require('dotenv').config();
const redis = require('../src/config/redis');
const { pullRaceResultSplits } = require('../src/services/raceresultPull');

function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const raceId = Number(args['race-id'] || process.env.RR_RACE_ID);
  const feedUrl = args['feed-url'] || process.env.RR_FEED_URL;

  if (!raceId || !feedUrl) {
    console.error('Missing --race-id and/or --feed-url (or RR_RACE_ID / RR_FEED_URL env)');
    process.exit(1);
  }

  const result = await pullRaceResultSplits({ raceId, feedUrl });
  console.log(JSON.stringify(result));
}

main()
  .catch((err) => {
    console.error('pull-rr-splits failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => redis.quit());
