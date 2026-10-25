const pool = require('../../config/database');
const { buildSplits } = require('../../services/splits');

// Mirrors API/api/v4/modules/splits.cfm
//
// GET /v1/splits/race/:race_id?bib=...&id=...&contest=...
//
// CF reads:
//   r_id        from path (or ?race=)
//   url.bib     bib (falls back to ?id=)
//   url.id      athlete_id
//   url.contest currently selected contest
async function splitsRoutes(app) {
  app.get('/race/:race_id', {
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
    const contest   = (q.contest || '').trim();
    // No bib sent: the startlist's race number, so {{RaceNo}} / {bib} in the
    // finisher links is the bib; CF's id fallback when the athlete isn't known.
    let bib = (q.bib || '').trim();
    if (!bib && athleteId) {
      const { rows } = await pool.query(
        'SELECT raceno::text AS raceno FROM athletes WHERE athlete_id = $1 AND race_id = $2 LIMIT 1',
        [athleteId, raceId]
      ).catch(() => ({ rows: [] }));
      bib = String(rows[0]?.raceno || '').trim();
    }
    if (!bib) bib = athleteId;

    const { status, body } = await buildSplits({ raceId, bib, athleteId, contest });
    return reply.code(status).send(body);
  });
}

module.exports = splitsRoutes;
