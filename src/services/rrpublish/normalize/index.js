/**
 * RRPublish normalized-schema orchestrators (app/v1).
 *
 * Compose the pure normalize/ modules over proxyGet — which supplies the raw
 * Redis cache, data-server resolution, last-good config snapshots and CMS
 * display overrides for free. The RR session `key` never reaches clients:
 * these orchestrators fetch config themselves and own the key-lag retry
 * (a /list fired right after the /config that minted its key can 400 for a
 * few hundred ms — retry with a cache-bypassed config refetch).
 *
 * Every response carries schemaVersion 1; the raw passthrough is untouched.
 */

const { proxyGet, PROXY_SERVER } = require('../client');
const { str, toInt } = require('./util');
const lists = require('./lists');
const { extractFieldMetadata } = require('./columns');
const { buildFilterMenus } = require('./filters');
const { extractGroups, extractGroupMore } = require('./rows');
const { classifyFields } = require('./athleteInfo');
const splitsMod = require('./splits');
const { isHyrox, hyroxSteps } = require('./hyrox');

const SCHEMA_VERSION = 1;
const LIVE_POLL_SECONDS = 20;
const FILTER_SEP = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** proxyGet → parsed JSON object, or null (RR returns text "not found" with 200). */
async function getJson(rrId, pathAndQuery, opts = {}) {
  let res;
  try {
    res = await proxyGet(rrId, pathAndQuery, {}, opts);
  } catch (_) {
    return { json: null, stale: false };
  }
  if (res.status !== 200) return { json: null, stale: false };
  try {
    const decoded = JSON.parse(res.body);
    const json = decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded : null;
    return { json, stale: !!res.stale };
  } catch (_) {
    return { json: null, stale: false };
  }
}

/**
 * Modern + legacy config fetch/merge for a page (iOS performLoad port):
 * prefer modern, borrow TabConfig from legacy, back-fill visibility flags.
 */
async function fetchMergedConfig(rrId, page, lang, opts = {}) {
  const modernPath = `${page}/config?lang=${encodeURIComponent(lang)}`;
  const legacyPath = `RRPublish/data/config?lang=${encodeURIComponent(lang)}&page=${page}&v=1`;
  const [m, l] = await Promise.all([
    getJson(rrId, modernPath, opts),
    getJson(rrId, legacyPath, opts),
  ]);
  const modern = m.json;
  const legacy = l.json;
  const base = modern || legacy;
  if (!base) return { config: null, legacy: null, stale: false };
  if (base.TabConfig == null && legacy?.TabConfig != null) base.TabConfig = legacy.TabConfig;
  for (const flag of ['showResults', 'showParticipants', 'showLive', 'showCertificates', 'EventOver']) {
    if (base[flag] == null && legacy?.[flag] != null) base[flag] = legacy[flag];
  }
  return { config: base, legacy, stale: m.stale || l.stale };
}

