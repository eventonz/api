const crypto = require('crypto');

/**
 * Finisher Snap photographer tokens: `snp_<base64url payload>.<base64url sig>`,
 * HMAC-SHA256 with JWT_SECRET. Payload `{ e: event_id, exp: unix seconds }`.
 * One token = one event; the photographer earned it with the event's code.
 */
const PREFIX = 'snp_';
const TTL_SECONDS = 7 * 24 * 3600;

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set');
  return `finisher-snap:${s}`;
}

const sign = (body) => crypto.createHmac('sha256', secret()).update(body).digest('base64url');

function issueSnapToken(eventId, now = Date.now()) {
  const exp = Math.floor(now / 1000) + TTL_SECONDS;
  const body = Buffer.from(JSON.stringify({ e: eventId, exp })).toString('base64url');
  return { token: `${PREFIX}${body}.${sign(body)}`, expires_at: new Date(exp * 1000).toISOString() };
}

/** → event_id, or throws ('expired' | 'invalid'). */
function verifySnapToken(token, now = Date.now()) {
  if (typeof token !== 'string' || !token.startsWith(PREFIX)) throw new Error('invalid');
  const [body, sig] = token.slice(PREFIX.length).split('.');
  if (!body || !sig) throw new Error('invalid');
  const want = Buffer.from(sign(body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw new Error('invalid');
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new Error('invalid'); }
  if (!p || typeof p.e !== 'string' || typeof p.exp !== 'number') throw new Error('invalid');
  if (p.exp * 1000 < now) throw new Error('expired');
  return p.e;
}

/** Case-insensitive, timing-safe compare of a typed code with the event's code. */
function codesMatch(typed, actual) {
  const a = String(typed || '').trim().toUpperCase();
  const b = String(actual || '').trim().toUpperCase();
  if (!a || !b) return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = { issueSnapToken, verifySnapToken, codesMatch, TTL_SECONDS };
