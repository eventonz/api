const { parseSeconds, formatSeconds } = require('../../src/services/rrpublish/normalize/util');
const { extractFieldMetadata } = require('../../src/services/rrpublish/normalize/columns');
const { buildFilterMenus } = require('../../src/services/rrpublish/normalize/filters');
const { extractGroups, extractGroupMore } = require('../../src/services/rrpublish/normalize/rows');
const { classifyFields } = require('../../src/services/rrpublish/normalize/athleteInfo');
const splits = require('../../src/services/rrpublish/normalize/splits');
const { isHyrox, hyroxSteps } = require('../../src/services/rrpublish/normalize/hyrox');

describe('time parsing', () => {
  test('h:mm:ss', () => expect(parseSeconds('1:02:33')).toBe(3753));
  test('mm:ss', () => expect(parseSeconds('52:10')).toBe(3130));
  test('decimal fraction after comma ignored', () => expect(parseSeconds('52:10,3')).toBe(3130));
  test('non-time returns null', () => expect(parseSeconds('4:56 min/km')).toBeNull());
  test('empty returns null', () => expect(parseSeconds('')).toBeNull());
  test('format short', () => expect(formatSeconds(150)).toBe('2:30'));
  test('format long', () => expect(formatSeconds(3753)).toBe('1:02:33'));
});

describe('extractFieldMetadata', () => {
  const dataFields = ['BIB', 'ID', 'Rank', 'DisplayName', 'Club', 'Time'];
  const mk = (expr, label, rh = -1, preview = false) => (
    { Expression: expr, Label: label, ResponsiveHide: rh, PreviewOnly: preview });

  test('three anchors → rank/name/result', () => {
    const meta = extractFieldMetadata(
      { Fields: [mk('rank', 'Pos'), mk('displayname', 'Name'), mk('time', 'Time')] },
      dataFields, 'en');
    expect(meta).toMatchObject({ rankIdx: 2, nameIdx: 3, resultIdx: 5, resultFieldLabel: 'Time' });
    expect(meta.fieldLabels).toEqual({ Rank: 'Pos', DisplayName: 'Name', Time: 'Time' });
  });

  test('ResponsiveHide != -1 fields feed labels but not anchors', () => {
    const meta = extractFieldMetadata(
      { Fields: [mk('club', 'Club', 2), mk('time', 'Time')] }, dataFields, 'en');
    expect(meta.fieldLabels.Club).toBe('Club');
    expect(meta.resultIdx).toBe(5);      // only Time anchored
    expect(meta.nameIdx).toBe(3);        // name-pattern fallback → DisplayName
  });

  test('no anchors → last DataField result + pattern name', () => {
    const meta = extractFieldMetadata({ Fields: [] }, dataFields, 'en');
    expect(meta).toMatchObject({ rankIdx: 2, nameIdx: 3, resultIdx: 5, resultFieldLabel: 'Time' });
  });

  test('PreviewOnly excluded from anchors', () => {
    const meta = extractFieldMetadata(
      { Fields: [mk('rank', 'Pos', -1, true), mk('time', 'Time')] }, dataFields, 'en');
    expect(meta.resultIdx).toBe(5);
    expect(meta.rankIdx).toBe(2);
  });
});

describe('buildFilterMenus', () => {
  test('slots, menus, ignore and type-2 default', () => {
    const listFormat = {
      Orders: [
        { Grouping: 1 },                                        // slot 0, no menu
        { Grouping: 2, GroupFilterLabel: 'Gender' },            // slot 1, menu
        { Grouping: 0 },                                        // no slot
        { Grouping: 3, GroupFilterLabel: 'Category' },          // slot 2, menu + ignore
      ],
    };
    const gfs = [
      { Values: ['A'] },
      { Values: ['M', 'F'], Type: 0, Value: 'M' },
      { Values: ['U20', 'Sen'], Type: 2 },
    ];
    const { menus, groupFilter } = buildFilterMenus(listFormat, gfs, 'en');
    expect(menus).toHaveLength(2);
    expect(menus[0]).toMatchObject({ slot: 1, label: 'Gender', showAll: true, showIgnore: false, selected: 'M' });
    expect(menus[1]).toMatchObject({ slot: 2, showIgnore: true, selected: '<Ignore>' });
    expect(groupFilter).toEqual(['', 'M', '<Ignore>']);
  });
});

