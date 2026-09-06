/**
 * Provision the RaceResult splits feed for a V2 race.
 *
 * What it does, in the timer's own RaceResult event file:
 *   1. enumerate every split across every contest   (splits/get, per contest)
 *   2. generate a list body covering exactly those  (listTemplate.js)
 *   3. write it as a named list                     (lists/new + lists/save)
 *   4. verify by rendering the list through the Org API and parsing it
 *   5. store list name + render url + splits hash on v2.races
 *
 * No Simple API key any more: the worker renders the list per contest with the
 * organisation's own token (Org API has no per-IP rate limit; the Simple API is
 * capped at one call per second per IP).
 *
 * Idempotent: the list is matched by name, and re-running replaces its body.
 * That is also how a split change is applied — regenerate and save again.
 *
 * Steps 3 and 4 are gated by RR_ALLOW_WRITES (see orgApi.js). With writes off,
 * or with { dryRun: true }, everything up to step 2 runs and the generated
 * template plus the coverage check are returned without touching RaceResult.
 */

const pool = require('../../config/database');
const rr = require('./orgApi');
const { buildListData, buildColumnFields, coverageGaps } = require('./listTemplate');

/**
 * The list we own in the customer's event file. Matched by name.
 *
 * RaceResult namespaces lists as "Category|Name" (a real event file has
 * "07-API|Individual Splits", "02-Results|Results", …), so ours goes in an API
 * category rather than sitting loose at the top level.
 */
const LIST_NAME = 'evento|full-results';
/** Label shown in RaceResult's Simple API screen. */
const SIMPLE_API_LABEL = 'evento full-results feed';

/**
 * How a Simple API key points at a list.
 * Note the parameter is `listname`, not `name` (which is what lists/get uses).
 *
 * format matters: format=JSON renders per COLUMN — one record per athlete,
 * keys from field Labels, values from evaluated Expressions. That is what the
 * column-form list (listTemplate.buildColumnFields) is built for: bib, id,
 * and one `splits` expression whose value is the athlete's nested splits
 * array as a JSON string. Identity appears once per athlete instead of on
 * every split record (the old whole-body template repeated it, and only
 * rendered under format=text — confirmed live on event 416647).
 */
const simpleApiListUrl = (listName) =>
  `lists/create?listname=${encodeURIComponent(listName)}&format=JSON`;

/**
 * Resolve a v2 race to the RaceResult event and the organisation whose API key
 * can write to it.
 *
 * v2.organisations carries its own rr_apikey; older orgs only have one on the
 * v1 public.organisations row, reachable via v1_org_id.
 */
async function resolveRace(v2RaceId) {
  const { rows } = await pool.query(
    `SELECT r.id,
            r.name,
            r.rr_raceid,
            r.organisation_id      AS v2_org_id,
            o.v1_org_id,
            o.rr_apikey            AS v2_org_key
       FROM v2.races r
       LEFT JOIN v2.organisations o ON o.id = r.organisation_id
      WHERE r.id = $1`,
    [v2RaceId]
  );
  if (!rows.length) throw new Error(`v2 race ${v2RaceId} not found`);

  const race = rows[0];
  if (!race.rr_raceid) {
    throw new Error(`v2 race ${v2RaceId} has no RaceResult event id (rr_raceid)`);
  }
  return race;
}

/**
 * Bearer token for the race's organisation.
 *
 * Prefers the key on v2.organisations, falling back to the v1 organisations
 * row. Both are stored the way the ColdFusion CMS writes them —
 * Encrypt(key, seed, "cfmx_compat", "hex") — so both go through the same
 * decrypt; a value that is not hex is treated as already plain.
 */
async function tokenForRace(race) {
  if (race.v2_org_key) return loginWithKey(await apiKeyForRace(race));
  if (race.v1_org_id) return rr.tokenForOrg(race.v1_org_id);
  throw new Error(`No RaceResult API key for the organisation behind race ${race.id}`);
}

/**
 * The plain RaceResult API key of the organisation behind a resolved race —
 * v2.organisations first, then the v1 organisations row. This is the
 * tenant's own credential, and it doubles as the CMS's proof of tenancy when
 * it calls /v2/raceresult/* (see routes/v2/raceresult.js).
 */
