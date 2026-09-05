/**
 * RaceResult participant webhook — V2 edition, enqueue only.
 *
 * POST /v2/rr_webhook/:race_id   (race_id = v2.races.id)
 *
 * The CMS registers this URL into the RaceResult event's webhooks
 * ("Evento Participant Update" Type 1 / "Evento New Participant" Type 0,
 * Fields BIB, ID, FIRSTNAME, LASTNAME, CONTEST.ID, CONTEST.NAME). When a
 * timer imports their entrant list RaceResult fires one call per participant
 * — thousands in seconds — so this route only checks the race exists
 * (Redis-cached), LPUSHes onto `ingest_queue` and returns 202. The
 * evento-worker service (../evento-worker, own droplet) does the
 * v2.athletes upsert at DB pace.
 *
 * Public like v1: the race id in the URL is the gate.
 */

const pool  = require('../../config/database');
const redis = require('../../config/redis');

const QUEUE_KEY = 'ingest_queue';
const RACE_TTL  = 60; // seconds — race-exists cache

async function v2RaceExists(raceId) {
  const key = `v2:rr_webhook:race:${raceId}`;
  try { if (await redis.get(key)) return true; } catch { /* fall through */ }
  const { rows } = await pool.query('SELECT 1 FROM v2.races WHERE id = $1', [raceId]);
  if (!rows.length) return false;
  redis.set(key, '1', 'EX', RACE_TTL).catch(() => {});
  return true;
}

async function rrWebhookV2Routes(app) {
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
    const raceId = request.params.race_id;
    if (!(await v2RaceExists(raceId))) {
      return reply.code(404).send({ status: 'error', message: `No v2 race ${raceId}.` });
    }
    await redis.lpush(QUEUE_KEY, JSON.stringify({
      race_id: raceId,
      datetime: new Date().toISOString(),
      endpoint: 'v2/rr_webhook',
      payload: request.body,
    }));
    return reply.code(202).send({ status: 'queued' });
  });
}

module.exports = rrWebhookV2Routes;
