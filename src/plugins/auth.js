const crypto = require('crypto');
const pool   = require('../config/database');
const redis  = require('../config/redis');

const CACHE_TTL    = 300;        // seconds — cache valid keys for 5 min
const CACHE_PREFIX = 'apikey:';

async function authHook(request, reply) {
  const authHeader = request.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Missing or invalid Authorization header' });
  }

  const token    = authHeader.slice(7).trim();
  const keyHash  = crypto.createHash('sha256').update(token).digest('hex');
  const cacheKey = CACHE_PREFIX + keyHash;

  // 1. Check Redis cache
  const cached = await redis.get(cacheKey);
  if (cached === 'valid') return;
  if (cached === 'invalid') {
    return reply.code(401).send({ error: 'Invalid API key' });
  }

  // 2. Cache miss — check Postgres
  const { rows } = await pool.query(
    'SELECT id, name, app_id FROM api_keys WHERE key_hash = $1 AND active = TRUE',
    [keyHash]
  );

  if (rows.length === 0) {
    await redis.setex(cacheKey, CACHE_TTL, 'invalid');
    return reply.code(401).send({ error: 'Invalid API key' });
  }

  // 3. Valid — cache it and attach key context to request
  await redis.setex(cacheKey, CACHE_TTL, 'valid');
  request.apiKey = rows[0];

  // Update last_used_at without blocking the request
  pool.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [rows[0].id]).catch(() => {});
}

module.exports = authHook;
