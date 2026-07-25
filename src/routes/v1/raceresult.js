/**
 * RaceResult routes — scheduled split pulls.
 *
 * POST /v1/raceresult/pull/:race_id
 *   Resolves the RR splits feed URL from race config (raceobj.rr_splits),
 *   fetches the feed, groups by athlete, and writes to Redis under
 *   `redis_splits:{race_id}:athlete:{athlete_id}`.
 *
 *   Bearer-token-auth is applied by the parent scope in routes/v1/index.js,
 *   so this endpoint cannot be triggered from outside the organisation.
 */

const { raceconfigByRaceId } = require('../../services/raceConfig');
const { pullRaceResultSplits } = require('../../services/raceresultPull');
const redis = require('../../config/redis');

const PULL_STATUS_KEY = (raceId) => `redis_splits:pull:status:${raceId}`;
const PULL_STATUS_TTL = 72 * 3600;

async function setPullStatus(raceId, status) {
  try {
    await redis.set(PULL_STATUS_KEY(raceId), JSON.stringify(status), 'EX', PULL_STATUS_TTL);
  } catch { /* status is best-effort */ }
}

async function raceresultRoutes(app) {
  const pullSchema = {
    params: {
      type: 'object',
      properties: { race_id: { type: 'integer' } },
      required: ['race_id'],
    },
  };

  const pullHandler = async (request, reply) => {
    const raceId = Number(request.params.race_id);

    const raceobj = await raceconfigByRaceId(raceId);
    if (!raceobj?.r_id) {
      return reply.code(404).send({ error: 'Race not found' });
    }

    // Prefer the splits-specific feed; fall back to races.rr_results — the
    // same URL the CF importer (splits.cfc update_live_timing_table) pulls.
    const feedUrl = raceobj.timing?.rr_splits || raceobj.rr_splits
      || raceobj.timing?.rr_results || raceobj.rr_results;
    if (!feedUrl) {
      return reply.code(400).send({
        error: 'No RaceResult feed URL configured for this race (races.rr_splits / races.rr_results)',
      });
    }

    // ?wait=1 → synchronous (Postman/debugging). Default → respond
    // immediately and pull in the background, so cron/gateway timeouts
    // (often < the 15-30s feed download) never bite. Outcome of the last
    // run is stored in Redis and served by GET /pull/:race_id/status.
    const wait = String(request.query?.wait || '') === '1';

    if (wait) {
      try {
        const result = await pullRaceResultSplits({ raceId, feedUrl });
        await setPullStatus(raceId, { state: 'done', ...result });
        return reply.code(200).send(result);
      } catch (err) {
        request.log.error({ err, raceId }, 'raceresult pull failed');
        await setPullStatus(raceId, { state: 'error', raceId, error: err.message });
        return reply.code(502).send({ error: err.message });
      }
    }

    setPullStatus(raceId, { state: 'running', raceId }).catch(() => {});
    pullRaceResultSplits({ raceId, feedUrl })
      .then((result) => setPullStatus(raceId, { state: 'done', ...result }))
      .catch((err) => {
        request.log.error({ err, raceId }, 'raceresult background pull failed');
        return setPullStatus(raceId, { state: 'error', raceId, error: err.message });
      });
    return reply.code(202).send({ started: true, raceId });
  };

  const statusHandler = async (request, reply) => {
    const raceId = Number(request.params.race_id);
    const raw = await redis.get(PULL_STATUS_KEY(raceId));
    if (!raw) return reply.code(404).send({ error: 'No pull recorded for this race' });
    return reply.code(200).send(JSON.parse(raw));
  };

  // GET is cron-friendly: schedulers like EasyCron often send POST with an
  // empty application/json body, which Fastify rejects (FST_ERR_CTP_EMPTY_JSON_BODY).
  app.post('/pull/:race_id', { schema: pullSchema }, pullHandler);
  app.get('/pull/:race_id',  { schema: pullSchema }, pullHandler);
  app.get('/pull/:race_id/status', { schema: pullSchema }, statusHandler);
}

module.exports = raceresultRoutes;
