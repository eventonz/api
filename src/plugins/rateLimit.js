/**
 * Fixed-window rate limiter on Redis (INCR + EXPIRE), fail-open.
 *
 *   app.addHook('preHandler', rateLimit({ name: 'reads', limit: 600, windowSec: 60, key: (req) => identity }))
 *
 * Sets X-RateLimit-* headers; answers 429 with Retry-After when exceeded.
 * A Redis hiccup never blocks traffic — the limiter is protection, not auth.
 */
const redis = require('../config/redis');

function rateLimit({ name, limit, windowSec, key }) {
  return async function rateLimitHook(request, reply) {
    let id;
    try { id = key(request); } catch { id = null; }
    if (!id) return;
    const bucket = Math.floor(Date.now() / 1000 / windowSec);
    const k = `rl:${name}:${id}:${bucket}`;
    let count;
    try {
      count = await redis.incr(k);
      if (count === 1) redis.expire(k, windowSec + 1).catch(() => {});
    } catch { return; } // fail open
    reply.header('X-RateLimit-Limit', limit);
    reply.header('X-RateLimit-Remaining', Math.max(0, limit - count));
    if (count > limit) {
      const retry = windowSec - (Math.floor(Date.now() / 1000) % windowSec);
      reply.header('Retry-After', retry);
      return reply.code(429).send({ error: 'Too many requests', retry_after: retry });
    }
  };
}

const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';

module.exports = { rateLimit, clientIp };
