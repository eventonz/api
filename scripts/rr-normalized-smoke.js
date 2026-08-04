/**
 * Offline-infra smoke test for the app/v1 normalized RRPublish endpoints.
 *
 * Stubs Redis + Postgres in the module cache (no production infrastructure
 * touched) and exercises the normalizers against the REAL my.raceresult.com
 * across the six standard test events: config, first list, per-group paging,
 * and each list's first athlete.
 *
 * Usage: node scripts/rr-normalized-smoke.js [rrId ...]
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
const fakePool = { query: async () => ({ rows: [] }) };

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (/config[\\/]redis$/.test(request)) return fakeRedis;
  if (/config[\\/]database$/.test(request)) return fakePool;
  return origLoad.call(this, request, parent, isMain);
};

const { normalizedConfig, normalizedList, normalizedAthlete } =
  require('../src/services/rrpublish/normalize');

const EVENTS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['403664', '405141', '384316', '376606', '405215', '412789'];

(async () => {
  let passed = 0;
  const check = (name, cond) => {
    assert(cond, `FAILED: ${name}`);
    console.log(`ok   ${name}`);
    passed++;
  };

  for (const rrId of EVENTS) {
    console.log(`\n=== ${rrId} ===`);

    const cfg = await normalizedConfig(rrId, { lang: 'en' });
    check('config 200 + schemaVersion 1', cfg.status === 200 && cfg.body.schemaVersion === 1);
    check(`config has lists (${cfg.body.lists?.length})`, cfg.body.lists.length > 0);
    console.log(`     event="${cfg.body.event.name}" accent=${cfg.body.event.accentColor}`
      + ` tabs=${JSON.stringify(cfg.body.tabs)}`);

    const list = await normalizedList(rrId, { tab: 'results', lang: 'en' });
    check('list 200', list.status === 200);
    const rows = list.body.groups.flatMap((g) => g.rows);
    check(`list has rows (${rows.length} in ${list.body.groups.length} groups)`, rows.length > 0);
    check('rows have names + positions',
      rows.every((r) => r.name !== '' && typeof r.position === 'number'));
    console.log(`     resultLabel="${list.body.resultLabel}" filters=`
      + JSON.stringify(list.body.filters.map((f) => `${f.label}(${f.options.length})`)));

    // Per-group paging — the client only pages hasMore (leader-mode) groups,
    // but exercise any keyed group to cover the flat-array response shape too
    const pageable = list.body.groups.find((g) => g.hasMore)
      || list.body.groups.find((g) => g.key && g.rows.length > 0);
    if (pageable) {
      const more = await normalizedList(rrId, {
        tab: 'results', lang: 'en', group: pageable.key, limit: Math.min(pageable.shown + 5, 50),
      });
      check(`group-more 200 for ${pageable.key}`, more.status === 200 && more.body.group);
      check('group-more rows capped to limit',
        more.body.group.rows.length <= Math.min(pageable.shown + 5, 50));
    } else {
      console.log('     skip group-more — no keyed group');
    }

    // First athlete of the list
    const pid = rows[0]?.pid;
    if (pid) {
      const ath = await normalizedAthlete(rrId, { pid, lang: 'en' });
      check(`athlete ${pid} 200`, ath.status === 200);
      const nSplits = ath.body.splits.rows.length;
      const nLegs = ath.body.legs.rows.length;
      console.log(`     splitConfig=${ath.body.splitConfig} splits=${nSplits} legs=${nLegs}`
        + ` hyrox=${ath.body.hyrox ? ath.body.hyrox.length + ' steps' : 'no'}`);
    }
  }

  console.log(`\n${passed} checks passed`);
  process.exit(0);
})().catch((err) => { console.error(err.message); process.exit(1); });
