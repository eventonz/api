/**
 * Tracks routes — ingest endpoints
 *
 * Each POST resolves the race_id (cheap, Redis-cached raceConfig lookup),
 * then LPUSHes a job envelope onto Redis LIST `worker_queue`. A separate
 * worker process (src/workers/trackWorker.js) BRPOPs and runs the full
 * pipeline. Returning 202 immediately keeps the request path fast and
 * absorbs event-start spikes.
 *
 * Envelope:
 *   { race_id, datetime, endpoint, payload }
 */

const redis = require('../../config/redis');
const {
  raceconfigByRaceId,
  raceconfigBySportSplits,
  raceconfigByRaceTec,
  raceconfigByRaceResult,
} = require('../../services/raceConfig');

const QUEUE_KEY = 'worker_queue';

// Race must be live, in test mode, or within data reception window.
function acceptsData(raceobj) {
  if (raceobj.live_test_mode) return true;
  if (raceobj.islive) return true;
  if (raceobj.tracking_scriptv3 === 'test_script.cfm') return true;
  const start = raceobj.data_reception_start ? new Date(raceobj.data_reception_start) : null;
  const end   = raceobj.data_reception_end   ? new Date(raceobj.data_reception_end)   : null;
  const now   = new Date();
  return !!(start && end && now >= start && now <= end);
}

// Fastify already 400s malformed JSON when Content-Type is application/json.
// This catches calls with no/wrong content-type that left request.body as a
// string or undefined.
function isValidJsonBody(body) {
  return body != null && typeof body === 'object';
}

async function tracksRoutes(app) {
  const enqueue = async (race_id, endpoint, payload) => {
    const job = JSON.stringify({
      race_id,
      datetime: new Date().toISOString(),
      endpoint,
      payload,
    });
    await redis.lpush(QUEUE_KEY, job);
  };

  // Wraps the per-endpoint handler with race-exists + accepts-data + JSON checks.
  const guard = (lookup, endpointName) => async (request, reply) => {
    if (!isValidJsonBody(request.body)) {
      return reply.code(400).send({ msg: 'Body must be valid JSON' });
    }
    const idParam = Object.values(request.params)[0];
    const raceobj = await lookup(idParam);
    if (!raceobj?.r_id) return reply.code(400).send({ msg: 'Race not found' });
    if (!acceptsData(raceobj)) {
      return reply.code(202).send({ message: 'Race not accepting data' });
    }
    await enqueue(raceobj.r_id, endpointName, request.body);
    return reply.code(202).send({ message: 'Queued' });
  };

  app.post('/race/:race_id', {
    schema: { params: { type: 'object', properties: { race_id: { type: 'integer' } }, required: ['race_id'] } },
  }, guard(raceconfigByRaceId, 'tracks/race'));

  app.post('/sportsplits/:ss_raceid', {
    schema: { params: { type: 'object', properties: { ss_raceid: { type: 'integer' } }, required: ['ss_raceid'] } },
  }, guard(raceconfigBySportSplits, 'tracks/sportsplits'));

  app.post('/racetec/:racetec_apikey', {
    schema: { params: { type: 'object', properties: { racetec_apikey: { type: 'string' } }, required: ['racetec_apikey'] } },
  }, guard(raceconfigByRaceTec, 'tracks/racetec'));

  app.post('/raceresult/:rr_eventid', {
    schema: { params: { type: 'object', properties: { rr_eventid: { type: 'integer' } }, required: ['rr_eventid'] } },
  }, guard(raceconfigByRaceResult, 'tracks/raceresult'));
}

module.exports = tracksRoutes;
