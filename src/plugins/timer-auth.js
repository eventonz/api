const crypto = require('crypto');
const pool   = require('../config/database');
const redis  = require('../config/redis');

const CACHE_TTL    = 300;             // seconds — cache valid tokens for 5 min
const CACHE_PREFIX = 'timer_token:';

/**
 * Timer API authentication hook
 * Validates Bearer tokens starting with 'evt_' against timer_api_tokens table
 */
async function timerAuthHook(request, reply) {
  const authHeader = request.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.code(401).send({
      status: 'error',
      code: 401,
      message: 'Missing Authorization header. Expected: Authorization: Bearer evt_...'
    });
  }

  const token = authHeader.slice(7).trim();

  // Validate token format
  if (!token.startsWith('evt_')) {
    return reply.code(401).send({
      status: 'error',
      code: 401,
      message: 'Invalid token format. Token must begin with evt_'
    });
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const cacheKey  = CACHE_PREFIX + tokenHash;

  // 1. Check Redis cache
  const cached = await redis.get(cacheKey);
  if (cached) {
    const tokenData = JSON.parse(cached);
    if (tokenData === 'invalid') {
      return reply.code(401).send({
        status: 'error',
        code: 401,
        message: 'Invalid or inactive token.'
      });
    }
    request.timerToken = tokenData;
    return;
  }

  // 2. Cache miss — check Postgres
  const { rows } = await pool.query(
    'SELECT id, org_id, app_id FROM timer_api_tokens WHERE token_hash = $1 AND is_active = TRUE',
    [tokenHash]
  );

  if (rows.length === 0) {
    await redis.setex(cacheKey, CACHE_TTL, JSON.stringify('invalid'));
    return reply.code(401).send({
      status: 'error',
      code: 401,
      message: 'Invalid or inactive token.'
    });
  }

  // 3. Valid — cache it and attach token context to request
  const tokenData = rows[0];
  await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(tokenData));
  request.timerToken = tokenData;

  // Update last_used without blocking the request
  pool.query('UPDATE timer_api_tokens SET last_used = NOW() WHERE id = $1', [tokenData.id]).catch(() => {});
}

module.exports = timerAuthHook;
