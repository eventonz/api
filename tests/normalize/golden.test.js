/**
 * Full-pipeline golden tests: run the app/v1 orchestrators against the
 * recorded upstream fixtures (proxyGet mocked to serve them) and compare to
 * committed golden outputs.
 *
 * Regenerate deliberately after a normalizer change:
 *   UPDATE_GOLDENS=1 npx jest tests/normalize/golden
 */

const fs = require('fs');
const path = require('path');

const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'rrpublish');
const EVENTS = ['403664', '405141', '384316', '376606', '405215', '412789'];

// ---------------------------------------------------------------------------
// proxyGet mock: serve the recorded fixture matching each upstream path.
// Mirrors real upstream behaviour (results/config?pid echoes the event
// config without SplitConfig; named details pages 404 for config/splits).
// ---------------------------------------------------------------------------

jest.mock('../../src/services/rrpublish/client', () => ({
  PROXY_SERVER: 'eventoapi.com/v1/rrpublish',
  proxyGet: (rrId, rawPathAndQuery) => global.__fixtureProxyGet(rrId, rawPathAndQuery),
}));

const { normalizedConfig, normalizedList, normalizedAthlete } =
  require('../../src/services/rrpublish/normalize');

function fixtureFile(rrId, name) {
  const p = path.join(FIXTURE_ROOT, rrId, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function eventIndex(rrId) {
  return JSON.parse(fixtureFile(rrId, 'index.json'));
}

global.__fixtureProxyGet = async (rrId, rawPathAndQuery) => {
  const [p, query = ''] = rawPathAndQuery.split('?');
  const q = Object.fromEntries(new URLSearchParams(query));
  const serve = (name) => {
    const body = fixtureFile(rrId, name);
    return body == null
      ? { status: 404, contentType: 'text/plain', body: 'not found', cache: 'MISS' }
      : { status: 200, contentType: 'application/json', body, cache: 'MISS' };
  };

  if (p.endsWith('/view')) return serve(`athlete-${q.pid}-view.json`);
  if (p.endsWith('/splits') && q.pid) return serve(`athlete-${q.pid}-splits.json`);
  if (p.endsWith('/config')) {
    if (q.pid) {
      // Only RRPublish/data serves the per-athlete SplitConfig variant
      return p.startsWith('RRPublish/data')
        ? serve(`athlete-${q.pid}-config.json`)
        : { status: 404, contentType: 'text/plain', body: 'not found', cache: 'MISS' };
    }
    if (p === 'results/config') return serve('config.json');
    if (p === 'participants/config') return serve('participants-config.json');
    if (p === 'live/config') return serve('live-config.json');
    if (p === 'RRPublish/data/config') {
      return (q.page || 'results') === 'results'
        ? serve('legacy-config.json')
        : { status: 404, contentType: 'text/plain', body: 'not found', cache: 'MISS' };
    }
  }
  if (p.endsWith('/list')) {
    if (q.page === 'participants') return serve('participants-list.json');
    if (q.page === 'live') return serve('live-list.json');
    const idx = eventIndex(rrId);
    const match = idx.lists.find((l) => l.listname === q.listname);
    return serve(match ? match.file : 'list-0.json');
  }
  return { status: 404, contentType: 'text/plain', body: 'not found', cache: 'MISS' };
};

// ---------------------------------------------------------------------------

function checkGolden(rrId, name, actual) {
  const dir = path.join(FIXTURE_ROOT, rrId, 'expected');
  const file = path.join(dir, `${name}.json`);
  const serialized = JSON.stringify(actual, null, 2);
  if (process.env.UPDATE_GOLDENS) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, serialized);
    return;
  }
  expect(fs.existsSync(file)).toBe(true);
  expect(JSON.parse(serialized)).toEqual(JSON.parse(fs.readFileSync(file, 'utf8')));
}

describe.each(EVENTS)('event %s', (rrId) => {
  test('config', async () => {
    const res = await normalizedConfig(rrId, { lang: 'en' });
    expect(res.status).toBe(200);
    expect(res.body.schemaVersion).toBe(1);
    expect(res.body.lists.length).toBeGreaterThan(0);
    checkGolden(rrId, 'config', res.body);
  });

  test('first list', async () => {
    const res = await normalizedList(rrId, { tab: 'results', lang: 'en' });
    expect(res.status).toBe(200);
    const rows = res.body.groups.flatMap((g) => g.rows);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.name).not.toBe('');
      expect(typeof r.position).toBe('number');
    }
    checkGolden(rrId, 'list-0', res.body);
  });

  test('athletes', async () => {
    for (const a of eventIndex(rrId).athletes) {
      const res = await normalizedAthlete(rrId, { pid: a.pid, lang: 'en' });
      expect(res.status).toBe(200);
      expect(res.body.schemaVersion).toBe(1);
      checkGolden(rrId, `athlete-${a.pid}`, res.body);
    }
  });

  test('participants list when published', async () => {
    if (!fixtureFile(rrId, 'participants-list.json')) return;
    const res = await normalizedList(rrId, { tab: 'participants', lang: 'en' });
    expect(res.status).toBe(200);
    checkGolden(rrId, 'participants', res.body);
  });
});
