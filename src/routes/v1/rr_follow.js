/**
 * Follow a RaceResult participant for a finish-time push notification.
 *
 * The app's start-list athlete detail has a bell; tapping it stores a
 * (rr_eventid, athlete_id=pid, player_id) row in `rr_follows`. When the athlete
 * finishes, the Evento finish-notification exporter pushes to
 * /v1/rr_follow_push/:rr_eventid which matches these rows and sends one push.
 *
 * Mirrors the existing /v1/follow endpoints (src/routes/v1/follow.js).
 */

const pool = require('../../config/database');

async function rrFollowRoutes(app) {
  // POST /v1/rr_follow — 201 followed, 405 already following
  app.post('/', {
    schema: {
      body: {
        type: 'object',
        properties: {
          rr_eventid: { type: 'integer' },
          athlete_id: { type: 'string' },
          player_id:  { type: 'string' },
          bib:        { type: 'string' },
          name:       { type: 'string' },
        },
        required: ['rr_eventid', 'athlete_id', 'player_id'],
      },
    },
  }, async (request, reply) => {
    const { rr_eventid, athlete_id, player_id, bib, name } = request.body;
    try {
      await pool.query(
        `INSERT INTO rr_follows (rr_eventid, athlete_id, player_id, bib, name)
         VALUES ($1, $2, $3, $4, $5)`,
        [rr_eventid, athlete_id, player_id, bib ?? null, name ?? null]
      );
    } catch (err) {
      if (err.code === '23505') {
        return reply.code(405).send({ response: 'not allowed' });
      }
      throw err;
    }
    return reply.code(201).send({ response: 'success' });
  });

  // DELETE /v1/rr_follow
  app.delete('/', {
    schema: {
      body: {
        type: 'object',
        properties: {
          rr_eventid: { type: 'integer' },
          athlete_id: { type: 'string' },
          player_id:  { type: 'string' },
        },
        required: ['rr_eventid', 'athlete_id', 'player_id'],
      },
    },
  }, async (request, reply) => {
    const { rr_eventid, athlete_id, player_id } = request.body;
    await pool.query(
      'DELETE FROM rr_follows WHERE rr_eventid = $1 AND athlete_id = $2 AND player_id = $3',
      [rr_eventid, athlete_id, player_id]
    );
    return reply.send({ response: 'success' });
  });

  // GET /v1/rr_follow/:rr_eventid?player_id=...
  // Returns the athlete_ids this device follows for the event (to fill bells).
  app.get('/:rr_eventid', {
    schema: {
      params: {
        type: 'object',
        properties: { rr_eventid: { type: 'integer' } },
        required: ['rr_eventid'],
      },
    },
  }, async (request, reply) => {
    const { rr_eventid } = request.params;
    const player_id = request.query.player_id;
    if (!player_id) return reply.send({ athlete_ids: [] });

    const { rows } = await pool.query(
      'SELECT athlete_id FROM rr_follows WHERE rr_eventid = $1 AND player_id = $2',
      [rr_eventid, player_id]
    );
    return reply.send({ athlete_ids: rows.map((r) => r.athlete_id) });
  });
}

module.exports = rrFollowRoutes;
