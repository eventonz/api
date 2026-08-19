/**
 * Renders what the app's compact results row would show, for every recorded
 * fixture event — the "does this actually look good?" check that goldens
 * (which only detect change, not quality) cannot make.
 *
 * Usage: node scripts/rr-preview.js [rrId ...]
 */
const fs = require('fs');
const path = require('path');

const FIXTURE_ROOT = path.join(__dirname, '..', 'tests', 'fixtures', 'rrpublish');
const fixtureFile = (rrId, name) => {
  const p = path.join(FIXTURE_ROOT, rrId, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};

const proxyGet = async (rrId, rawPathAndQuery) => {
  const [p, query = ''] = rawPathAndQuery.split('?');
  const q = Object.fromEntries(new URLSearchParams(query));
  const serve = (name) => {
    const body = fixtureFile(rrId, name);
    return body == null
      ? { status: 404, contentType: 'text/plain', body: 'not found', cache: 'MISS' }
      : { status: 200, contentType: 'application/json', body, cache: 'MISS' };
  };
  const missing = { status: 404, contentType: 'text/plain', body: 'not found', cache: 'MISS' };
  if (p.endsWith('/view')) return serve(`athlete-${q.pid}-view.json`);
  if (p.endsWith('/splits') && q.pid) return serve(`athlete-${q.pid}-splits.json`);
  if (p.endsWith('/config')) {
    if (q.pid) return p.startsWith('RRPublish/data') ? serve(`athlete-${q.pid}-config.json`) : missing;
    if (p === 'results/config') return serve('config.json');
    if (p === 'participants/config') return serve('participants-config.json');
    if (p === 'live/config') return serve('live-config.json');
    if (p === 'RRPublish/data/config') return (q.page || 'results') === 'results' ? serve('legacy-config.json') : missing;
  }
  if (p.endsWith('/list')) {
    if (q.page === 'participants') return serve('participants-list.json');
    if (q.page === 'live') return serve('live-list.json');
    const idx = JSON.parse(fixtureFile(rrId, 'index.json'));
    const match = idx.lists.find((l) => l.listname === q.listname);
    return serve(match ? match.file : 'list-0.json');
  }
  return missing;
};

const clientPath = require.resolve('../src/services/rrpublish/client');
require.cache[clientPath] = {
  id: clientPath, filename: clientPath, loaded: true, children: [], paths: [],
  exports: { PROXY_SERVER: 'eventoapi.com/v1/rrpublish', proxyGet },
};

const { normalizedConfig, normalizedList } = require('../src/services/rrpublish/normalize');

const clip = (s, n) => { s = s == null ? '' : `${s}`; return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

(async () => {
  const events = process.argv.slice(2).length
    ? process.argv.slice(2)
    : fs.readdirSync(FIXTURE_ROOT).filter((d) => /^\d+$/.test(d)).sort();
  for (const rrId of events) {
    const cfg = await normalizedConfig(rrId, { lang: 'en' });
    const name = cfg.body?.event?.name || '?';
    const t = cfg.body?.tabs || {};
    console.log(`\n━━━ ${rrId}  ${clip(name, 44)}`);
    console.log(`    tabs: results=${!!t.results} startlist=${!!t.participants} live=${!!t.live}`
      + `  | lists=${cfg.body?.lists?.length ?? 0} pdf=${cfg.body?.pdfLists?.length ?? 0}`
      + ` | contests=${cfg.body?.contests?.length ?? 0}`);
    const res = await normalizedList(rrId, { lang: 'en' });
    if (res.status !== 200) { console.log(`    list: ${res.body?.error}`); continue; }
    console.log(`    list "${clip(res.body.list?.displayName, 30)}"  result column: ${res.body.resultLabel}`);
    let shown = 0;
    for (const g of res.body.groups || []) {
      if (shown >= 5) break;
      if (g.labels?.length) console.log(`      [${clip(g.labels.join(' / '), 46)}]`);
      for (const r of g.rows.slice(0, 3)) {
        if (shown++ >= 5) break;
        console.log(`        pos ${String(r.position).padStart(3)}  rank ${String(r.rank ?? '—').padStart(4)}`
          + `  bib ${clip(r.bib, 6).padStart(6)}  ${clip(r.name, 30).padEnd(30)}  ${clip(r.time, 16)}`);
      }
    }
  }
  console.log('');
})();
