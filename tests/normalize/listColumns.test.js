/**
 * Which list column is the athlete and which is the result — checked against
 * the real list formats of ten timer events (Chrono Consult + XTERRA Moorea),
 * recorded 21 Nov 2026 through the production proxy. Each fixture is the
 * list's Fields, its DataFields and the first row; `expected` was read off
 * the event's own results page.
 *
 * These exist because the column rules are heuristics: a fix for one event
 * (Race Across Spain) put the bib in the name column on another (L'Enfer des
 * Canaux) and no test noticed. A rule change that moves any of these fails
 * here. Add an event: drop its {Fields, DataFields, row, expected} in
 * tests/fixtures/rrpublish-lists/{rrId}.json.
 */

const fs = require('fs');
const path = require('path');
const { extractFieldMetadata } = require('../../src/services/rrpublish/normalize/columns');

const DIR = path.join(__dirname, '..', 'fixtures', 'rrpublish-lists');
const fixtures = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))
  .map((f) => ({ rrId: f.replace('.json', ''), ...JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) }));

test('fixtures are present', () => {
  expect(fixtures.length).toBeGreaterThanOrEqual(10);
});

test.each(fixtures.map((f) => [`${f.rrId} ${f.event}`, f]))('%s', (_label, f) => {
  const meta = extractFieldMetadata(f.list, f.DataFields, 'en', f.row);
  expect({
    name: f.row[meta.nameIdx],
    result: f.row[meta.resultIdx],
    resultLabel: meta.resultFieldLabel,
  }).toEqual(f.expected);
});
