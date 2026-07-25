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

async function raceresultRoutes(app) {
  app.post('/pull/:race_id', {
    schema: {
      params: {
        type: 'object',
        properties: { race_id: { type: 'integer' } },
        required: ['race_id'],
      },
    },
  }, async (request, reply) => {
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

    try {
      const result = await pullRaceResultSplits({ raceId, feedUrl });
      return reply.code(200).send(result);
    } catch (err) {
      request.log.error({ err, raceId }, 'raceresult pull failed');
      return reply.code(502).send({ error: err.message });
    }
  });
}

module.exports = raceresultRoutes;