async function apiKeyForRace(race) {
  if (race.v2_org_key) {
    const { cfmxDecryptHex } = require('./cfmx');
    const stored = String(race.v2_org_key).trim();
    return /^[0-9a-fA-F]+$/.test(stored) && stored.length % 2 === 0
      ? cfmxDecryptHex(stored, process.env.RR_ENCRYPTION_KEY || 'evento_rr_2024')
      : stored;
  }
  if (race.v1_org_id) return rr.apiKeyForOrg(race.v1_org_id);
  throw new Error(`No RaceResult API key for the organisation behind race ${race.id}`);
}

async function loginWithKey(apikey) {
  const res = await fetch('https://events.raceresult.com/api/public/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `apikey=${encodeURIComponent(apikey)}`,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`RaceResult login failed (HTTP ${res.status})`);
  const text = (await res.text()).trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const token = JSON.parse(text).Token;
      if (token) return token;
    } catch { /* fall through */ }
  }
  if (!text) throw new Error('RaceResult login returned an empty token');
  return text;
}

/**
 * The list definition we save.
 *
 * `base` is the list RaceResult itself created for us (lists/new followed by
 * lists/get), so every one of its ~70 layout properties is already present and
 * valid; we only replace what we own. Hand-building the struct risks tripping
 * over a required property we never modelled.
 */
function listDefinition(base, fields) {
  const fieldBase = (base.Fields && base.Fields[0]) ? base.Fields[0] : {};
  return {
    ...base,
    ListName: LIST_NAME,
    // Column form: one field per output key (Label → JSON key under
    // format=JSON). The `splits` field's expression builds the athlete's
    // nested splits array, so identity appears once per athlete.
    Fields: fields.map((f) => ({
      ...fieldBase,
      Expression: f.Expression,
      Label: f.Label,
      Line: 1,
    })),
    // Only entrants attached to a contest can have splits.
    Filters: [{ OrConjunction: false, Expression1: 'Contest', Operator: '>', Expression2: '0' }],
    Orders: [],
    Remarks: 'Generated by Evento — do not edit. Regenerated when splits change.',
  };
}

/**
 * @param {number}  v2RaceId
 * @param {Object}  [opts]
 * @param {boolean} [opts.dryRun]  generate and check, write nothing
 * @param {boolean} [opts.pushMessages=true]
 */
async function provisionRace(v2RaceId, opts = {}) {
  const { dryRun = false, pushMessages = true } = opts;
  const race = await resolveRace(v2RaceId);
  const rrEventId = race.rr_raceid;

  const token = await tokenForRace(race);

  // --- enumerate ---------------------------------------------------------
  const contests = await rr.getContests(token, rrEventId);
  const splits = await rr.getAllSplits(token, rrEventId);
  if (!splits.length) {
    throw new Error(`RaceResult event ${rrEventId} has no splits configured yet`);
  }

  // --- generate ----------------------------------------------------------
  const { fields, names, hash } = buildColumnFields(splits);
  const blocks = names.length;
  const data = fields.map((f) => f.Expression).join('\n');

  // --- coverage cross-check ----------------------------------------------
  // The public results config is an independent view of the event's splits, so
  // a timing point our enumeration missed shows up here rather than on race day.
  let coverage = { checked: false, gaps: [] };
  try {
    const publicCfg = await rr.getPublicConfig(rrEventId);
    coverage = {
      checked: true,
      gaps: coverageGaps(names, publicCfg.splits || []).map((g) => g.name),
    };
  } catch (err) {
    coverage = { checked: false, gaps: [], error: err.message };
  }

  const summary = {
    raceId: race.id,
    rrEventId,
    contests: contests.length,
    splitRows: splits.length,
    blocks,
    names,
    hash,
    templateBytes: data.length,
    coverage,
    listName: LIST_NAME,
  };

  if (dryRun || !rr.writesAllowed()) {
    return { ...summary, written: false, reason: dryRun ? 'dryRun' : 'RR_ALLOW_WRITES not set' };
  }

  // --- write the list ----------------------------------------------------
  const existing = await rr.getLists(token, rrEventId).catch(() => []);
  const listExists = Array.isArray(existing) && existing.includes(LIST_NAME);
  if (!listExists) await rr.createList(token, rrEventId, LIST_NAME);
  // Read it back so the saved object keeps every layout property RaceResult
  // expects, and we only overwrite the parts we own.
  const base = await rr.getList(token, rrEventId, LIST_NAME);
  await rr.saveList(token, rrEventId, listDefinition(base, fields));

  // --- verify -------------------------------------------------------------
  // Render through the Org API with the same token. The stored URL is the
  // whole-event render (bearer required); the worker pulls per contest from
  // rr_list_name, rr_splits_url just marks the race as provisioned.
  const url = rr.renderListUrl(rrEventId, LIST_NAME);
  const verification = await verifyFeed(url, token);

  await pool.query(
    `UPDATE v2.races
        SET rr_splits_url    = $2,
            rr_list_name     = $3,
            rr_splits_hash   = $4,
            provisioned_at   = now()
      WHERE id = $1`,
    [race.id, url, LIST_NAME, hash]
  );

  return { ...summary, written: true, url, verification };
}

