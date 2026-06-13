/**
 * RRPublish pass-through proxy client (docs/rr_proxy_implementation_plan.md).
 *
 * Dumb pipe to my.raceresult.com / the event's resolved data server, with:
 *   - Redis response caching (TTL by content type)
 *   - last-good config snapshots served on upstream failure
 *   - ONE mutation: config responses get their `server` field rewritten to
 *     point back at this proxy, so the app's interpolated follow-on calls
 *     (list / splits / per-athlete config) land here automatically
 *   - optional CMS display overrides (rr_display_config) merged into config
 *     responses — skipped entirely when no override row exists
 *
 * Everything else is returned byte-for-byte. The app's current parsing is
 * the contract.
 */

const crypto = require('crypto');
const redis  = require('../../config/redis');
const pool   = require('../../config/database');

const DEFAULT_HOST     = 'my.raceresult.com';
// Host+path prefix (no scheme) — the app builds `https://{server}/{rrId}/...`
const PROXY_SERVER     = process.env.RR_PROXY_SERVER || 'eventoapi.com/v1/rrpublish';
const USER_AGENT       = 'Evento-Proxy/1.0';
const FETCH_TIMEOUT_MS = 10_000;

const TTL = {
  config:   60,
  list:     15,
  liveList: 10,
  athlete:  30, // pid= present (per-athlete config / splits / data)
  lastGood: 7 * 24 * 3600,
  server:   24 * 3600,
  override: 60,
};

const keyRsp      = (rrId, raw) => `rrpublish:rsp:${rrId}:${crypto.createHash('sha1').update(raw).digest('hex')}`;
const keyServer   = (rrId)      => `rrpublish:server:${rrId}`;
const keyLastGood = (rrId, pg)  => `rrpublish:lastgood:${rrId}:${pg}`;
const keyOverride = (rrId)      => `rrpublish:overrides:${rrId}`;
const keyObserve  = (rrId)      => `observe:rrproxy:${rrId}`;

function observe(rrId, field) {
  redis.hincrby(keyObserve(rrId), field, 1)
    .then(() => redis.expire(keyObserve(rrId), TTL.lastGood))
    .catch(() => {});
}

/** Path (no query) of a RRPublish config request — legacy or modern. */
function isConfigPath(path) {
  return path === 'RRPublish/data/config' || path.endsWith('/config');
}

/** Which page a config request belongs to, for the last-good snapshot key. */
function configPage(path, query) {
  const m = /(?:^|&)page=([^&]*)/.exec(query);
  if (m) return m[1] || 'results';                 // legacy ?page=results|participants|live
  return path.replace(/\/config$/, '') || 'results'; // modern results/config, participants/config
}

function cacheTtl(path, query) {
  if (isConfigPath(path)) {
    // pid= on a config path is the per-athlete SplitConfig call
    return /(?:^|&)pid=/.test(query) ? TTL.athlete : TTL.config;
  }
  if (/(?:^|&)pid=/.test(query)) return TTL.athlete;
  if (path.endsWith('/list')) {
    return /(?:^|&)page=live(?:&|$)/.test(query) ? TTL.liveList : TTL.list;
  }
  return TTL.list;
}

async function fetchWithTimeout(url, headers) {
  const doFetch = () => fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  try {
    return await doFetch();
  } catch (_) {
    return doFetch(); // one retry
  }
}

/**
 * Load CMS display overrides for an event, Redis-cached 60 s.
 * Returns the parsed overrides object or null when none configured.
 */
async function getOverrides(rrId) {
  const cached = await redis.get(keyOverride(rrId)).catch(() => null);
  if (cached === 'none') return null;
  if (cached) {
    try { return JSON.parse(cached); } catch (_) { /* fall through */ }
  }
  let overrides = null;
  try {
    const { rows } = await pool.query(
      `SELECT d.overrides
       FROM rr_display_config d
       JOIN races r ON r.id = d.race_id
       WHERE r.rr_eventid = $1
       ORDER BY d.updated_at DESC
       LIMIT 1`,
      [rrId]
    );
    if (rows.length > 0 && rows[0].overrides && Object.keys(rows[0].overrides).length > 0) {
      overrides = rows[0].overrides;
    }
  } catch (err) {
    // Table may not exist yet, or DB hiccup — overrides are best-effort
    console.error('[rrpublish] override lookup failed:', err.message);
    return null;
  }
  await redis.setex(keyOverride(rrId), TTL.override, overrides ? JSON.stringify(overrides) : 'none')
    .catch(() => {});
  return overrides;
}

/**
 * Apply v1 display overrides to every list array found in a config payload
 * (legacy `lists`, modern `TabConfig.Lists`). Fail-soft: override keys that
 * match no list in the live config are ignored and logged.
 */
