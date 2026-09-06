/**
 * Per-install access tokens.
 *
 * The API key baked into an app build identifies the APP; it is in every copy
 * and can be lifted from the binary, so it must not be the credential that
 * reads live data. Instead the app registers each install (POST /v2/auth/
 * register, authenticated with the app key) and receives a short-lived signed
 * token bound to that install. Reads use the token; it expires in 24 h and the
 * app refreshes it silently. A misbehaving install can be revoked on its own.
 */
const jwt = require('jsonwebtoken');
const redis = require('../config/redis');

const SECRET = process.env.JWT_SECRET;
const TTL_SECONDS = Number(process.env.INSTALL_TOKEN_TTL_S || 24 * 3600);
const ISSUER = 'eventoapi';

function assertSecret() {
  if (!SECRET || SECRET.length < 16) throw new Error('JWT_SECRET is not configured');
}

/** Sign a token for one install of one app. */
function issueInstallToken({ appId, installId, keyId, platform }) {
  assertSecret();
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: String(installId), app_id: Number(appId), key_id: keyId ?? null, platform: platform || null, typ: 'install' };
  const token = jwt.sign(payload, SECRET, { issuer: ISSUER, expiresIn: TTL_SECONDS });
  return { token, expires_at: new Date((now + TTL_SECONDS) * 1000).toISOString(), ttl_seconds: TTL_SECONDS };
}

/** Does this bearer string look like one of our tokens (rather than an API key)? */
function looksLikeInstallToken(bearer) {
  return typeof bearer === 'string' && bearer.split('.').length === 3 && bearer.startsWith('eyJ');
}

/** Verify + revocation check. Returns the payload or throws. */
async function verifyInstallToken(token) {
  assertSecret();
  const payload = jwt.verify(token, SECRET, { issuer: ISSUER });
  if (payload.typ !== 'install' || !payload.sub) throw new Error('not an install token');
  const revoked = await redis.get(`revoked:install:${payload.sub}`).catch(() => null);
  if (revoked) throw new Error('install revoked');
  return payload;
}

/** Revoke every token for an install (until the flag expires; default 30 days). */
async function revokeInstall(installId, reason = '', days = 30) {
  await redis.set(`revoked:install:${installId}`, JSON.stringify({ at: new Date().toISOString(), reason }), 'EX', days * 86400);
}

module.exports = { issueInstallToken, verifyInstallToken, looksLikeInstallToken, revokeInstall, TTL_SECONDS };
