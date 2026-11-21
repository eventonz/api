/**
 * Athlete page sections: RR view Elements → ordered typed sections.
 * Fixtures are live /view streams recorded 21 Nov 2026:
 *   434149 Belfast 5K (Popup Races) — splits, certificate, sponsor photos
 *   423397 Trails du Sancy — course progress, ITRA palmarès, links, comments
 *   434234 XTERRA Tahiti — stat tiles, rankings, legs, rank chart
 */

jest.mock('../../src/services/rrpublish/client', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..', 'fixtures', 'rrpublish-sse');
  const read = (rrId, name) => {
    const p = path.join(root, String(rrId), name);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  };
  return {
    PROXY_SERVER: 'eventoapi.com/v1/rrpublish',
    proxyGet: async (rrId, rawPathAndQuery) => {
      const [p, query = ''] = rawPathAndQuery.split('?');
      const pid = new URLSearchParams(query).get('pid');
      let body = null;
      if (p === 'results/config') body = read(rrId, 'config.json');
      else if (p.endsWith('/view')) body = read(rrId, `athlete-${pid}-view.sse`);
      return body == null
        ? { status: 404, contentType: 'text/plain', body: 'not found' }
        : { status: 200, contentType: 'application/json', body };
    },
  };
});

const { normalizedAthlete } = require('../../src/services/rrpublish/normalize');
const { buildSections, unknownTypes, htmlParts } =
  require('../../src/services/rrpublish/normalize/sections');

const types = (body) => body.sections.map((s) => s.type);
const one = (body, type) => body.sections.find((s) => s.type === type);

describe('what the app is sent', () => {
  // Evento draws its own page; only these ride along from the organiser's layout.
  test('trail page keeps splits, ITRA link and past results; drops progress, text, comments', async () => {
    const { body } = await normalizedAthlete('423397', { pid: '1406' });
    const kept = new Set(types(body));
    expect(kept.has('links')).toBe(true);
    expect(kept.has('entries')).toBe(true);
    for (const t of ['progress', 'comments', 'text', 'stats', 'table', 'chart', 'html']) {
      expect(kept.has(t)).toBe(false);
    }
    expect(body.sourceUrl).toMatch(/^https:\/\/my\.raceresult\.com\/423397\/[^?]+\?pid=1406/);
  });

  test('triathlon page drops stat tiles and chart', async () => {
    const { body } = await normalizedAthlete('434234', { pid: '101' });
    expect(types(body).filter((t) => t === 'stats' || t === 'chart')).toEqual([]);
  });

  test('Belfast keeps splits, certificate and photos', async () => {
    const { body } = await normalizedAthlete('434149', { pid: '2973' });
    expect(types(body)).toEqual(['splits', 'certificates', 'photos']);
  });
});

test('Belfast 5K: splits, certificate PDF, photographer photos in RR order', async () => {
  const { body } = await normalizedAthlete('434149', { pid: '2973', allSections: true });
  expect(types(body)).toEqual(['text', 'splits', 'certificates', 'photos']);
  expect(one(body, 'splits').title).toBe('Splits');
  expect(one(body, 'certificates').items[0]).toEqual({
    label: 'Finisher Certificate',
    url: 'https://my-aus-1.raceresult.com/434149/details0/certificate/2973/Finisher%20Certificate',
    thumbnail: 'https://my-aus-1.raceresult.com/434149/details0/certificates/thumbnail?name=Finisher%20Certificate',
  });
  expect(one(body, 'photos').items).toHaveLength(5);
  expect(body.brand.color).toBe('#b3191f');
  expect(body.unmapped).toEqual([]);
});

test('Trail: course progress, palmarès entries, link with logo, comments outside the tree', async () => {
  const { body } = await normalizedAthlete('423397', { pid: '1406', allSections: true });
  const progress = one(body, 'progress');
  expect(progress.points).toHaveLength(6);
  expect(progress.points[5]).toMatchObject({ distanceM: 59399, reached: true });
  expect(one(body, 'links').items[0]).toMatchObject({
    label: 'Profil ITRA', url: 'https://itra.run/RunnerSpace/2365397',
  });
  // single unlabelled multi-line list cell → collapsible entries, not a one-cell table
  const entries = one(body, 'entries');
  expect(entries.items[0].title).toContain('UTMB');
  expect(entries.items[0].lines).toEqual(['25/08/2026', 'Place : 14 / Temps : 1:25:14']);
  expect(types(body)).not.toContain('table');
  expect(one(body, 'comments').items.length).toBeGreaterThan(0);
});

