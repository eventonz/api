const pool  = require('../../config/database');
const redis = require('../../config/redis');

const CACHE_TTL = 1800; // 30 minutes
const cacheKey  = (app_id) => `app_version:${app_id}`;

async function appVersionRoutes(app) {
  // ---------------------------------------------------------------------------
  // GET /app_version/:app_id
  // Cached in Redis (5min TTL). Returns version strings + store URLs.
  // ---------------------------------------------------------------------------
  app.get('/:app_id', {
    schema: {
      params: {
        type: 'object',
        properties: { app_id: { type: 'integer' } },
        required: ['app_id'],
      },
    },
  }, async (request, reply) => {
    const { app_id } = request.params;
    const key = cacheKey(app_id);

    // 1. Cache hit
    const cached = await redis.get(key);
    if (cached) {
      reply.header('X-Cache', 'HIT');
      return reply.send(JSON.parse(cached));
    }

    // 2. DB fallback
    const { rows } = await pool.query(
      `SELECT version, android_version, ios_store_url, android_store_url
       FROM apps
       WHERE id = $1`,
      [app_id]
    );
    if (rows.length === 0) return reply.notFound('App not found');

    const r = rows[0];
    const payload = {
      ios_version:       r.version,
      android_version:   r.android_version,
      ios_store_url:     r.ios_store_url,
      android_store_url: r.android_store_url,
    };

    // 3. Populate cache (fire and forget)
    redis.setex(key, CACHE_TTL, JSON.stringify(payload)).catch(() => {});

    reply.header('X-Cache', 'MISS');
    return reply.send(payload);
  });

  // ---------------------------------------------------------------------------
  // POST /app_version/:app_id — update version, busts cache.
  // ---------------------------------------------------------------------------
  app.post('/:app_id', {
    schema: {
      params: {
        type: 'object',
        properties: { app_id: { type: 'integer' } },
        required: ['app_id'],
      },
      body: {
        type: 'object',
        properties: {
          version:          { type: 'string' },
          android_version:  { type: 'string' },
          ios_store_url:    { type: 'string' },
          android_store_url:{ type: 'string' },
        },
        required: ['version', 'android_version'],
      },
    },
  }, async (request, reply) => {
    const { app_id }                                          = request.params;
    const { version, android_version, ios_store_url, android_store_url } = request.body;

    const sets   = ['version = $2', 'android_version = $3'];
    const params = [app_id, version, android_version];

    if (ios_store_url?.trim()) {
      params.push(ios_store_url);
      sets.push(`ios_store_url = $${params.length}`);
    }
    if (android_store_url?.trim()) {
      params.push(android_store_url);
      sets.push(`android_store_url = $${params.length}`);
    }

    await pool.query(
      `UPDATE apps SET ${sets.join(', ')} WHERE id = $1`,
      params
    );

    // Bust cache so the next GET repopulates
    await redis.del(cacheKey(app_id)).catch(() => {});

    return reply.send({ success: true, message: 'App version updated successfully' });
  });
}

module.exports = appVersionRoutes;