/**
 * Fetch the provisioned feed once and confirm it parses.
 *
 * This is also what catches a missing user-defined function: if the event file
 * has no PushMessage()/CorrectSpelling(), the expression renders as an error
 * string and the payload fails to parse here — at provision time, with the
 * timer still reachable, instead of silently on race day.
 */
/**
 * Parse the rendered column-form feed.
 *
 * format=JSON returns one array of {bib, id, splits} — one record per
 * athlete, where `splits` is the athlete's nested splits array as a JSON
 * string (opened by the {"s":1} sentinel so every real element carries a
 * leading comma). Returns [{ bib, id, splits: [...] }] with the sentinel
 * dropped; a splits string that fails to parse throws so the caller reports
 * a broken feed rather than silently serving partial data.
 */
/**
 * The per-athlete `splits` column is a JSON array rendered by RaceResult
 * expressions. For contests with no timing data yet RR has been seen to emit
 * a mangled sentinel — `[{"_":1}]`, `[{"s":1}_` — so parse strictly first and
 * fall back to scanning out each top-level {...} object and parsing those
 * individually. Anything without an rr_id (sentinels, garbage) is dropped.
 */
function parseSplitsColumn(str) {
  const text = String(str || '').trim();
  if (!text) return [];
  try {
    const arr = JSON.parse(text);
    if (Array.isArray(arr)) return arr.filter((s) => s && typeof s === 'object' && s.rr_id != null);
  } catch { /* fall through to the tolerant scan */ }
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth++ === 0) start = i; }
    else if (ch === '}') {
      if (--depth === 0 && start >= 0) {
        try { const o = JSON.parse(text.slice(start, i + 1)); if (o && o.rr_id != null) out.push(o); } catch { /* skip */ }
        start = -1;
      }
    }
  }
  return out;
}

function parseFeedBody(body) {
  const rows = JSON.parse(body);
  if (!Array.isArray(rows)) throw new Error('feed did not return a JSON array');
  const athletes = [];
  for (const row of rows) {
    if (!row || row.id == null || row.id === '') continue;
    const raw = String(row.splits || '');
    const splits = parseSplitsColumn(raw);
    // Non-activated participants come back masked with underscores → unreadable.
    athletes.push({ bib: row.bib, id: row.id, splits, ...(splits.length === 0 && raw.length > 24 ? { corrupt: true } : {}) });
  }
  return athletes;
}

async function verifyFeed(url, token) {
  try {
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(300000),
    });
    const body = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: body.slice(0, 200) };
    let athletes;
    try {
      athletes = parseFeedBody(body);
    } catch (err) {
      return { ok: false, status: res.status, error: `feed is not valid JSON: ${err.message}`, sample: body.slice(0, 200) };
    }
    // Athletes with no id are dropped by the parser, so an entrant-free event
    // still verifies.
    return {
      ok: true,
      status: res.status,
      records: athletes.reduce((n, a) => n + a.splits.length, 0),
      athletes: athletes.length,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Has the event's split configuration changed since we generated the list?
 * Cheap enough to run before every live window opens.
 */
async function splitsChanged(v2RaceId) {
  const race = await resolveRace(v2RaceId);
  const token = await tokenForRace(race);
  const splits = await rr.getAllSplits(token, race.rr_raceid);
  const { hash } = buildListData(splits);
  const { rows } = await pool.query(
    'SELECT rr_splits_hash FROM v2.races WHERE id = $1',
    [v2RaceId]
  );
  const stored = rows[0]?.rr_splits_hash || null;
  return { changed: stored !== hash, stored, current: hash };
}

module.exports = {
  provisionRace,
  apiKeyForRace,
  tokenForRace,
  splitsChanged,
  resolveRace,
  verifyFeed,
  parseFeedBody,
  LIST_NAME,
  SIMPLE_API_LABEL,
};
