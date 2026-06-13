/**
 * Offline-infra smoke test for the rrpublish proxy service.
 *
 * Stubs Redis + Postgres in the module cache (no production infrastructure
 * touched) and exercises proxyGet against the real my.raceresult.com:
 *   1. config pass-through with `server` rewrite, body otherwise identical
 *   2. response caching (second call = HIT)
 *   3. data-server resolution for non-config paths
 *   4. list pass-through byte-identical to direct
 *   5. display-overrides merge (Mode/ShowAs/_evento) when a DB row exists
 *
 * Usage: node scripts/rr-proxy-smoke.js [rrEventId]   (default 389783)
 */

const Module = require('module');
const assert = require('assert');

// --- in-memory fakes -------------------------------------------------------
const store = new Map();
const fakeRedis = {
  get:     async (k) => (store.has(k) ? store.get(k) : null),
  setex:   async (k, _ttl, v) => { store.set(k, v); return 'OK'; },
  hincrby: async () => 1,
  expire:  async () => 1,
};
let overrideRows = [];
const fakePool = { query: async () => ({ rows: overrideRows }) };

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (/config[\\/]redis$/.test(request)) return fakeRedis;
  if (/config[\\/]database$/.test(request)) return fakePool;
  return origLoad.call(this, request, parent, isMain);
};

const { proxyGet, PROXY_SERVER } = require('../src/services/rrpublish/client');

const rrId = process.argv[2] || '389783';
const LANG = 'en';

async function direct(pathAndQuery) {
  const res = await fetch(`https://my.raceresult.com/${rrId}/${pathAndQuery}`, {
    headers: { accept: 'application/json, text/plain, */*' },
    signal: AbortSignal.timeout(15000),
  });
  return { status: res.status, text: await res.text() };
}

(async () => {
  let passed = 0;
  const check = (name, cond) => {
    assert(cond, `FAILED: ${name}`);
    console.log(`ok   ${name}`);
    passed++;
  };

  // 1. config pass-through + server rewrite
  const cfgPath = `results/config?lang=${LANG}`;
  const [d, p] = await Promise.all([direct(cfgPath), proxyGet(rrId, cfgPath, {})]);
  check('config: HTTP 200 both ways', d.status === 200 && p.status === 200);
  const dj = JSON.parse(d.text);
  const pj = JSON.parse(p.body);
  check('config: server rewritten to proxy', pj.server === PROXY_SERVER);
  check('config: real server captured in redis', store.get(`rrpublish:server:${rrId}`) === dj.server);
  const djNoServer = { ...dj, server: 'X' };
  const pjNoServer = { ...pj, server: 'X' };
  check('config: body identical apart from server field',
    JSON.stringify(djNoServer) === JSON.stringify(pjNoServer));

  // 2. caching
  const p2 = await proxyGet(rrId, cfgPath, {});
  check('config: second call served from cache', p2.cache === 'HIT' && p2.body === p.body);

  // 3+4. list pass-through via resolved data server
  const lists = dj.lists || dj.TabConfig?.Lists || [];
  const list = lists.find(l => /[VP]/.test(l?.Format || '') && !(l.Mode || '').length) || lists[0];
  if (list && dj.key) {
    const detailsPath = dj.lists ? 'RRPublish/data' : 'results';
    const listPath = `${detailsPath}/list?key=${dj.key}&listname=${encodeURIComponent(list.Name)}` +
      `&page=results&contest=${list.Contest ?? 0}&r=all&l=0&lang=${LANG}`;
    const [dl, pl] = await Promise.all([direct(listPath), proxyGet(rrId, listPath, {})]);
    check('list: HTTP status matches', dl.status === pl.status);
    if (dl.status === 200) {
      check('list: body byte-identical', dl.text === pl.body);
      const pl2 = await proxyGet(rrId, listPath, {});
      check('list: cached on repeat', pl2.cache === 'HIT');
    }
  } else {
    console.log('skip list test — no usable list/key in config');
  }

  // 5. overrides merge
  const targetName = lists[0]?.Name;
  if (targetName) {
    overrideRows = [{
      overrides: {
        v: 1,
        lists: {
          [targetName]: { hidden: true, label: 'Renamed By Evento', layout: 'two-line', line2: ['Club'] },
          'no-such-list|Ghost': { hidden: true },
        },
      },
    }];
    store.delete(`rrpublish:overrides:${rrId}`);
    // bust the response cache so the config is re-fetched and re-merged
    for (const k of [...store.keys()]) if (k.startsWith('rrpublish:rsp:')) store.delete(k);

    const pm = await proxyGet(rrId, cfgPath, {});
    const pmj = JSON.parse(pm.body);
    const mLists = pmj.lists || pmj.TabConfig?.Lists || [];
    const mTarget = mLists.find(l => l.Name === targetName);
    check('overrides: hidden -> Mode="hidden"', mTarget.Mode === 'hidden');
    check('overrides: label -> ShowAs', mTarget.ShowAs === 'Renamed By Evento');
    check('overrides: _evento block attached',
      mTarget._evento?.v === 1 && mTarget._evento.layout === 'two-line');
    check('overrides: unmatched key ignored (fail-soft)',
      !mLists.some(l => l.ShowAs === 'Ghost'));
  }

  // 6b. force-show — reveal a list RaceResult marked hidden (Mode -> '')
  const hiddenList = lists.find(l => (l.Mode || '').length);
  if (hiddenList) {
    overrideRows = [{ overrides: { v: 1, lists: { [hiddenList.Name]: { show: true } } } }];
    store.delete(`rrpublish:overrides:${rrId}`);
    for (const k of [...store.keys()]) if (k.startsWith('rrpublish:rsp:')) store.delete(k);
    const pf = await proxyGet(rrId, cfgPath, {});
    const pfj = JSON.parse(pf.body);
    const fLists = pfj.lists || pfj.TabConfig?.Lists || [];
    const revealed = fLists.find(l => l.Name === hiddenList.Name);
    check('force-show: RR-hidden list Mode cleared to ""', revealed && revealed.Mode === '');
  } else {
    console.log('skip force-show — no RR-hidden list in config');
  }

  console.log(`\n${passed} checks passed`);
  process.exit(0);
})().catch((err) => { console.error(err.message); process.exit(1); });
