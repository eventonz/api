/**
 * Records raw RRPublish upstream responses into tests/fixtures/rrpublish/{rrId}/
 * for offline normalizer unit/golden tests.
 *
 * Hits my.raceresult.com (config) and the event's resolved data server
 * (list/athlete endpoints) directly — the proxy is not involved, these
 * fixtures are upstream truth.
 *
 * Per event it records:
 *   config.json                modern results/config
 *   legacy-config.json         RRPublish/data/config (page=results)
 *   participants-config.json   participants/config
 *   live-config.json           live/config
 *   list-{n}.json              up to 3 visible result lists
 *   participants-list.json     start list (page=participants)
 *   live-list.json             live list (page=live)
 *   athlete-{pid}-view.json    modern per-athlete view
 *   athlete-{pid}-config.json  legacy per-athlete config (SplitConfig)
 *   athlete-{pid}-splits.json  legacy splits
 *   index.json                 what was recorded (listnames, pids, server)
 *
 * Usage: node scripts/rr-record-fixtures.js [rrId ...]
 *        (default: the six standard test events)
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_EVENTS = ['403664', '405141', '384316', '376606', '405215', '412789'];
const LANG = 'en';
const FIXTURE_ROOT = path.join(__dirname, '..', 'tests', 'fixtures', 'rrpublish');

async function get(host, rrId, pathAndQuery) {
  const url = `https://${host}/${rrId}/${pathAndQuery}`;
  const res = await fetch(url, {
    headers: { accept: 'application/json, text/plain, */*' },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  return { url, status: res.status, text };
}

function save(dir, name, text) {
  // pretty-print when it parses, so fixtures are diffable
  let out = text;
  try { out = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep raw */ }
  fs.writeFileSync(path.join(dir, name), out);
  console.log(`  saved ${name} (${out.length} bytes)`);
}

/** Depth-first scan for participant rows (arrays of length >= 3). */
function findRows(node, out = []) {
  if (Array.isArray(node)) {
    for (const el of node) {
      if (Array.isArray(el) && el.length >= 3) out.push(el);
      else findRows(el, out);
    }
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) findRows(v, out);
  }
  return out;
}

