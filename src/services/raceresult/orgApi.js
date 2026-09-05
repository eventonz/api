/**
 * RaceResult Organisation API client.
 *
 * Endpoint names follow RaceResult's own Go client (github.com/raceresult/go-webapi):
 *   login        POST /api/public/login
 *   contests     GET  /_{event}/api/contests/get
 *   splits       GET  /_{event}/api/splits/get?contest=
 *   lists        GET  /_{event}/api/lists/names|get, POST .../lists/save
 *   simple api   GET  /_{event}/api/simpleapi/get, POST .../simpleapi/save
 *
 * SAFETY: every call that mutates a customer's RaceResult event file goes
 * through assertWritesAllowed(). Writes are OFF unless RR_ALLOW_WRITES=1, so a
 * stray call or a test can't create a list or an API key in a live event file.
 */

const crypto = require('crypto');
const pool = require('../../config/database');
const redis = require('../../config/redis');
const { cfmxDecryptHex } = require('./cfmx');

const RR_BASE = 'https://events.raceresult.com';
const RR_ENCRYPTION_KEY = process.env.RR_ENCRYPTION_KEY || 'evento_rr_2024';
const TIMEOUT_MS = 20000;

// Tokens are short-lived; cache well inside their lifetime.
const TOKEN_TTL = 600;
const tokenKey = (orgId) => `rr:token:${orgId}`;

function writesAllowed() {
  return process.env.RR_ALLOW_WRITES === '1';
}

function assertWritesAllowed(what) {
  if (!writesAllowed()) {
    throw new Error(
      `RaceResult writes are disabled (${what}). Set RR_ALLOW_WRITES=1 to enable.`
    );
  }
}

async function rrFetch(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`RaceResult ${opts.method || 'GET'} ${url} failed (HTTP ${res.status}) ${body}`);
  }
  return res;
}

/** The organisation's decrypted RaceResult API key. */
async function apiKeyForOrg(orgId) {
  const { rows } = await pool.query(
    "SELECT rr_apikey FROM organisations WHERE id = $1 AND rr_apikey IS NOT NULL AND rr_apikey <> ''",
    [orgId]
  );
  if (!rows.length) {
    throw new Error(`Organisation ${orgId} has no RaceResult API key configured`);
  }
  return cfmxDecryptHex(rows[0].rr_apikey, RR_ENCRYPTION_KEY);
}

/** Bearer token for an organisation, cached in Redis. */
async function tokenForOrg(orgId) {
  const cached = await redis.get(tokenKey(orgId)).catch(() => null);
  if (cached) return cached;

  const apikey = await apiKeyForOrg(orgId);
  const res = await rrFetch(`${RR_BASE}/api/public/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `apikey=${encodeURIComponent(apikey)}`,
  });
  const text = (await res.text()).trim();
  let token = text;
  if (text.startsWith('{') || text.startsWith('[')) {
    try { token = JSON.parse(text).Token || ''; } catch { /* fall through */ }
  }
  if (!token) throw new Error('RaceResult login returned an empty token');

  await redis.setex(tokenKey(orgId), TOKEN_TTL, token).catch(() => {});
  return token;
}

const eventBase = (rrEventId) => `${RR_BASE}/_${rrEventId}/api`;
const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function getJson(token, url) {
  const res = await rrFetch(url, { headers: auth(token) });
  return res.json();
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function getContests(token, rrEventId) {
  const json = await getJson(token, `${eventBase(rrEventId)}/contests/get?lang=en`);
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.data)) return json.data;
  throw new Error('Unexpected contests response from RaceResult');
}

/** Splits for one contest. `splits/get` is contest-scoped. */
async function getSplits(token, rrEventId, contestId) {
  const json = await getJson(
    token,
    `${eventBase(rrEventId)}/splits/get?lang=en&Contest=${encodeURIComponent(contestId)}`
  );
  const list = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : null;
  if (!list) throw new Error('Unexpected splits response from RaceResult');
  return list;
}

/**
 * Every split across every contest, tagged with its contest.
 *
 * This is the enumeration the generated list depends on: a timing point that
 * only exists on one contest still needs a block, and multi-contest events
 * repeat names (376606: 67 rows, 18 distinct names).
 */
async function getAllSplits(token, rrEventId) {
  const contests = await getContests(token, rrEventId);
  const all = [];
  for (const contest of contests) {
    const id = contest.ID ?? contest.id;
    if (id == null) continue;
    const splits = await getSplits(token, rrEventId, id);
    for (const s of splits) all.push({ ...s, Contest: s.Contest ?? id });
  }
  return all;
}

async function getLists(token, rrEventId) {
  return getJson(token, `${eventBase(rrEventId)}/lists/names`);
}

async function getList(token, rrEventId, name) {
  return getJson(
    token,
    `${eventBase(rrEventId)}/lists/get?name=${encodeURIComponent(name)}&lang=en`
  );
}

async function getSimpleApi(token, rrEventId) {
  return getJson(token, `${eventBase(rrEventId)}/simpleapi/get`);
}

/**
 * Public results config for an event — no auth, no org key.
 * Used as the independent source for the coverage cross-check at provision time.
 */
async function getPublicConfig(rrEventId, lang = 'en') {
  const res = await rrFetch(
    `https://my.raceresult.com/${rrEventId}/results/config?lang=${encodeURIComponent(lang)}`
  );
  return res.json();
}

