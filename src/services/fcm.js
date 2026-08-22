/**
 * Firebase Cloud Messaging (firebase-admin) — one shared Firebase project for
 * the V2 apps (evento-7ec10); every store bundle id is an "app" inside it.
 *
 * Credentials: FIREBASE_SERVICE_ACCOUNT = path to the service-account JSON
 * (default config/firebase-service-account.json, gitignored) or the JSON
 * itself base64-encoded in FIREBASE_SERVICE_ACCOUNT_B64.
 *
 * Delivery is by TOPIC (docs: MOBILE-V2/PUSH-PLAN.md): one send() call per
 * message, FCM fans out. subscribe/unsubscribe are idempotent.
 */
const path = require('path');
const fs   = require('fs');

let msg = null;
let initError = null;

function loadCredential() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (b64) return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  const file = process.env.FIREBASE_SERVICE_ACCOUNT
    || path.join(__dirname, '..', '..', 'config', 'firebase-service-account.json');
  if (!fs.existsSync(file)) throw new Error(`Firebase service account not found: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function messaging() {
  if (msg) return msg;
  if (initError) throw initError;
  try {
    const { getApps, initializeApp, cert } = require('firebase-admin/app');
    const { getMessaging } = require('firebase-admin/messaging');
    const app = getApps()[0] || initializeApp({ credential: cert(loadCredential()) });
    msg = getMessaging(app);
    return msg;
  } catch (err) {
    initError = err;
    throw err;
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
async function subscribe(tokens, topic) {
  if (!tokens.length || process.env.PUSH_DRY_RUN === '1') return;
  for (let i = 0; i < tokens.length; i += 1000) {
    await messaging().subscribeToTopic(tokens.slice(i, i + 1000), topic);
  }
}
async function unsubscribe(tokens, topic) {
  if (!tokens.length || process.env.PUSH_DRY_RUN === '1') return;
  for (let i = 0; i < tokens.length; i += 1000) {
    await messaging().unsubscribeFromTopic(tokens.slice(i, i + 1000), topic);
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

/** Send to a topic → FCM message id. PUSH_DRY_RUN=1 skips FCM (local dev, no service account). */
async function sendToTopic(topic, payload) {
  if (process.env.PUSH_DRY_RUN === '1') return `dry-run:${topic}`;
  return messaging().send(buildMessage({ ...payload, topic }));
}

/** Send to explicit tokens (≤500 per call) → { successCount, failureCount, invalid[] }. */
async function sendToTokens(tokens, payload) {
  let successCount = 0, failureCount = 0;
  const invalid = [], errors = [];
  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);
    const res = await messaging().sendEach(batch.map((token) => buildMessage({ ...payload, token })));
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
                   LANGS, normLang, langTopic, stripLang, LANG_SUFFIX_RE, resolveText };