describe('extractGroups', () => {
  const ctx = {
    dataFields: ['BIB', 'ID', 'Rank', 'Name', 'Time'],
    nameIdx: 3, resultIdx: 4, lang: 'en', groupFilter: [], leadersMode: true,
  };
  const row = (bib, name, time) => [bib, `p${bib}`, '1', name, time];

  test('grouped map → sorted groups with labels, positions, footer total', () => {
    const data = {
      '#2_Women': [row('2', 'B', '2:00:00'), ['40']],
      '#1_Men': [row('1', 'A', '1:00:00'), row('3', 'C', '1:10:00'), ['120']],
    };
    const groups = extractGroups(data, ctx);
    expect(groups.map((g) => g.key)).toEqual(['#1_Men', '#2_Women']);
    expect(groups[0].labels).toEqual(['Men']);
    expect(groups[0].rows.map((r) => r.position)).toEqual([1, 2]);
    expect(groups[0]).toMatchObject({ total: 120, shown: 2, hasMore: true });
    expect(groups[1]).toMatchObject({ total: 40, shown: 1, hasMore: true });
  });

  test('ungrouped array → one anonymous complete group', () => {
    const groups = extractGroups([row('1', 'A', '1:00:00')], { ...ctx, leadersMode: false });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: null, labels: [], total: 1, hasMore: false });
  });

  test('<Ignore> slot skipped, filtered level suppresses labels', () => {
    const data = { '#1_M': { '#1_Sen': [row('1', 'A', '1:00:00')] } };
    const filtered = extractGroups(data, { ...ctx, groupFilter: ['<Ignore>', 'Sen'] });
    // slot 0 ignored → outer level maps to slot 1 which is actively filtered
    // → its label suppressed; the deeper level still labels itself
    expect(filtered[0].labels).toEqual(['Sen']);
    const unfiltered = extractGroups(data, { ...ctx, groupFilter: ['<Ignore>', ''] });
    expect(unfiltered[0].labels).toEqual(['M', 'Sen']);
  });

  test('bib/pid resolved by DataField constants not position', () => {
    const swapped = {
      ...ctx, dataFields: ['Rank', 'Name', 'ID', 'BIB', 'Time'], nameIdx: 1, resultIdx: 4,
    };
    const groups = extractGroups([['9', 'A', 'pid7', '42', '1:00:00']], { ...swapped, leadersMode: false });
    expect(groups[0].rows[0]).toMatchObject({ bib: '42', pid: 'pid7' });
  });

  test('time regex fallback scans from the end', () => {
    const groups = extractGroups([['1', 'p1', '3', 'A', '']],
      { ...ctx, resultIdx: 4, leadersMode: false });
    expect(groups[0].rows[0].time).toBe('');
    const g2 = extractGroups([['1', 'p1', '1:23:45', 'A', '']],
      { ...ctx, resultIdx: 4, leadersMode: false });
    expect(g2[0].rows[0].time).toBe('1:23:45');
  });
});

describe('extractGroupMore', () => {
  const ctx = { dataFields: ['BIB', 'ID', 'R', 'Name', 'Time'], nameIdx: 3, resultIdx: 4, lang: 'en' };
  test('caps over-returned rows and reports true total', () => {
    const rows = Array.from({ length: 50 }, (_, i) => [`${i}`, `p${i}`, '1', `A${i}`, '1:00:00']);
    const data = { Contest: { '#1_M': [...rows, ['200']] } };
    const g = extractGroupMore(data, '#1_M', 10, ctx);
    expect(g.shown).toBe(10);
    expect(g.total).toBe(200);
    expect(g.hasMore).toBe(true);
    expect(g.rows[9].position).toBe(10);
  });
  test('sibling groups drilled by exact key', () => {
    const data = { '#1_M': [['1', 'p1', '1', 'A', '1:00:00']], '#2_W': [['2', 'p2', '1', 'B', '2:00:00']] };
    expect(extractGroupMore(data, '#2_W', 10, ctx).rows[0].name).toBe('B');
  });
});

describe('classifyFields', () => {
  const ctx = {
    fieldLabels: { Club: 'Club', Photo: 'Photo', Cert: 'Certificate', Img: 'Image' },
    detailBase: 'https://eventoapi.com/v1/rrpublish/123',
    lang: 'en',
  };
  const row = { name: 'Jane', time: '1:00:00' };
  test('identity/empty/sentinel skipped, text kept', () => {
    const out = classifyFields([
      { expr: 'ID', value: '7' }, { expr: 'BIB2', value: '42' },
      { expr: 'Club', value: 'Harriers' }, { expr: 'X', value: '-' },
      { expr: 'Y', value: 'Jane' },
    ], row, ctx);
    expect(out).toEqual([{ type: 'text', label: 'Club', value: 'Harriers' }]);
  });
  test('img relative resolves against detailBase', () => {
    const out = classifyFields([{ expr: 'Img', value: '[img:/pics/x.jpg]' }], row, ctx);
    expect(out).toEqual([{ type: 'image', label: 'Image', url: 'https://eventoapi.com/v1/rrpublish/123/pics/x.jpg' }]);
  });
  test('raw url and href become links, other brackets dropped', () => {
    const out = classifyFields([
      { expr: 'Photo', value: 'https://x.com/p.jpg' },
      { expr: 'Cert', value: '<a href="https://x.com/c.pdf">PDF</a>' },
      { expr: 'Club', value: '[UDF]' },
    ], row, ctx);
    expect(out).toEqual([
      { type: 'link', label: 'Photo', url: 'https://x.com/p.jpg' },
      { type: 'link', label: 'Certificate', url: 'https://x.com/c.pdf' },
    ]);
  });
  test('unlabeled non-image dropped', () => {
    expect(classifyFields([{ expr: 'Zz', value: 'hello' }], row, ctx)).toEqual([]);
  });
});

