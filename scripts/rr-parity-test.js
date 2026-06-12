/**
 * RR proxy parity test (pre-work P1, docs/rr_proxy_implementation_plan.md).
 *
 * Fetches the RRPublish call shapes the mobile app makes — legacy + modern
 * config, first visible list, and one athlete's per-athlete config + splits —
 * both DIRECT from my.raceresult.com and VIA the proxy, then deep-diffs the
 * JSON. The only allowed difference is the `server` field (the proxy's one
 * mutation) and any `_evento` blocks added by CMS overrides.
 *
 * Usage:
 *   node scripts/rr-parity-test.js --events 389783,123456 \
 *     [--proxy http://localhost:3000/v1/rrpublish] [--token <bearer>] [--lang en]
 *
 * Exit code 0 = byte-identical (modulo allowed fields) for all events.
 */

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const EVENTS = (arg('events', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const PROXY  = (arg('proxy', 'http://localhost:3000/v1/rrpublish')).replace(/\/$/, '');
const TOKEN  = arg('token', process.env.EVENTO_API_TOKEN || '');
const LANG   = arg('lang', 'en');
const DIRECT = 'https://my.raceresult.com';

if (EVENTS.length === 0) {
  console.error('No events given. Usage: node scripts/rr-parity-test.js --events 389783[,..]');
  process.exit(2);
}

// Fields allowed to differ between direct and proxied payloads
const IGNORED_KEYS = new Set(['server', '_evento']);

let failures = 0;
let comparisons = 0;

async function get(url, viaProxy) {
  const headers = { accept: 'application/json, text/plain, */*' };
  if (viaProxy && TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  return { status: res.status, text };
}

function parse(text) {
  try { return JSON.parse(text); } catch (_) { return text; }
}

/** Deep diff, ignoring IGNORED_KEYS. Returns list of "path: a vs b" strings. */
function diff(a, b, path = '', out = []) {
  if (out.length > 20) return out;
  if (typeof a !== typeof b) {
    out.push(`${path || '/'}: type ${typeof a} vs ${typeof b}`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: array length ${a.length} vs ${b.length}`);
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) diff(a[i], b[i], `${path}[${i}]`, out);
  } else if (a && b && typeof a === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (IGNORED_KEYS.has(k)) continue;
      if (!(k in a)) { out.push(`${path}.${k}: missing direct`); continue; }
      if (!(k in b)) { out.push(`${path}.${k}: missing proxied`); continue; }
      diff(a[k], b[k], `${path}.${k}`, out);
    }
  } else if (a !== b) {
    out.push(`${path}: ${JSON.stringify(a)?.slice(0, 60)} vs ${JSON.stringify(b)?.slice(0, 60)}`);
  }
  return out;
}

async function compare(label, pathAndQuery, rrId) {
  comparisons++;
  const [d, p] = await Promise.all([
    get(`${DIRECT}/${rrId}/${pathAndQuery}`, false),
    get(`${PROXY}/${rrId}/${pathAndQuery}`, true),
  ]);
  if (d.status !== p.status) {
    failures++;
    console.log(`  FAIL ${label}: HTTP ${d.status} direct vs ${p.status} proxied`);
    if (p.status === 401) console.log('       (401 from proxy — pass --token or set EVENTO_API_TOKEN)');
    return null;
  }
  const dj = parse(d.text);
  const pj = parse(p.text);
  const problems = (typeof dj === 'string' || typeof pj === 'string')
    ? (d.text === p.text ? [] : ['non-JSON bodies differ'])
    : diff(dj, pj);
  if (problems.length > 0) {
    failures++;
    console.log(`  FAIL ${label}:`);
    for (const pr of problems.slice(0, 10)) console.log(`       ${pr}`);
  } else {
    console.log(`  ok   ${label}`);
  }
  return dj;
}

/** Pull a usable list + contest out of a config payload (modern or legacy). */
function firstVisibleList(config) {
  if (!config || typeof config !== 'object') return null;
  const lists = Array.isArray(config.lists) && config.lists.length
    ? config.lists
    : (config.TabConfig?.Lists || []);
  return lists.find(l =>
    typeof l?.Format === 'string' && /[VP]/.test(l.Format) && !(l.Mode || '').length
  ) || lists[0] || null;
}

/** Heuristic: find a pid in RR list data (rows keyed by group, pid usually field 0). */
function findPid(listData) {
  const data = listData?.data;
  if (!data || typeof data !== 'object') return null;
  const stack = [data];
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      if (cur.length && Array.isArray(cur[0])) {
        const first = cur[0][0];
        if (typeof first === 'number' || /^\d+$/.test(String(first))) return String(first);
      }
      continue;
    }
    if (cur && typeof cur === 'object') stack.push(...Object.values(cur));
  }
  return null;
}

(async () => {
  for (const rrId of EVENTS) {
    console.log(`\nEvent ${rrId}`);
    const legacy = await compare('legacy config (page=results)',
      `RRPublish/data/config?lang=${LANG}&page=results&v=1`, rrId);
    const modern = await compare('modern config (results/config)',
      `results/config?lang=${LANG}`, rrId);
    await compare('participants config', `participants/config?lang=${LANG}`, rrId);

    const config = (legacy && typeof legacy === 'object' && legacy.lists) ? legacy : modern;
    if (!config || typeof config !== 'object' || !config.key) {
      console.log('  skip list/splits — no usable config (event closed or key missing)');
      continue;
    }
    const list = firstVisibleList(config);
    if (!list) { console.log('  skip list — no lists in config'); continue; }

    const detailsPath = (config.lists ? 'RRPublish/data' : 'results');
    const listQuery = `key=${config.key}&listname=${encodeURIComponent(list.Name)}` +
      `&page=results&contest=${list.Contest ?? 0}&r=all&l=0&lang=${LANG}`;
    const listData = await compare(`list "${list.Name}"`, `${detailsPath}/list?${listQuery}`, rrId);

    const pid = findPid(listData);
    if (!pid) { console.log('  skip splits — could not extract a pid from list data'); continue; }
    const dp = list.Details || config.TabConfig?.StandardDetails || detailsPath;
    await compare(`athlete config (pid=${pid})`, `${dp}/config?key=${config.key}&pid=${pid}`, rrId);
    await compare(`athlete splits (pid=${pid})`, `${dp}/splits?key=${config.key}&pid=${pid}`, rrId);
  }

  console.log(`\n${comparisons} comparisons, ${failures} failures`);
  process.exit(failures === 0 ? 0 : 1);
})();
