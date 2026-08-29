/**
 * Worker — consumes Redis LIST `worker_queue` and dispatches jobs by endpoint.
 *
 * Job envelope:
 *   { race_id, datetime, endpoint, payload }
 *
 * Endpoints handled:
 *   tracks/race, tracks/sportsplits, tracks/racetec, tracks/raceresult
 *   rr_webhook
 *
 * Run as a separate PM2 app (see ecosystem.config.js).
 */

require('dotenv').config();
const Redis = require('ioredis');

const { raceconfigByRaceId } = require('../services/raceConfig');
const { normalise } = require('../services/normalisers');
const {
  processContestandSplits,
  processSpeed,
  checkSplitIsNew,
  getLiveCameraUrl,
} = require('../services/trackProcessing');
const {
  insertResultsTable,
  insertRedis,
  upsertRedisSplits,
  logToProcessQueue,
} = require('../services/trackPersistence');
const { sendPushToQueue } = require('../services/trackPush');
const { handleRrWebhook } = require('./handlers/rrWebhook');

const QUEUE_KEY = 'worker_queue';
const BLOCK_TIMEOUT = 5; // seconds; 0 = forever

// Dedicated Redis connection — BRPOP blocks the connection.
const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT),
  password: process.env.REDIS_PASSWORD,
  tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
});

redis.on('connect', () => console.log('[worker] redis connected'));
redis.on('error', (err) => console.error('[worker] redis error:', err.message));

let shuttingDown = false;

// ---------------------------------------------------------------------------
// Endpoint dispatch
// ---------------------------------------------------------------------------
async function dispatch(job) {
  const { race_id, endpoint, payload } = job;

  if (!endpoint) {
    console.warn('[worker] job missing endpoint:', job);
    return;
  }

  if (endpoint.startsWith('tracks/')) {
    return handleTracksJob(race_id, payload, endpoint);
  }
  if (endpoint === 'rr_webhook') {
    return handleRrWebhook(race_id, payload);
  }

  console.warn('[worker] unknown endpoint:', endpoint);
}

// ---------------------------------------------------------------------------
// tracks/* — full pipeline
// ---------------------------------------------------------------------------
async function handleTracksJob(race_id, body, endpoint) {
  const raceobj = await raceconfigByRaceId(race_id);
  if (!raceobj?.r_id) {
    console.warn('[worker] race not found at process time:', race_id);
    return;
  }

  // Audit log of raw payload (fire and forget)
  logToProcessQueue(race_id, JSON.stringify(body)).catch(() => {});

  if (!isWithinReceptionWindow(raceobj)) return;

  const { trackdata, trackdataarray } = normalise(body, raceobj, endpoint, race_id);
  const athletes = trackdataarray ?? [trackdata];

  for (const td of athletes) {
    try {
      const context = processContestandSplits(td, raceobj);
      const live_camera_url = getLiveCameraUrl(raceobj, context.arrayIndex, td);
      processSpeed(td, context);
      if (!td.marker_text) td.marker_text = td.race_no;

      const splitCheck = await checkSplitIsNew(race_id, td);

      insertResultsTable(race_id, td, raceobj).catch((e) =>
        console.error('[worker] insertResultsTable:', e.message)
      );

      // Keep the live splits cache current with pushed data too — the same
      // redis_splits key the pull writes and the splits page reads while live.
      if (raceobj.islive) {
        upsertRedisSplits(race_id, td).catch((e) =>
          console.error('[worker] upsertRedisSplits:', e.message)
        );
      }

      if (splitCheck.isNewSplit && context.is_tracking) {
        insertRedis(race_id, td, context, live_camera_url).catch((e) =>
          console.error('[worker] insertRedis:', e.message)
        );
      }

      if (splitCheck.isNewSplit && raceobj.send_push && context.send_push_split) {
        sendPushToQueue(race_id, td, raceobj, context, live_camera_url).catch((e) =>
          console.error('[worker] sendPushToQueue:', e.message)
        );
      }
    } catch (err) {
      if (err.status) {
        console.warn('[worker] athlete dropped:', err.message);
        continue;
      }
      console.error('[worker] athlete pipeline error:', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Reception window — bypassed for live or live_test_mode races
// ---------------------------------------------------------------------------
function isWithinReceptionWindow(raceobj) {
  if (raceobj.live_test_mode) return true;
  if (raceobj.islive) return true;
  const now = new Date();
  const start = raceobj.data_reception_start ? new Date(raceobj.data_reception_start) : null;
  const end   = raceobj.data_reception_end   ? new Date(raceobj.data_reception_end)   : null;
  return !!(start && end && now >= start && now <= end);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
async function loop() {
  console.log(`[worker] listening on ${QUEUE_KEY}`);
  while (!shuttingDown) {
    try {
      const popped = await redis.brpop(QUEUE_KEY, BLOCK_TIMEOUT);
      if (!popped) continue;
      const [, raw] = popped;
      let job;
      try {
        job = JSON.parse(raw);
      } catch (e) {
        console.error('[worker] bad job JSON:', e.message, raw);
        continue;
      }
      await dispatch(job);
    } catch (err) {
      console.error('[worker] loop error:', err);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await redis.quit().catch(() => {});
  process.exit(0);
}

function shutdown(sig) {
  console.log(`[worker] ${sig} received, shutting down`);
  shuttingDown = true;
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

loop().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