// ---------------------------------------------------------------------------
// Writes — gated
// ---------------------------------------------------------------------------

async function createList(token, rrEventId, name) {
  assertWritesAllowed('lists/new');
  await rrFetch(
    `${eventBase(rrEventId)}/lists/new?name=${encodeURIComponent(name)}`,
    { headers: auth(token) }
  );
}

async function saveList(token, rrEventId, list) {
  assertWritesAllowed('lists/save');
  await rrFetch(`${eventBase(rrEventId)}/lists/save`, {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(list),
  });
}

async function saveSimpleApi(token, rrEventId, items) {
  assertWritesAllowed('simpleapi/save');
  await rrFetch(`${eventBase(rrEventId)}/simpleapi/save`, {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(items),
  });
}

async function deleteSimpleApi(token, rrEventId, key) {
  assertWritesAllowed('simpleapi/delete');
  await rrFetch(
    `${eventBase(rrEventId)}/simpleapi/delete?key=${encodeURIComponent(key)}`,
    { headers: auth(token) }
  );
}

/** A Simple API key we mint ourselves, so the feed URL is known before saving. */
function mintSimpleApiKey() {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

const simpleApiUrl = (rrEventId, key) => `https://api.raceresult.com/${rrEventId}/${key}`;

/**
 * Render a saved list as JSON through the Org API (bearer token), optionally
 * for one contest. Same output as a Simple API key pointing at the list, but
 * without the Simple API's one-call-per-second-per-IP limit and without
 * writing a key into the customer's event file.
 */
function renderListUrl(rrEventId, listName, contestId) {
  const q = `listname=${encodeURIComponent(listName)}&format=JSON`;
  return `${eventBase(rrEventId)}/lists/create?${q}${contestId != null ? `&contest=${encodeURIComponent(contestId)}` : ''}`;
}

/** Raw body of a rendered list (large: a whole-event render can be 20 MB+). */
async function renderList(token, rrEventId, listName, contestId) {
  const res = await fetch(renderListUrl(rrEventId, listName, contestId), {
    headers: auth(token), signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) throw new Error(`RaceResult list render failed (HTTP ${res.status})`);
  return res.text();
}

module.exports = {
  writesAllowed,
  apiKeyForOrg,
  tokenForOrg,
  getContests,
  getSplits,
  getAllSplits,
  getLists,
  getList,
  getSimpleApi,
  getPublicConfig,
  createList,
  saveList,
  saveSimpleApi,
  deleteSimpleApi,
  mintSimpleApiKey,
  simpleApiUrl,
  renderListUrl,
  renderList,
};
