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

test('Belfast 5K: splits, certificate PDF, photographer photos in RR order', async () => {
  const { body } = await normalizedAthlete('434149', { pid: '2973' });
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
  const { body } = await normalizedAthlete('423397', { pid: '1406' });
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
  const { body } = await normalizedAthlete('434234', { pid: '101' });
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
