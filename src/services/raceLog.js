/**
 * Per-race activity log in Redis — what the CMS shows on the event Overview
 * (Live timing → Activity). One LIST per race, newest first, capped, expiring
 * one week after the last entry.
 *
 *   race:log:{race_id}  → JSON { at, kind, msg, by }
 *
 * kinds: state · pull · list · finalise · push · webhook · notify · error
 */
const os = require('os');
const redis = require('../config/redis');

const CAP = 50000;   // ~250 B each → ≤ ~12 MB per race, gone a week after the last entry
const TTL = 7 * 24 * 3600;
const ID = `${os.hostname()}:${process.pid}`;

function raceLog(raceId, kind, msg) {
  if (!raceId) return;
  try {
    redis.multi()
      .lpush(`race:log:${raceId}`, JSON.stringify({ at: new Date().toISOString(), kind, msg: String(msg).slice(0, 500), by: ID }))
      .ltrim(`race:log:${raceId}`, 0, CAP - 1)
      .expire(`race:log:${raceId}`, TTL)
      .exec()
      .catch(() => {});
  } catch { /* logging must never break the caller (tests stub redis) */ }
}

module.exports = { raceLog };