/** Percent-encoded query from pairs, empty values skipped (iOS url() port). */
function buildQuery(params) {
  return params
    .filter(([, v]) => str(v) !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(str(v))}`)
    .join('&');
}

const detailBase = (rrId) => `https://${PROXY_SERVER}/${rrId}`;

// ---------------------------------------------------------------------------
// GET .../app/v1/config
// ---------------------------------------------------------------------------

/**
 * Whether RaceResult publishes a given tab for this event.
 *
 * The legacy showParticipants/showLive flags live only on the legacy
 * RRPublish/data/config endpoint, which modern (v1.2.15x) events no longer
 * serve — it 404s, so those flags are permanently absent and both tabs were
 * silently never offered. Modern detection asks the tab's own config: an
 * unpublished tab answers {"error":"tab not found: X"} or 404, a published
 * one returns its own TabConfig.Lists.
 */
async function tabPublished(rrId, page, lang, legacyFlag) {
  if (legacyFlag === true) return true;
  const { config } = await fetchMergedConfig(rrId, page, lang);
  if (!config) return false;
  const t = config.Tab;
  if (t && typeof t === 'object') {
    if (t.Enabled === false || t.ShowInMenu === false) return false;
    const from = Date.parse(str(t.ActiveFrom));
    const until = Date.parse(str(t.ActiveUntil));
    const now = Date.now();
    if (!Number.isNaN(from) && now < from) return false;
    if (!Number.isNaN(until) && now > until) return false;
  }
  return lists.allLists(config).length > 0;
}

async function normalizedConfig(rrId, { lang = 'en' } = {}) {
  const { config, legacy, stale } = await fetchMergedConfig(rrId, 'results', lang);
  if (!config) return { status: 404, stale: false, body: { error: 'No results published yet for this event.' } };

  const brand = str(config.BrandColorDark ?? legacy?.BrandColorDark).trim();
  const eventOver = config.EventOver === true;
  const visible = lists.visibleLists(config);
  const [hasParticipants, hasLive] = await Promise.all([
    tabPublished(rrId, 'participants', lang, config.showParticipants),
    eventOver ? Promise.resolve(false) : tabPublished(rrId, 'live', lang, config.showLive),
  ]);
  return {
    status: 200,
    stale,
    body: {
      schemaVersion: SCHEMA_VERSION,
      rrId: str(rrId),
      lang,
      event: {
        name: str(config.eventname ?? config.EventName) || null,
        eventOver,
        accentColor: brand === '' ? null : brand,
      },
      tabs: {
        results: visible.length > 0,
        participants: hasParticipants,
        live: hasLive && !eventOver,
        certificates: config.showCertificates === true,
        livePollSeconds: LIVE_POLL_SECONDS,
      },
      contests: lists.contestEntries(config, lang),
      lists: visible.map((l) => lists.listEntry(config, l, lang)),
      // Print-only lists — PDF downloads, never result tables.
      pdfLists: lists.pdfLists(config).map((l) => lists.listEntry(config, l, lang)),
    },
  };
}

// ---------------------------------------------------------------------------
// GET .../app/v1/list
// ---------------------------------------------------------------------------

/**
 * params: { tab: 'results'|'participants'|'live', listname?, contest?, lang,
 *           search?, f? (-joined filter slots), group?, limit? }
 */
/** First participant row-array anywhere in the (possibly grouped) data node. */
function firstRow(node) {
  if (Array.isArray(node)) {
    for (const r of node) if (Array.isArray(r) && r.length >= 3) return r;
    return null;
  }
  if (node && typeof node === 'object') {
    for (const v of Object.values(node)) {
      const r = firstRow(v);
      if (r) return r;
    }
  }
  return null;
}

async function normalizedList(rrId, params = {}) {
  const tab = ['results', 'participants', 'live'].includes(params.tab) ? params.tab : 'results';
  const lang = str(params.lang) || 'en';

  let { config, stale } = await fetchMergedConfig(rrId, tab, lang);
  if (!config) return { status: 404, stale: false, body: { error: 'No lists published for this page.' } };

  // List selection: results tab picks among visible lists (by raw Name);
  // participants/live use the page config's first list (iOS parity).
  const pool = tab === 'results' ? lists.visibleLists(config) : lists.allLists(config);
  const list = (str(params.listname) !== ''
    ? pool.find((l) => str(l?.Name) === str(params.listname))
    : pool[0]) || pool[0];
  if (!list) return { status: 404, stale, body: { error: 'List not found.' } };

  let contest = str(params.contest) !== '' ? str(params.contest) : str(list.Contest ?? '0') || '0';
  const leaderCount = toInt(list.Leader, 0);
  const leadersMode = tab === 'results' && leaderCount > 0 && str(params.group) === '';
  const groupKey = str(params.group);
  const limit = Math.max(0, toInt(params.limit, 0));
  const search = str(params.search);
  const f = str(params.f);
  const groupFilter = f === '' ? [] : f.split(FILTER_SEP);

  const pathFor = (cfg) => {
    if (cfg?.TabConfig != null) return tab;               // modern: results|participants|live
    return 'RRPublish/data';                              // legacy
  };

  const queryFor = (cfg) => {
    const r = groupKey !== '' ? 'group' : (search !== '' ? 'search' : (leadersMode ? 'leaders' : 'all'));
    const pairs = [
      ['key', str(cfg.key)],
      ['listname', str(list.Name)],
      ['page', tab],
      ['contest', tab === 'results' ? contest : '0'],
      ['r', r],
    ];
    if (groupKey !== '') {
      pairs.push(['name', groupKey], ['l', `${limit}`]);
    } else if (tab === 'results') {
      pairs.push(['l', `${leaderCount}`]);
    }
    pairs.push(['lang', lang]);
    if (f.split(FILTER_SEP).join('') !== '') pairs.push(['f', f]);
    if (search !== '') pairs.push(['term', search]);
    return buildQuery(pairs);
  };

  // Key-lag retry: RaceResult's session key can lag the /config call that
  // minted it — a /list fired immediately after can 400 transiently. On
  // failure, re-mint the key with a cache-bypassed config refetch.
  let data = null;
  for (let attempt = 0; attempt < 3 && !data; attempt++) {
    if (attempt > 0) {
      await sleep(350);
      const fresh = await fetchMergedConfig(rrId, tab, lang, { bypassCache: true });
      if (fresh.config) { config = fresh.config; stale = stale || fresh.stale; }
    }
    ({ json: data } = await getJson(rrId, `${pathFor(config)}/list?${queryFor(config)}`));
  }
  if (!data) return { status: 502, stale, body: { error: 'Upstream RaceResult request failed' } };

  // Contest fallback: a list is not guaranteed to exist for every contest —
  // 406086 publishes "Resultat|Live" for contest 2 only, and answers
  // {"error":"list not found"} for the 0/all default. Retry with the contest
  // the list definition itself names, then with 0.
  if (!data.list) {
    for (const alt of [str(list.Contest ?? ''), '0']) {
      if (alt === '' || alt === contest) continue;
      contest = alt;
      const { json: retry } = await getJson(rrId, `${pathFor(config)}/list?${queryFor(config)}`);
      if (retry?.list) { data = retry; break; }
    }
  }

  const listFormat = (data.list && typeof data.list === 'object') ? data.list : {};
  const dataFields = Array.isArray(data.DataFields) ? data.DataFields : [];
  // A sample row lets the fallback tell a time column from a gap/category one.
  const meta = extractFieldMetadata(listFormat, dataFields, lang, firstRow(data.data));
  const rowCtx = {
    dataFields,
    nameIdx: meta.nameIdx,
    resultIdx: meta.resultIdx,
    rankIdx: meta.hasRank ? meta.rankIdx : -1,
    lang,
    groupFilter,
    leadersMode,
  };
  const infoCtx = { fieldLabels: meta.fieldLabels, detailBase: detailBase(rrId), lang };
  const decorate = (g) => ({
    ...g,
    rows: g.rows.map((p) => ({
      position: p.position,
      rank: p.rank === '' ? null : p.rank,
      pid: p.pid,
      bib: p.bib,
      name: p.name,
      time: p.time,
      videoLink: p.videoLink === '' ? null : p.videoLink,
      info: classifyFields(p.fields, p, infoCtx),
    })),
  });

  // Per-group paging: one group, capped (RR sometimes ignores l=).
  if (groupKey !== '') {
    const group = extractGroupMore(data.data, groupKey, limit || 100, rowCtx);
    if (!group) return { status: 404, stale, body: { error: 'Group not found in response.' } };
    return { status: 200, stale, body: { schemaVersion: SCHEMA_VERSION, tab, group: decorate(group) } };
  }

  const { menus } = buildFilterMenus(listFormat, data.groupFilters, lang);
  for (const m of menus) {
    if (m.slot < groupFilter.length) m.selected = groupFilter[m.slot];
  }
  // Start list: a "Time" result label really shows the category column.
  const resultLabel = tab === 'participants' && meta.resultFieldLabel === 'Time'
    ? 'Category' : meta.resultFieldLabel;

  return {
    status: 200,
    stale,
    body: {
      schemaVersion: SCHEMA_VERSION,
      tab,
      list: {
        name: str(list.Name),
        displayName: lists.listDisplayName(list, lang),
        contest,
        leaderCount,
      },
      resultLabel,
      filters: menus,
      groups: extractGroups(data.data, rowCtx).map(decorate),
    },
  };
}

// ---------------------------------------------------------------------------
// GET .../app/v1/athlete
// ---------------------------------------------------------------------------

/** params: { pid, listname?, lang } */
async function normalizedAthlete(rrId, params = {}) {
  const pid = str(params.pid);
  if (pid === '') return { status: 400, stale: false, body: { error: 'pid required' } };
  const lang = str(params.lang) || 'en';

  const { config, stale } = await fetchMergedConfig(rrId, 'results', lang);
  if (!config) return { status: 404, stale: false, body: { error: 'Event config unavailable.' } };
  const visible = lists.visibleLists(config);
  const list = (str(params.listname) !== ''
    ? visible.find((l) => str(l?.Name) === str(params.listname))
    : visible[0]) || visible[0] || null;
  const path = lists.detailsPath(config, list);
  const key = str(config.key);

  let rawSplits = [];
  let rawLegs = [];
  let sc = '';

  // Modern: single /view call with layout elements.
  const { json: view } = await getJson(rrId,
    `${path}/view?${buildQuery([['key', key], ['pid', pid], ['lang', lang]])}`);
  if (view?.Data && typeof view.Data === 'object') {
    const sal = view.Data.SplitsAndLegs || {};
    rawSplits = splitsMod.normaliseSplitRows(sal.Splits, false);
    rawLegs = splitsMod.normaliseSplitRows(sal.Legs, true);
    sc = splitsMod.splitConfigFromElements(view.Elements,
      rawSplits.length > 0, rawLegs.length > 0);
    sc = splitsMod.inferColumnBits(sc, rawSplits, rawLegs);
  } else {
    // Legacy: /config?pid carries the SplitConfig bitmask; gate before
    // /splits. Named details pages 404 here — RRPublish/data is the variant
    // whose per-athlete config actually carries SplitConfig.
    let legacyCfg = null;
    for (const cand of [path, 'RRPublish/data']) {
      const { json } = await getJson(rrId,
        `${cand}/config?${buildQuery([['key', key], ['pid', pid]])}`);
      if (typeof json?.SplitConfig === 'string' && json.SplitConfig !== '') {
        legacyCfg = { path: cand, sc: json.SplitConfig };
        break;
      }
    }
    if (legacyCfg) {
      sc = legacyCfg.sc;
      const showLegs = sc[0] === '1';
      const showSplits = sc.length > 1 && sc[1] === '1';
      if (showLegs || showSplits) {
        const { json: sp } = await getJson(rrId,
          `${legacyCfg.path}/splits?${buildQuery([['key', key], ['pid', pid]])}`);
        if (sp) {
          rawSplits = splitsMod.normaliseSplitRows(sp.Splits, false);
          rawLegs = splitsMod.normaliseSplitRows(sp.Legs, true);
        }
      }
    }
  }

  const splitCols = splitsMod.resolveColumns(rawSplits, sc);
  const legCols = splitsMod.resolveColumns(rawLegs, sc);
  const hyroxSource = rawSplits.length > 0 ? rawSplits : rawLegs;
  return {
    status: 200,
    stale,
    body: {
      schemaVersion: SCHEMA_VERSION,
      pid,
      splitConfig: sc,
      show: splitsMod.showFlags(sc),
      splits: {
        columns: splitCols,
        rows: splitsMod.deriveRows(rawSplits, splitCols, lang),
      },
      legs: {
        columns: legCols,
        rows: splitsMod.deriveRows(rawLegs, legCols, lang),
      },
      hyrox: isHyrox(hyroxSource) ? hyroxSteps(hyroxSource) : null,
    },
  };
}

module.exports = { normalizedConfig, normalizedList, normalizedAthlete, SCHEMA_VERSION };
