const { buildSplits } = require('../../services/splits');

// Mirrors API/api/v4/modules/splits.cfm
//
// GET /v1/splits/:race_id?bib=...&id=...&contest=...
//
// CF reads:
//   r_id        from path (or ?race=)
//   url.bib     bib (falls back to ?id=)
//   url.id      athlete_id
//   url.contest currently selected contest
async function splitsRoutes(app) {
  app.get('/:race_id', {
    schema: {
      params: {
        type: 'object',
        properties: { race_id: { type: ['integer', 'string'] } },
        required: ['race_id'],
      },
      querystring: {
        type: 'object',
        properties: {
          bib:     { type: 'string' },
          id:      { type: 'string' },
          contest: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const raceId = Number(request.params.race_id);
    if (!Number.isFinite(raceId)) {
      return reply.code(400).send({ error: 'Missing or invalid race ID' });
    }

    const q = request.query || {};
    const athleteId = (q.id || '').trim();
    // CF: bib falls back to id when not provided
    const bib       = (q.bib || q.id || '').trim();
    const contest   = (q.contest || '').trim();

    const { status, body } = await buildSplits({ raceId, bib, athleteId, contest });
    return reply.code(status).send(body);
  });
}

module.exports = splitsRoutes;
