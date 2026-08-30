const { buildTracking } = require('../../services/tracking');

// POST /v1/tracking — body { race_id, tracks: [athlete_id, ...] }
// Core logic lives in services/tracking.js (shared with /v2/tracking).
async function trackingRoutes(app) {
  app.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['race_id', 'tracks'],
        properties: {
          race_id: { type: ['integer', 'string'] },
          tracks:  { type: 'array', items: { type: ['integer', 'string'] } },
        },
      },
    },
  }, async (request, reply) => {
    const raceId = Number(request.body.race_id);
    const tracks = (request.body.tracks || []).map(String);

    const { status, body } = await buildTracking({ raceId, tracks });
    if (status === 404) return reply.notFound(body.error);
    return reply.code(status).send(body);
  });
}

module.exports = trackingRoutes;
