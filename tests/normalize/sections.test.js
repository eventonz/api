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
const { buildSections } = require('../../src/services/rrpublish/normalize/sections');

const types = (body) => body.sections.map((s) => s.type);
const one = (body, type) => body.sections.find((s) => s.type === type);

// Evento draws its own athlete page; from the timer's RaceResult page only
// splits, legs, photos, certificates, links and entries ride along.

test('Belfast 5K: splits, certificate PDF, photographer photos in RR order', async () => {
  const { body } = await normalizedAthlete('434149', { pid: '2973' });
  expect(types(body)).toEqual(['splits', 'certificates', 'photos']);
  expect(one(body, 'splits').title).toBe('Splits');
  expect(one(body, 'certificates').items[0]).toEqual({
    label: 'Finisher Certificate',
    url: 'https://my-aus-1.raceresult.com/434149/details0/certificate/2973/Finisher%20Certificate',
    thumbnail: 'https://my-aus-1.raceresult.com/434149/details0/certificates/thumbnail?name=Finisher%20Certificate',
  });
  expect(one(body, 'photos').items).toHaveLength(5);
  expect(body.brand.color).toBe('#b3191f');
});

test('Trail: ITRA link with logo and palmarès entries; course map, text and comments are not sent', async () => {
  const { body } = await normalizedAthlete('423397', { pid: '1406' });
  expect(types(body)).toEqual(expect.arrayContaining(['splits', 'links', 'entries']));
  expect(one(body, 'links').items[0]).toMatchObject({
    label: 'Profil ITRA', url: 'https://itra.run/RunnerSpace/2365397',
  });
  // single unlabelled multi-line list cell → collapsible entries
  const entries = one(body, 'entries');
  expect(entries.items[0].title).toContain('UTMB');
  expect(entries.items[0].lines).toEqual(['25/08/2026', 'Place : 14 / Temps : 1:25:14']);
  // contest _ list id _ details page _ pid — RRPublish's own athlete fragment
  expect(body.sourceTag).toMatch(/^\d+_[0-9A-F]{6}_results-details_1406$/);
});

test('Triathlon: legs and splits only — stat tiles and the rank chart stay on the timer\'s page', async () => {
  const { body } = await normalizedAthlete('434234', { pid: '101' });
  expect(one(body, 'legs').rows).toHaveLength(5);
  expect(types(body).every((t) => ['splits', 'legs', 'photos', 'certificates', 'links', 'entries'].includes(t))).toBe(true);
});

test('elements the app does not mirror produce nothing; a box title lands on what it contains', () => {
  const els = [
    { Type: 'hologram', Config: {} },
    { Type: 'text', Config: { Text: 'Hi' } },
    { Type: 'field', Config: { Field: '1', Title: 'Rank', DisplayMode: 'titleabove' } },
    { Type: 'box', Config: { Label: '{EN:Timing points|FR:Passages}' }, Children: [{ Type: 'splits' }] },
  ];
  const splits = { columns: { time: [], rank: [] }, rows: [{ name: 'Finish', time: '1:00:00' }] };
  expect(buildSections(els, {}, { lang: 'en', splits })).toEqual([
    { type: 'splits', ...splits, title: 'Timing points' },
  ]);
});

test('an ordinary embedded table is not entries', () => {
  const lists = { Laps: { DataFields: ['Lap', 'Time'], List: { Fields: [
    { Expression: 'Lap', Label: 'Lap' }, { Expression: 'Time', Label: 'Time' }] },
  Data: [['1', '5:00'], ['2', '5:10']] } };
  expect(buildSections([{ Type: 'list', Config: { List: 'Laps' } }], {}, { lang: 'en', lists })).toEqual([]);
});

describe('labels and list columns (Race Across Spain shapes)', () => {
  const { i18n } = require('../../src/services/rrpublish/normalize/i18n');
  const { extractFieldMetadata } = require('../../src/services/rrpublish/normalize/columns');
  test('3-letter lead language code decodes', () => {
    const label = '{CAT:Nom|DE:Name|EN:Name|ES:Nombre|FR:Nom}';
    expect(i18n(label, 'en')).toBe('Name');
    expect(i18n(label, 'fr')).toBe('Nom');
    expect(i18n('{EN:Finish|DE:Ziel}', 'de')).toBe('Ziel');
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

describe('list name column (timers pin columns that are not the name)', () => {
  const { extractFieldMetadata } = require('../../src/services/rrpublish/normalize/columns');
  const f = (Expression, Label, ResponsiveHide = 0) => ({ Expression, Label, ResponsiveHide });

  test("lone time anchor stays result-only: name by pattern, not the bib (L'Enfer des Canaux)", () => {
    const df = ['BIB', 'ID', 'OuStatut([ClassementGénéral.p])', 'AfficherNom', 'CLUB', 'TIME1', 'GapTimeTop(1)'];
    const meta = extractFieldMetadata({ Fields: [
      f(df[2], 'Pos.'), f('BIB', 'Dossard'), f('AfficherNom', 'Nom Prénom'), f('CLUB', 'Club', 1),
      f('TIME1', 'Temps', -1), f(df[6], 'Ecart'),
    ] }, df, 'en');
    expect(meta.nameIdx).toBe(3);
    expect(meta.resultIdx).toBe(5);
    expect(meta.resultFieldLabel).toBe('Temps');
  });

  test('laps + time pinned: the team column is the name, not the lap count (24 Heures Vélo)', () => {
    const df = ['BIB', 'ID', 'RANK', 'ucase([LASTNAME])', 'ToursTotal', 'TIME'];
    const meta = extractFieldMetadata({ Fields: [
      f('RANK', 'Pos.'), f('BIB', 'Num.'), f(df[3], 'Team'), f('ToursTotal', 'Tours', -1), f('TIME', 'Temps', -1),
    ] }, df, 'en');
    expect(meta.nameIdx).toBe(3);
    expect(meta.resultIdx).toBe(5);
  });

  test('icon + time pinned: the name column wins over the icon (Marseille-Cassis)', () => {
    const df = ['BIB', 'ID', 'RANK', 'AfficherNom', 'Icone("stats")', 'OuStatut([Finish])'];
    const meta = extractFieldMetadata({ Fields: [
      f('RANK', 'Rank'), f('BIB', 'Bib'), f('AfficherNom', 'Name'), f(df[4], 'Stats', -1), f(df[5], 'Time', -1),
    ] }, df, 'en');
    expect(meta.nameIdx).toBe(3);
    expect(meta.resultIdx).toBe(5);
  });
});
