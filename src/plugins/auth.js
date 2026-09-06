const crypto = require('crypto');
const pool   = require('../config/database');
const redis  = require('../config/redis');
const { looksLikeInstallToken, verifyInstallToken } = require('../services/installTokens');

const CACHE_TTL    = 300;        // seconds — cache API key lookups for 5 min
const CACHE_PREFIX = 'apikey:';

/**
 * Bearer auth for the app-facing endpoints. Two credentials are accepted:
 *
 *   • an INSTALL TOKEN (signed JWT from POST /v2/auth/register) — the normal
 *     credential for reads; request.auth = { type: 'install', app_id, install_id }
 *   • an APP API KEY (api_keys table) — bootstrap credential; also still
 *     accepted for reads until READS_REQUIRE_INSTALL_TOKEN=1 is set, so
 *     existing app builds keep working during the rollout.
 *
 * request.apiKey keeps its old shape ({ id, name, app_id }) for handlers that
 * read it; request.auth carries the identity used for rate limiting.
 */
async function authHook(request, reply) {
  const authHeader = request.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Missing or invalid Authorization header' });
  }
  const bearer = authHeader.slice(7).trim();

  // --- install token -------------------------------------------------------
  if (looksLikeInstallToken(bearer)) {
    try {
      const p = await verifyInstallToken(bearer);
      request.auth = { type: 'install', app_id: p.app_id, install_id: p.sub, key_id: p.key_id };
      request.apiKey = { id: p.key_id, name: 'install-token', app_id: p.app_id };
      return;
    } catch (err) {
      const expired = /expired/i.test(err.message);
      return reply.code(401).send({ error: expired ? 'Install token expired' : 'Invalid install token', code: expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID' });
    }
  }

  // --- app API key -----------------------------------------------------------
  const keyHash  = crypto.createHash('sha256').update(bearer).digest('hex');
  const cacheKey = CACHE_PREFIX + keyHash;
  let row = null;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached === 'invalid') return reply.code(401).send({ error: 'Invalid API key' });
  if (cached && cached !== 'valid') { try { row = JSON.parse(cached); } catch { row = null; } }
  if (!row) {
    const { rows } = await pool.query(
      'SELECT id, name, app_id, kind FROM api_keys WHERE key_hash = $1 AND active = TRUE',
      [keyHash]
    );
    if (rows.length === 0) {
      await redis.setex(cacheKey, CACHE_TTL, 'invalid').catch(() => {});
      return reply.code(401).send({ error: 'Invalid API key' });
    }
    row = rows[0];
    await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(row)).catch(() => {});
    pool.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [row.id]).catch(() => {});
  }
  request.apiKey = row;
  request.auth = { type: 'key', app_id: row.app_id, key_id: row.id, key_hash: keyHash.slice(0, 16), kind: row.kind || 'app' };

  // Rollout switch: once every build uses install tokens, APP keys (baked into
  // builds) may only register. SERVER keys (CMS, worker, integrations —
  // api_keys.kind = 'server') are unaffected.
  if (request.auth.kind !== 'server' && !request.routeOptions?.config?.allowApiKey && await readsRequireInstallToken()) {
    return reply.code(401).send({ error: 'Use an install token (POST /v2/auth/register)', code: 'INSTALL_TOKEN_REQUIRED' });
  }
}

// The switch lives in Redis (config:reads_require_install_token = "1") so it can
// be flipped without a deploy or an env edit; env var is the fallback. Cached 30 s.
let switchCache = { at: 0, on: false };
async function readsRequireInstallToken() {
  if (Date.now() - switchCache.at < 30000) return switchCache.on;
  let on = process.env.READS_REQUIRE_INSTALL_TOKEN === '1';
  try {
    const v = await redis.get('config:reads_require_install_token');
    if (v != null) on = v === '1';
  } catch { /* keep env value */ }
  switchCache = { at: Date.now(), on };
  return on;
}

module.exports = authHook;
