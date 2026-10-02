/**
 * Firebase Cloud Messaging (firebase-admin) — ONE FIREBASE PROJECT PER APP.
 *
 * Every send / subscribe names the app it is for. An app with its own service
 * account (v2.app_push_credentials, uploaded in the CMS — see
 * pushCredentials.js) goes through that app's Firebase project; an app without
 * one goes through the shared default project (evento-7ec10):
 * FIREBASE_SERVICE_ACCOUNT = path to the service-account JSON (default
 * config/firebase-service-account.json, gitignored) or the JSON itself
 * base64-encoded in FIREBASE_SERVICE_ACCOUNT_B64.
 *
 * FCM tokens and topics are scoped to a project, so an event/athlete topic
 * followed from several apps is sent once per project — distinctProjects().
 *
 * Delivery is by TOPIC (docs: MOBILE-V2/PUSH-PLAN.md): one send() call per
 * message, FCM fans out. subscribe/unsubscribe are idempotent.
 *
 * evento-worker carries a copy of this file (src/lib/fcm.js) — keep in step.
 */
const path = require('path');
const fs   = require('fs');
const creds = require('./pushCredentials');

const DEFAULT_KEY = 'default';
const clients = new Map(); // project key → firebase-admin Messaging

function loadDefaultCredential() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (b64) return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  const file = process.env.FIREBASE_SERVICE_ACCOUNT
    || path.join(__dirname, '..', '..', 'config', 'firebase-service-account.json');
  if (!fs.existsSync(file)) throw new Error(`Firebase service account not found: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Key naming the Firebase project (and key version) an app sends through. */
function keyOf(own) {
  return own ? `${own.projectId}:${own.credential.private_key_id || ''}` : DEFAULT_KEY;
}

/** Which project an app sends through → 'default' or '{projectId}:{keyId}'. */
async function projectKey(appId) {
  return keyOf(await creds.forApp(appId));
}

/** firebase-admin Messaging for the app's project (one named admin app per project key). */
async function messaging(appId) {
  const own = await creds.forApp(appId);
  const key = keyOf(own);
  if (clients.has(key)) return clients.get(key);
  const { getApps, initializeApp, cert } = require('firebase-admin/app');
  const { getMessaging } = require('firebase-admin/messaging');
  const name = `evento-${key}`;
  const app = getApps().find((a) => a.name === name)
    || initializeApp({ credential: cert(own ? own.credential : loadDefaultCredential()) }, name);
  const m = getMessaging(app);
  clients.set(key, m);
  return m;
}

/**
 * Reduce app ids to one per distinct Firebase project — a topic send goes out
 * once per project, not once per app. null/undefined = the default project.
 */
async function distinctProjects(appIds) {
  const seen = new Map();
  for (const id of appIds) {
    const key = await projectKey(id);
    if (!seen.has(key)) seen.set(key, id ?? null);
  }
  return [...seen.values()];
}

/**
 * CMS health check: can this server send through the app's project?
 * A dry-run send validates the key and that the FCM API is enabled without
 * delivering anything.
 */
async function check(appId) {
  let own = null;
  try {
    own = await creds.forApp(appId);
    const m = await messaging(appId);
    await m.send({ topic: `app-${appId}-en`, notification: { title: 'check' } }, true);
    return { ok: true, own: !!own, project_id: own ? own.projectId : (loadDefaultCredential().project_id || null) };
  } catch (err) {
    return { ok: false, own: !!own, project_id: own ? own.projectId : null, error: err.message };
  }
}

const TOPIC_RE = /^[a-zA-Z0-9-_.~%]{1,900}$/;
const validTopic = (t) => typeof t === 'string' && TOPIC_RE.test(t);

/**
 * Languages (contract v11 LocalizedText: en | es | de | fr, en required).
 * Every device subscribes to `{topic}-{lang}`; a send fans out one FCM call
 * per language, untranslated languages receiving the English copy.
 */
const LANGS = ['en', 'es', 'de', 'fr'];
const normLang = (l) => (LANGS.includes(String(l || '').toLowerCase()) ? String(l).toLowerCase() : 'en');
const langTopic = (topic, lang) => `${topic}-${normLang(lang)}`;
const LANG_SUFFIX_RE = /-(en|es|de|fr)$/;
const stripLang = (topic) => topic.replace(LANG_SUFFIX_RE, '');
/** Plain string or {en,…} map → text for `lang` (falls back to en, then any). */
function resolveText(v, lang = 'en') {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    for (const k of [lang, 'en', ...LANGS]) if (typeof v[k] === 'string' && v[k]) return v[k];
  }
  return '';
}

/** Batches of ≤1000 tokens per FCM call. */
async function subscribe(tokens, topic, appId) {
  if (!tokens.length || process.env.PUSH_DRY_RUN === '1') return;
  const m = await messaging(appId);
  for (let i = 0; i < tokens.length; i += 1000) {
    await m.subscribeToTopic(tokens.slice(i, i + 1000), topic);
  }
}
async function unsubscribe(tokens, topic, appId) {
  if (!tokens.length || process.env.PUSH_DRY_RUN === '1') return;
  const m = await messaging(appId);
  for (let i = 0; i < tokens.length; i += 1000) {
    await m.unsubscribeFromTopic(tokens.slice(i, i + 1000), topic);
  }
}

/**
 * Build one FCM message. `data` values must be strings. `category` selects the
 * app's interactive actions (ATHLETE: Track/Mute · EVENT: Open/Stop).
 */
function buildMessage({ topic, token, title, body, image, data = {}, category }) {
  const strData = {};
  for (const [k, v] of Object.entries(data)) if (v != null) strData[k] = String(v);
  const msg = {
    notification: { title, body: body || undefined, imageUrl: image || undefined },
    data: strData,
    apns: {
      payload: { aps: { sound: 'default', category: category || undefined, 'mutable-content': image ? 1 : undefined } },
      fcmOptions: image ? { imageUrl: image } : undefined,
    },
    android: { priority: 'high', notification: { imageUrl: image || undefined, clickAction: category || undefined } },
  };
  if (topic) msg.topic = topic; else msg.token = token;
  return msg;
}

/**
 * Send to a topic in the app's Firebase project → FCM message id.
 * PUSH_DRY_RUN=1 skips FCM (local dev, no service account).
 */
async function sendToTopic(topic, payload, appId) {
  if (process.env.PUSH_DRY_RUN === '1') return `dry-run:${topic}`;
  return (await messaging(appId)).send(buildMessage({ ...payload, topic }));
}

/** Send to explicit tokens of ONE app (≤500 per call) → { successCount, failureCount, invalid[] }. */
async function sendToTokens(tokens, payload, appId) {
  let successCount = 0, failureCount = 0;
  const invalid = [], errors = [];
  const m = await messaging(appId);
  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);
    const res = await m.sendEach(batch.map((token) => buildMessage({ ...payload, token })));
    successCount += res.successCount;
    failureCount += res.failureCount;
    res.responses.forEach((r, j) => {
      const code = r.error && r.error.code;
      if (r.error) errors.push(`${code}: ${r.error.message}`);
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        invalid.push(batch[j]);
      }
    });
  }
  return { successCount, failureCount, invalid, errors };
}

module.exports = { subscribe, unsubscribe, sendToTopic, sendToTokens, validTopic, messaging,
                   projectKey, distinctProjects, check,
                   LANGS, normLang, langTopic, stripLang, LANG_SUFFIX_RE, resolveText };
