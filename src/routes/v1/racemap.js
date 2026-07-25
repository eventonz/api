/**
 * Race Map routes — port of API/api/v4/modules/racemap.cfm.
 *
 * GET/POST /v1/racemap/:race_id — fetch GPS data from the race's
 * racemap_url and refresh tracking:race:* keys in Redis.
 * Triggered by EasyCron (every 10 min while auto-refresh is on) and the
 * CMS race map settings tab. GET supported so cron needs no body.
 */

const { refreshRaceMap } = require('../../services/racemap');

async function racemapRoutes(app) {
  const schema = {
    params: {
      type: 'object',
      properties: { race_id: { type: 'integer' } },
      required: ['race_id'],
    },
  };

  const handler = async (request, reply) => {
    const raceId = Number(request.params.race_id);
    if (!Number.isFinite(raceId) || raceId <= 0) {
      return reply.code(400).send({ error: 'Invalid or missing race_id' });
    }
    try {
      const result = await refreshRaceMap(raceId);
      return reply.code(result.success ? 200 : 400).send(result);
    } catch (err) {
      request.log.error({ err, raceId }, 'racemap refresh failed');
      return reply.code(502).send({ success: false, message: err.message, race_id: raceId });
    }
  };

  app.get('/:race_id',  { schema }, handler);
  app.post('/:race_id', { schema }, handler);
}

module.exports = racemapRoutes;
