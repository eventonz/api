/**
 * RaceResult participant_update webhook — enqueue endpoint.
 *
 * Validates the route param + body shape, then LPUSHes a job envelope to
 * Redis LIST `worker_queue` and returns 202. The DB upsert + observation
 * logging happens in src/workers/handlers/rrWebhook.js.
 */

const redis = require('../../config/redis');

const QUEUE_KEY = 'worker_queue';

async function rrWebhookRoutes(app) {
  app.post('/:race_id', {
    schema: {
      params: {
        type: 'object',
        properties: { race_id: { type: 'integer' } },
        required: ['race_id'],
      },
      body: {
        type: 'object',
        properties: { Values: { type: 'object' } },
        required: ['Values'],
      },
    },
  }, async (request, reply) => {
    const job = JSON.stringify({
      race_id:  request.params.race_id,
      datetime: new Date().toISOString(),
      endpoint: 'rr_webhook',
      payload:  request.body,
    });
    await redis.lpush(QUEUE_KEY, job);
    return reply.code(202).send({ status: 'queued' });
  });
}

module.exports = rrWebhookRoutes;
