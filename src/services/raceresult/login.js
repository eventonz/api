/**
 * RaceResult Organisation API login: API key → short-lived bearer token.
 *
 * RaceResult is moving events.raceresult.com to JWT bearer tokens (email from
 * Thorsten G., 14 Nov 2026). The legacy `POST /api/public/login` keeps working
 * until 31 Dec 2026 and is gone from 1 Jan 2027; the replacement is
 * `POST /api/token/get` (same form field `apikey`) which answers
 * `{ access_token, token_type, refresh_token, expiry }`, the access token
 * living 2 hours. Existing API keys work unchanged on both.
 *
 * We try the new endpoint first and fall back to the legacy one only when the
 * new one is unreachable or answers something other than "bad credentials"
 * (a 401/403 means the key itself is wrong — no point retrying it elsewhere).
 * Callers keep re-logging with the key inside the token's lifetime (Redis
 * cache of 10 min), so the refresh token is deliberately not used.
 */

const RR_BASE = 'https://events.raceresult.com';
const TOKEN_URL = `${RR_BASE}/api/token/get`;
const LEGACY_LOGIN_URL = `${RR_BASE}/api/public/login`;
const DEFAULT_TIMEOUT_MS = 20000;

/**
 * Pull a bearer token out of either login response body.
 * New: {access_token}. Legacy: {Token} or the bare token, sometimes quoted.
 */
function parseTokenBody(text) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      const j = JSON.parse(t);
      return String(j?.access_token || j?.Token || j?.token || '').trim();
    } catch {
      return '';
    }
  }
  return t.replace(/^"|"$/g, '');
}

/**
 * @param {string} apikey — the organisation's RaceResult API key (decrypted)
 * @param {{fetch?: typeof fetch, timeoutMs?: number}} [opts]
 * @returns {Promise<string>} bearer token
 * @throws Error with `.status` (HTTP status of the decisive response) and
 *         `.message` safe to surface — never includes the key.
 */
async function rrLogin(apikey, opts = {}) {
  const doFetch = opts.fetch || fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!apikey || !String(apikey).trim()) {
    throw Object.assign(new Error('RaceResult login needs an API key'), { status: 0 });
  }
  const form = {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `apikey=${encodeURIComponent(apikey)}`,
    signal: AbortSignal.timeout(timeoutMs),
  };

  let newErr;
  try {
    const res = await doFetch(TOKEN_URL, form);
    const token = res.ok ? parseTokenBody(await res.text()) : '';
    if (token) return token;
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error(`RaceResult authentication failed (HTTP ${res.status})`), { status: res.status, final: true });
    }
    newErr = Object.assign(new Error(`RaceResult token endpoint ${res.ok ? 'returned no token' : `failed (HTTP ${res.status})`}`), { status: res.status });
  } catch (err) {
    if (err && err.final) throw err;
    newErr = err;
  }

  // Legacy endpoint, until 31 Dec 2026.
  const res = await doFetch(LEGACY_LOGIN_URL, form);
  const token = res.ok ? parseTokenBody(await res.text()) : '';
  if (token) return token;
  if (!res.ok) {
    throw Object.assign(new Error(`RaceResult authentication failed (HTTP ${res.status})`), { status: res.status, cause: newErr });
  }
  throw Object.assign(new Error('RaceResult login returned an empty token'), { status: res.status, cause: newErr });
}

module.exports = { rrLogin, parseTokenBody, TOKEN_URL, LEGACY_LOGIN_URL };