test('Triathlon: titled fields group into stat tiles; splitrank chart', async () => {
  const { body } = await normalizedAthlete('434234', { pid: '101', allSections: true });
  const stats = body.sections.filter((s) => s.type === 'stats');
  expect(stats).toHaveLength(2);
  expect(stats[0].items[0]).toEqual({ label: 'TempsArrivée', value: '4:26:40' });
  expect(stats[1].title).toBe('Rankings');
  expect(stats[1].items.map((i) => i.label)).toEqual(['Total', 'Féminin', '30-34 W']);
  expect(one(body, 'legs').rows).toHaveLength(5);
  const chart = one(body, 'chart');
  expect(chart.chart).toBe('splitrank');
  expect(chart.points.every((p) => Number.isInteger(p.rank))).toBe(true);
});

test('unknown element types are skipped and reported', () => {
  const els = [{ Type: 'hologram', Config: {} }, { Type: 'text', Config: { Text: 'Hi' } }];
  expect(buildSections(els, {}, { lang: 'en' })).toEqual([
    { type: 'text', role: 'body', align: 'left', text: 'Hi' },
  ]);
  expect(unknownTypes(els)).toEqual(['hologram']);
});

test('html element reduces to text, links and linked images', () => {
  const parts = htmlParts('<p>Click &amp; share</p><p><a href="https://x.test/a"><img src="https://x.test/i.png"></a>'
    + ' <a href="https://x.test/b">More</a></p>');
  expect(parts).toEqual({
    text: 'Click & share\nMore',
    links: [{ label: 'More', url: 'https://x.test/b' }],
    images: [{ url: 'https://x.test/i.png', link: 'https://x.test/a' }],
  });
});

describe('organiser rows and labels (Race Across Spain shapes)', () => {
  const { i18n } = require('../../src/services/rrpublish/normalize/i18n');
  const { extractFieldMetadata } = require('../../src/services/rrpublish/normalize/columns');
  const field = (title, value) => ({ Type: 'field',
    Config: { Field: value, Title: title, DisplayMode: 'titleabove' } });

  test('3-letter lead language code decodes', () => {
    const label = '{CAT:Nom|DE:Name|EN:Name|ES:Nombre|FR:Nom}';
    expect(i18n(label, 'en')).toBe('Name');
    expect(i18n(label, 'fr')).toBe('Nom');
    expect(i18n('{EN:Finish|DE:Ziel}', 'de')).toBe('Ziel');
  });

  test('stats keep the flexbox rows; "--" tiles and trailing colons go', () => {
    const els = [{ Type: 'box', Config: { Label: 'Ranking' }, Children: [
      { Type: 'flexbox', Children: [field('Overall Ranking', '1'), field('Gender Ranking', '2')] },
      { Type: 'flexbox', Children: [field('Gap Leader', '--'), field('Last update:', 'Arrivé')] },
    ] }];
    const [stats] = buildSections(els, {}, { lang: 'en' });
    expect(stats.title).toBe('Ranking');
    expect(stats.rows).toEqual([
      [{ label: 'Overall Ranking', value: '1' }, { label: 'Gender Ranking', value: '2' }],
      [{ label: 'Last update', value: 'Arrivé' }],
    ]);
    expect(stats.items).toHaveLength(3);
    expect(JSON.stringify(stats)).not.toContain('_row');
  });

  test('lone pinned name + hidden columns → the columns left showing are the layout', () => {
    const dataFields = ['BIB', 'ID', 'Arrow', 'RankExpr', 'AfficherNom', 'Club', 'TotalTime'];
    const fields = [
      { Expression: 'Arrow', Label: '', ResponsiveHide: 1 },
      { Expression: 'RankExpr', Label: 'Rank', ResponsiveHide: 0 },
      { Expression: 'AfficherNom', Label: 'Name', ResponsiveHide: -1 },
      { Expression: 'Club', Label: 'Club', ResponsiveHide: 1 },
      { Expression: 'TotalTime', Label: 'Total', ResponsiveHide: 0 },
    ];
    const meta = extractFieldMetadata({ Fields: fields }, dataFields, 'en');
    expect([meta.rankIdx, meta.nameIdx, meta.resultIdx]).toEqual([3, 4, 6]);
    expect(meta.hasRank).toBe(true);
    expect(meta.resultFieldLabel).toBe('Total');
  });
});
