const pool = require('../../config/database');

async function followRoutes(app) {
  // ---------------------------------------------------------------------------
  // POST /follow
  // Body: { event_id, player_id, number, contest? }
  // 201 = followed. 405 = already following.
  // ---------------------------------------------------------------------------
  app.post('/', {
    schema: {
      body: {
        type: 'object',
        properties: {
          event_id:  { type: 'integer' },
          player_id: { type: 'string' },
          number:    { type: 'string' },
          contest:   { type: 'integer' },
        },
        required: ['event_id', 'player_id', 'number'],
      },
    },
  }, async (request, reply) => {
    const { event_id, player_id, number, contest } = request.body;

    try {
      if (contest != null) {
        await pool.query(
          'INSERT INTO follow (race_id, player_id, raceno, contest) VALUES ($1, $2, $3, $4)',
          [event_id, player_id, number, contest]
        );
      } else {
        await pool.query(
          'INSERT INTO follow (race_id, player_id, raceno) VALUES ($1, $2, $3)',
          [event_id, player_id, number]
        );
      }
    } catch (err) {
      // Unique constraint violation — already following
      if (err.code === '23505') {
        return reply.code(405).send({ response: 'not allowed' });
      }
      throw err;
    }

    return reply.code(201).send({ response: 'success' });
  });

  // ---------------------------------------------------------------------------
  // DELETE /follow
  // Body: { event_id, player_id, number }
  // ---------------------------------------------------------------------------
  app.delete('/', {
    schema: {
      body: {
        type: 'object',
        properties: {
          event_id:  { type: 'integer' },
          player_id: { type: 'string' },
          number:    { type: 'string' },
        },
        required: ['event_id', 'player_id', 'number'],
      },
    },
  }, async (request, reply) => {
    const { event_id, player_id, number } = request.body;

    await pool.query(
      'DELETE FROM follow WHERE race_id = $1 AND player_id = $2 AND raceno = $3',
      [event_id, player_id, number]
    );

    return reply.send({ response: 'success' });
  });
}

module.exports = followRoutes;
