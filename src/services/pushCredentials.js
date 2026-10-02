/**
 * Per-app Firebase service accounts (v2.app_push_credentials, migration 041;
 * uploaded on the CMS app Settings page). An app with a row sends through its
 * OWN Firebase project; an app without one uses the shared default project.
 *
 * `credentials` is the service-account JSON — "enc:v1:{iv}:{tag}:{data}"
 * (AES-256-GCM, key = sha256(PUSH_CREDENTIALS_KEY)) when the CMS encrypted it,
 * plain JSON otherwise.
 *
 * evento-worker carries a copy of this file (src/lib/pushCredentials.js) —
 * keep the two in step; only the pool require differs.
 */
const crypto = require('crypto');
const pool = require('../config/database');

const TTL_MS = 60 * 1000;
const cache = new Map(); // String(appId) → { at, value }

function decrypt(stored) {
  if (!stored.startsWith('enc:v1:')) return stored;
  const secret = process.env.PUSH_CREDENTIALS_KEY;
  if (!secret) throw new Error('PUSH_CREDENTIALS_KEY is not set on this server — cannot read the app\'s push credentials');
  const [iv, tag, data] = stored.slice('enc:v1:'.length).split(':').map((s) => Buffer.from(s, 'base64'));
  const key = crypto.createHash('sha256').update(secret).digest();
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

/**
 * → { projectId, credential } for the app's own Firebase project, or null when
 * the app has none (caller falls back to the shared default). Cached 60 s, so
 * a key uploaded in the CMS is live within a minute without a restart.
 */
async function forApp(appId) {
  if (appId == null || appId === '') return null;
  const k = String(appId);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value = null;
  try {
    const { rows } = await pool.query(
      'SELECT project_id, credentials FROM v2.app_push_credentials WHERE app_id = $1', [k]
    );
    if (rows[0]) value = { projectId: rows[0].project_id, credential: JSON.parse(decrypt(rows[0].credentials)) };
  } catch (err) {
    if (err.code !== '42P01') throw err;   // table missing = migration 041 not applied yet → default project
  }
  cache.set(k, { at: Date.now(), value });
  return value;
}

module.exports = { forApp, decrypt, _cache: cache };