async function recordEvent(rrId) {
  console.log(`\n=== ${rrId} ===`);
  const dir = path.join(FIXTURE_ROOT, rrId);
  fs.mkdirSync(dir, { recursive: true });
  const index = { rrId, recordedAt: new Date().toISOString(), lists: [], athletes: [] };

  // 1. configs (always from my.raceresult.com)
  const cfg = await get('my.raceresult.com', rrId, `results/config?lang=${LANG}`);
  save(dir, 'config.json', cfg.text);
  const legacy = await get('my.raceresult.com', rrId,
    `RRPublish/data/config?lang=${LANG}&page=results&v=1`);
  save(dir, 'legacy-config.json', legacy.text);
  for (const [name, p] of [
    ['participants-config.json', `participants/config?lang=${LANG}`],
    ['live-config.json', `live/config?lang=${LANG}`],
  ]) {
    try {
      const r = await get('my.raceresult.com', rrId, p);
      save(dir, name, r.text);
    } catch (e) { console.log(`  skip ${name}: ${e.message}`); }
  }

  let config;
  try { config = JSON.parse(cfg.text); } catch { config = null; }
  if (!config) { console.log('  modern config not JSON — stopping event'); return index; }
  const server = typeof config.server === 'string' && config.server ? config.server : 'my.raceresult.com';
  const key = config.key || '';
  index.server = server;

  const tabLists = config.TabConfig?.Lists || [];
  const isTabConfig = tabLists.length > 0;
  const rawLists = isTabConfig ? tabLists : (config.lists || []);
  const visible = rawLists.filter(l => /[VP]/.test(l?.Format || '') && !(l?.Mode || '').length);
  const listPath = isTabConfig ? 'results' : 'RRPublish/data';

  // 2. result lists (up to 3)
  const pids = new Set();
  for (let n = 0; n < Math.min(3, visible.length); n++) {
    const list = visible[n];
    const q = `${listPath}/list?key=${key}&listname=${encodeURIComponent(list.Name)}` +
      `&page=results&contest=${list.Contest ?? 0}&r=all&l=0&lang=${LANG}`;
    try {
      const r = await get(server, rrId, q);
      if (r.status !== 200) { console.log(`  list ${n}: HTTP ${r.status}, skipped`); continue; }
      save(dir, `list-${n}.json`, r.text);
      index.lists.push({ file: `list-${n}.json`, listname: list.Name, contest: list.Contest ?? 0 });
      if (pids.size < 2) {
        try {
          const rows = findRows(JSON.parse(r.text));
          // first row (finisher) and last row (most likely partial/DNF)
          for (const row of [rows[0], rows[rows.length - 1]]) {
            const pid = row?.[1];
            if (pid != null && `${pid}`.length && pids.size < 2) pids.add(`${pid}`);
          }
        } catch { /* non-JSON list */ }
      }
    } catch (e) { console.log(`  list ${n} failed: ${e.message}`); }
  }

  // 3. participants + live lists
  for (const [name, page, pathSeg] of [
    ['participants-list.json', 'participants', isTabConfig ? 'participants' : 'RRPublish/data'],
    ['live-list.json', 'live', isTabConfig ? 'live' : 'RRPublish/data'],
  ]) {
    try {
      const pageCfgRaw = fs.existsSync(path.join(dir, `${page}-config.json`))
        ? fs.readFileSync(path.join(dir, `${page}-config.json`), 'utf8') : null;
      let pageCfg = null;
      try { pageCfg = pageCfgRaw ? JSON.parse(pageCfgRaw) : null; } catch { /* not JSON */ }
      const pKey = pageCfg?.key || key;
      const pLists = pageCfg?.TabConfig?.Lists || pageCfg?.lists || [];
      const pList = pLists.find(l => /[VP]/.test(l?.Format || '') && !(l?.Mode || '').length) || pLists[0];
      if (!pList) { console.log(`  skip ${name}: no lists in ${page} config`); continue; }
      const q = `${pathSeg}/list?key=${pKey}&listname=${encodeURIComponent(pList.Name)}` +
        `&page=${page}&contest=0&r=all&l=0&lang=${LANG}`;
      const r = await get(server, rrId, q);
      if (r.status === 200) save(dir, name, r.text);
      else console.log(`  ${name}: HTTP ${r.status}, skipped`);
    } catch (e) { console.log(`  ${name} failed: ${e.message}`); }
  }

  // 4. athletes: modern view + legacy config/splits
  const detailsPath = visible[0]?.Details || config.TabConfig?.StandardDetails || 'results';
  for (const pid of pids) {
    try {
      const v = await get(server, rrId, `${detailsPath}/view?key=${key}&pid=${pid}&lang=${LANG}`);
      if (v.status === 200) save(dir, `athlete-${pid}-view.json`, v.text);
      // legacy per-athlete config/splits live under RRPublish/data/ (that's
      // the variant whose config carries SplitConfig — results/config?pid
      // just echoes the event config), NOT under named details pages
      // (e.g. "details0" 404s for these)
      let legacyPath = null;
      let splitsPath = null;
      for (const cand of ['RRPublish/data', 'results']) {
        if (!legacyPath) {
          const c = await get(server, rrId, `${cand}/config?key=${key}&pid=${pid}`);
          if (c.status === 200) {
            save(dir, `athlete-${pid}-config.json`, c.text);
            legacyPath = cand;
          }
        }
        if (!splitsPath) {
          const s = await get(server, rrId, `${cand}/splits?key=${key}&pid=${pid}`);
          if (s.status === 200) {
            save(dir, `athlete-${pid}-splits.json`, s.text);
            splitsPath = cand;
          }
        }
      }
      index.athletes.push({ pid, detailsPath, legacyPath, splitsPath });
    } catch (e) { console.log(`  athlete ${pid} failed: ${e.message}`); }
  }

  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`  index.json written (${index.lists.length} lists, ${index.athletes.length} athletes)`);
  return index;
}

(async () => {
  const events = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_EVENTS;
  for (const rrId of events) {
    try { await recordEvent(rrId); }
    catch (e) { console.error(`event ${rrId} FAILED: ${e.message}`); }
  }
  console.log('\ndone');
})();
