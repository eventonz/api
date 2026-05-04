/**
 * Adverts — impression / click tracking.
 *
 * Mirrors API/api/v4/modules/adverts.cfm:
 *   POST /v1/adverts/:uuid   body { action: 'impression' | 'click' }
 *
 * High-volume fire-and-forget candidate — for now we increment synchronously.
 * Move to worker_queue later when scale demands it.
 */

const pool = require('../../config/database');

async function advertsRoutes(app) {
  app.post('/:uuid', {
    schema: {
      params: {
        type: 'object',
        properties: { uuid: { type: 'string', minLength: 1 } },
        required: ['uuid'],
      },
      body: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['impression', 'click'] } },
        required: ['action'],
      },
    },
  }, async (request, reply) => {
    const { uuid }   = request.params;
    const { action } = request.body;

    const column = action === 'click' ? 'clicks' : 'impressions';
    const result = await pool.query(
      `UPDATE adverts SET ${column} = ${column} + 1 WHERE uuid = $1`,
      [uuid]
    );

    if (result.rowCount === 0) {
      return reply.code(400).send({ message: 'Advert not found' });
    }

    return reply.send({ message: 'Advert Updated' });
  });
}

module.exports = advertsRoutes;
