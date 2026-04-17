const pool  = require('../../config/database');
const redis = require('../../config/redis');

const CACHE_TTL = 60; // 1 minute — notifications are time-sensitive

async function notificationsRoutes(app) {
  app.get('/:race_id', {
    schema: {
      params: {
        type: 'object',
        properties: { race_id: { type: 'integer' } },
        required: ['race_id'],
      },
    },
  }, async (request, reply) => {
    const { race_id } = request.params;
    const cacheKey    = `node:notifications:${race_id}`;

    // 1. Redis cache check
    const cached = await redis.get(cacheKey);
    if (cached) return reply.send(JSON.parse(cached));

    // 2. Query — last 14 days of sent notifications
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 14);

    const { rows } = await pool.query(
      `SELECT id, title, content, urlopen
       FROM notifications
       WHERE race_id = $1
         AND status = 'Sent'
         AND sendafter >= $2
         AND sendafter <= NOW()
       ORDER BY sendafter ASC`,
      [race_id, cutoff]
    );

    const data = {
      race_id:       race_id,
      notifications: rows.map((r) => ({
        id:      r.id,
        title:   r.title,
        content: r.content,
        urlopen: r.urlopen ?? '',
      })),
    };

    await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(data));
    return reply.send(data);
  });
}

module.exports = notificationsRoutes;