describe('splits', () => {
  test('normaliseSplitRows: Exists int/bool, rank -1 sentinel, dropMissing', () => {
    const rows = [
      { Name: 'A', Exists: 1, RO: -1 },
      { Name: 'B', Exists: 0 },
      { Name: 'C', Exists: true, RO: 5 },
    ];
    const kept = splits.normaliseSplitRows(rows, true);
    expect(kept.map((r) => r.Name)).toEqual(['A', 'C']);
    expect(kept[0].RO).toBe('');
    expect(splits.normaliseSplitRows(rows, false)).toHaveLength(3);
    expect(splits.normaliseSplitRows(null, false)).toEqual([]);
  });

  test('splitConfigFromElements maps flags and data presence', () => {
    const sc = splits.splitConfigFromElements(
      [{ Type: 'SplitsElement', Config: { ShowChipTime: true, ShowTOD: true } }], true, false);
    expect(sc).toBe('01000010100');
  });

  test('inferColumnBits only fires when no column bit set', () => {
    const rows = [{ RO: 3, Chip: '1:00:00' }];
    expect(splits.inferColumnBits('11000000000', rows, [])).toBe('11010000100');
    // explicit column bit present → untouched
    expect(splits.inferColumnBits('11000000100', rows, [])).toBe('11000000100');
    // -1 / <null> not treated as data
    expect(splits.inferColumnBits('10000000000', [{ RO: '-1', TOD: '<null>' }], [])).toBe('10000000000');
  });

  test('resolveColumns gates by bits and prunes empty', () => {
    const sc = '01011111011';
    const rows = [{ Chip: '', Gun: '1:00:00', TOD: '06:00:00', RO: 1, RG: '', RA: 2 }];
    const cols = splits.resolveColumns(rows, sc);
    expect(cols.time.map((c) => c.key)).toEqual(['TOD', 'Gun']);
    expect(cols.rank.map((c) => c.key)).toEqual(['RO', 'RA']);
  });

  test('deriveRows computes segments and deltas from primary time', () => {
    const sc = '01011111011';
    const rows = [
      { Name: 'K10', Gun: '1:00:00', RO: 5 },
      { Name: 'K20', Gun: '2:10:30', RO: 3 },
    ];
    const cols = splits.resolveColumns(rows, sc);
    const derived = splits.deriveRows(rows, cols, 'en');
    expect(derived[0]).toMatchObject({ name: 'K10', segment: null, delta: null });
    expect(derived[1]).toMatchObject({ segment: '1:10:30', delta: 2, time: '2:10:30' });
  });
});

describe('hyrox', () => {
  const mk = (name, sector, time) => ({ Name: name, Sector: sector, Time: time });
  test('detection needs 3 hallmark stations', () => {
    expect(isHyrox([mk('SkiErg'), mk('Sled Push'), mk('Wall Balls')])).toBe(true);
    expect(isHyrox([mk('Run 1'), mk('SkiErg')])).toBe(false);
  });
  test('canonical sequence: 16 steps, runs by order, stations by keyword', () => {
    const steps = hyroxSteps([
      mk('Running 1', '4:02', '4:02'),
      mk('1000m SkiErg', '3:55', '7:57'),
      mk('Running 2', '4:10', '12:07'),
      mk('Sled Push', '2:20', '14:27'),
      mk('Roxzone', '', '15:00'),
      mk('Finish', '', '58:00'),
    ]);
    expect(steps).toHaveLength(18); // 16 canonical + 2 extras
    expect(steps[0]).toMatchObject({ kind: 'run', label: 'Run 1', main: '4:02', reached: true });
    expect(steps[1]).toMatchObject({ kind: 'station', label: 'SkiErg', main: '3:55', sub: '7:57' });
    expect(steps[3]).toMatchObject({ label: 'Sled Push', main: '2:20' });
    expect(steps[5]).toMatchObject({ label: 'Sled Pull', reached: false, main: '–' });
    expect(steps[16]).toMatchObject({ kind: 'extra', label: 'Roxzone', main: '15:00' });
    expect(steps[17]).toMatchObject({ kind: 'extra', label: 'Finish' });
  });
});