function applyOverrides(rrId, config, overrides) {
  if (!overrides || overrides.v !== 1 || !overrides.lists) return;
  const listArrays = [];
  if (Array.isArray(config.lists)) listArrays.push(config.lists);
  if (Array.isArray(config.TabConfig?.Lists)) listArrays.push(config.TabConfig.Lists);
  if (listArrays.length === 0) return;

  const matched = new Set();
  for (const lists of listArrays) {
    for (const list of lists) {
      const o = overrides.lists[list?.Name];
      if (!o) continue;
      matched.add(list.Name);
      // Visibility is bidirectional (the app shows a list iff Mode is empty):
      //   hidden:true → force-hide a normally-visible list
      //   show:true   → reveal a list RaceResult marked hidden
      if (o.hidden) list.Mode = 'hidden';
      else if (o.show) list.Mode = '';
      if (o.label)  list.ShowAs = o.label;       // app prefers ShowAs over Name
      const evento = {};
      for (const k of ['layout', 'line2', 'showFields', 'hideFields']) {
        if (o[k] != null) evento[k] = o[k];
      }
      if (Object.keys(evento).length > 0) list._evento = { v: 1, ...evento };
    }
  }
  for (const name of Object.keys(overrides.lists)) {
    if (!matched.has(name)) {
      observe(rrId, 'override_unmatched');
      console.warn(`[rrpublish] override key "${name}" matched no list for event ${rrId}`);
    }
  }
}

/**
 * Proxy one GET. `rawPathAndQuery` is everything after /v1/rrpublish/{rrId}/.
 * Returns { status, contentType, body, cache: 'HIT'|'MISS', stale?: true }.
 */
async function proxyGet(rrId, rawPathAndQuery, requestHeaders = {}) {
  const qIdx  = rawPathAndQuery.indexOf('?');
  const path  = qIdx === -1 ? rawPathAndQuery : rawPathAndQuery.slice(0, qIdx);
  const query = qIdx === -1 ? '' : rawPathAndQuery.slice(qIdx + 1);
  const isConfig = isConfigPath(path);

  observe(rrId, 'requests');

  // Conditional requests bypass the cache so upstream 304 semantics survive
  const conditional = !!(requestHeaders['if-none-match'] || requestHeaders['if-modified-since']);

  const rspKey = keyRsp(rrId, rawPathAndQuery);
  if (!conditional) {
    const cached = await redis.get(rspKey).catch(() => null);
    if (cached) {
      observe(rrId, 'cache_hits');
      return { ...JSON.parse(cached), cache: 'HIT' };
    }
  }

  // Config always comes from my.raceresult.com; data calls go to the event's
  // resolved server (stored when a config last passed through)
  let host = DEFAULT_HOST;
  if (!isConfig) {
    const stored = await redis.get(keyServer(rrId)).catch(() => null);
    if (stored) host = stored;
  }

  const url = `https://${host}/${rrId}/${path}${query ? '?' + query : ''}`;
  const headers = {
    'user-agent': USER_AGENT,
    'accept': requestHeaders['accept'] || 'application/json, text/plain, */*',
  };
  if (requestHeaders['accept-language']) headers['accept-language'] = requestHeaders['accept-language'];
  if (requestHeaders['if-none-match'])    headers['if-none-match']    = requestHeaders['if-none-match'];
  if (requestHeaders['if-modified-since']) headers['if-modified-since'] = requestHeaders['if-modified-since'];

  let response, body;
  try {
    response = await fetchWithTimeout(url, headers);
    body = await response.text();
  } catch (err) {
    observe(rrId, 'upstream_errors');
    if (isConfig) {
      const snapshot = await redis.get(keyLastGood(rrId, configPage(path, query))).catch(() => null);
      if (snapshot) {
        observe(rrId, 'stale_served');
        return { ...JSON.parse(snapshot), cache: 'MISS', stale: true };
      }
    }
    throw err;
  }

  const contentType = response.headers.get('content-type') || 'application/json';

  // Non-200 (incl. 304) passes through verbatim and is never cached
  if (response.status !== 200) {
    if (response.status >= 500) observe(rrId, 'upstream_errors');
    return { status: response.status, contentType, body, cache: 'MISS' };
  }

  let outBody = body;
  if (isConfig) {
    let parsed = null;
    try {
      const decoded = JSON.parse(body);
      if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) parsed = decoded;
    } catch (_) {
      // RR returns plain-text "not found" with HTTP 200 on some config paths —
      // that is valid pass-through, the app handles it. Only flag real lists
      // payloads that stopped parsing.
    }

    if (parsed) {
      if (typeof parsed.server === 'string' && parsed.server.length > 0) {
        // Remember the real data server, then point the app back at us
        redis.setex(keyServer(rrId), TTL.server, parsed.server).catch(() => {});
        parsed.server = PROXY_SERVER;
      }
      const overrides = await getOverrides(rrId);
      if (overrides) applyOverrides(rrId, parsed, overrides);
      outBody = JSON.stringify(parsed);

      const result = { status: 200, contentType: 'application/json', body: outBody };
      redis.setex(keyLastGood(rrId, configPage(path, query)), TTL.lastGood, JSON.stringify(result))
        .catch(() => {});
    }
  } else if (contentType.includes('json')) {
    // Early-warning signal: upstream said JSON but the body doesn't parse
    try { JSON.parse(body); } catch (_) {
      observe(rrId, 'parse_failures');
      console.error(`[rrpublish] non-JSON body from ${url} (${body.slice(0, 120)})`);
    }
  }

  const result = { status: 200, contentType, body: outBody };
  if (!conditional) {
    redis.setex(rspKey, cacheTtl(path, query), JSON.stringify(result)).catch(() => {});
  }
  return { ...result, cache: 'MISS' };
}

module.exports = { proxyGet, applyOverrides, isConfigPath, configPage, cacheTtl, PROXY_SERVER };
