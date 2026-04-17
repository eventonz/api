/**
 * Tracks routes — Stage 6 of the tracks pipeline
 *
 * Four POST endpoints, one per timer lookup type.
 * Each loads a raceobj (Stage 1), then runs the shared pipeline:
 *   normalise → processContestandSplits → processSpeed →
 *   checkSplitIsNew → insertResultsTable → insertRedis → sendPushToQueue
 */

const { raceconfigByRaceId, raceconfigBySportSplits, raceconfigByRaceTec, raceconfigByRaceResult } =
  require('../../services/raceConfig');
const { normalise } =
  require('../../services/normalisers');
const { processContestandSplits, processSpeed, checkSplitIsNew, getLiveCameraUrl } =
  require('../../services/trackProcessing');
const { insertResultsTable, insertRedis, logToProcessQueue } =
  require('../../services/trackPersistence');
const { sendPushToQueue } =
  require('../../services/trackPush');

async function tracksRoutes(app) {
  const raceIdParam = {
    type: 'object',
    properties: { race_id: { type: 'integer' } },
    required: ['race_id'],
  };

  // -------------------------------------------------------------------------
  // POST /tracks/race/:race_id — direct Evento race ID
  // -------------------------------------------------------------------------
  app.post('/race/:race_id', { schema: { params: raceIdParam } }, async (request, reply) => {
    const { race_id } = request.params;
    const raceobj = await raceconfigByRaceId(race_id);
    if (!raceobj?.r_id) return reply.code(400).send({ msg: 'Race not found' });
    return handleTrackPost(request, reply, raceobj);
  });

  // -------------------------------------------------------------------------
  // POST /tracks/sportsplits/:ss_raceid — SportSplits race ID lookup
  // -------------------------------------------------------------------------
  app.post('/sportsplits/:ss_raceid', {
    schema: {
      params: { type: 'object', properties: { ss_raceid: { type: 'integer' } }, required: ['ss_raceid'] },
    },
  }, async (request, reply) => {
    const { ss_raceid } = request.params;
    const raceobj = await raceconfigBySportSplits(ss_raceid);
    if (!raceobj?.r_id) return reply.code(400).send({ msg: 'Race not found' });
    return handleTrackPost(request, reply, raceobj);
  });

  // -------------------------------------------------------------------------
  // POST /tracks/racetec/:racetec_apikey — RaceTec API key lookup
  // -------------------------------------------------------------------------
  app.post('/racetec/:racetec_apikey', {
    schema: {
      params: { type: 'object', properties: { racetec_apikey: { type: 'string' } }, required: ['racetec_apikey'] },
    },
  }, async (request, reply) => {
    const { racetec_apikey } = request.params;
    const raceobj = await raceconfigByRaceTec(racetec_apikey);
    if (!raceobj?.r_id) return reply.code(400).send({ msg: 'Race not found' });
    return handleTrackPost(request, reply, raceobj);
  });

  // -------------------------------------------------------------------------
  // POST /tracks/raceresult/:rr_eventid — RaceResult event ID lookup
  // -------------------------------------------------------------------------
  app.post('/raceresult/:rr_eventid', {
    schema: {
      params: { type: 'object', properties: { rr_eventid: { type: 'integer' } }, required: ['rr_eventid'] },
    },
  }, async (request, reply) => {
    const { rr_eventid } = request.params;
    const raceobj = await raceconfigByRaceResult(rr_eventid);
    if (!raceobj?.r_id) return reply.code(400).send({ msg: 'Race not found' });
    return handleTrackPost(request, reply, raceobj);
  });
}

// ---------------------------------------------------------------------------
// Shared pipeline — runs for all four route variants
// ---------------------------------------------------------------------------
async function handleTrackPost(request, reply, raceobj) {
  const r_id    = raceobj.r_id;
  const rawBody = JSON.stringify(request.body);

  // 1. Log raw payload to process_queue (fire and forget)
  logToProcessQueue(r_id, rawBody).catch(() => {});

  // 2. Reception window check — abort if not live and outside window
  try {
    checkReceptionWindow(raceobj);
  } catch (err) {
    return reply.code(err.status ?? 400).send({ msg: err.message });
  }

  // 3. Normalise raw payload into trackdata / trackdataarray
  //    Stage 2 normalisers plug into src/services/normalisers/index.js
  const { trackdata, trackdataarray } = normalise(request.body, raceobj);

  // 4. Process — single athlete or batch
  const athletes = trackdataarray ?? [trackdata];
  let lastRaceNo = '';

  for (const td of athletes) {
    try {
      // Stage 3: find contest + split, build message, derive flags
      const context = processContestandSplits(td, raceobj);

      // Stage 3: live camera URL (empty string if none configured)
      const live_camera_url = getLiveCameraUrl(raceobj, context.arrayIndex, td);

      // Stage 3: resolve speed
      processSpeed(td, context);

      // Default marker_text to race_no if not set by normaliser
      if (!td.marker_text) td.marker_text = td.race_no;

      // Stage 3: Redis SADD dedup
      const splitCheck = await checkSplitIsNew(r_id, td);

      // Stage 4: always upsert results table (regardless of dedup)
      insertResultsTable(r_id, td, raceobj).catch(() => {});

      // Stage 4 + 5: Redis tracking + push only when split is genuinely new
      if (splitCheck.isNewSplit && context.is_tracking) {
        insertRedis(r_id, td, context, live_camera_url).catch(() => {});
      }

      if (splitCheck.isNewSplit && raceobj.send_push && context.send_push_split) {
        sendPushToQueue(r_id, td, raceobj, context, live_camera_url).catch(() => {});
      }

      lastRaceNo = td.race_no ?? lastRaceNo;

    } catch (err) {
      // processContestandSplits throws { status, message } for bad contest/split
      if (err.status) {
        return reply.code(err.status).send({ msg: err.message });
      }
      throw err; // unexpected — let Fastify's error handler catch it
    }
  }

  return reply.code(201).send({ message: `Record Created ${lastRaceNo}` });
}

// ---------------------------------------------------------------------------
// Reception window check
// Mirrors the CF live/reception guard in tracks.cfm.
// live_test_mode bypasses everything.
// Throws { status, message } if data should be rejected.
// ---------------------------------------------------------------------------
function checkReceptionWindow(raceobj) {
  if (raceobj.live_test_mode) return;

  if (!raceobj.islive) {
    const now   = new Date();
    const start = raceobj.data_reception_start ? new Date(raceobj.data_reception_start) : null;
    const end   = raceobj.data_reception_end   ? new Date(raceobj.data_reception_end)   : null;

    const inWindow = start && end && now >= start && now <= end;
    if (!inWindow) {
      throw { status: 400, message: 'Event is not LIVE and not within data reception window' };
    }
  }
}

module.exports = tracksRoutes;
