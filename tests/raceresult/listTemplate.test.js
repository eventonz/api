const {
  buildListData,
  splitsHash,
  coverageGaps,
  distinctByName,
  normaliseSplits,
} = require('../../src/services/raceresult/listTemplate');
const { renderList, athlete } = require('./rrRender');

// Public my.raceresult.com results/config captured 2026-08-29. Used as the
// second source for coverage checks, and as realistic generator input.
const cfg383237 = require('../fixtures/raceresult/config-383237.json'); // 1 contest, finish only
const cfg381746 = require('../fixtures/raceresult/config-381746.json'); // 2 contests, legs, renamed split
const cfg376606 = require('../fixtures/raceresult/config-376606.json'); // 7 contests sharing names

describe('split normalisation and dedup', () => {
  test('one block per distinct name, not per split row', () => {
    const rows = cfg376606.splits;
    expect(rows.length).toBe(67);
    expect(distinctByName(normaliseSplits(rows)).length).toBe(18);
  });

  test('a name shared across contests collapses to one entry', () => {
    // 376606 has seven contests, each with its own Start and Finish.
    const names = distinctByName(normaliseSplits(cfg376606.splits)).map((s) => s.name);
    expect(names.filter((n) => n === 'Start')).toHaveLength(1);
    expect(names.filter((n) => n === 'Finish')).toHaveLength(1);
  });

  test('renamed timing points are covered — the legacy template missed these', () => {
    // "Spotter" is not one of RaceResult's default Split1..Split100 names, so
    // the hand-maintained template had no block for it and dropped the data.
    for (const cfg of [cfg381746, cfg376606]) {
      const { names } = buildListData(cfg.splits);
      expect(names).toContain('Spotter');
    }
  });

  test('SplitType 9 is treated as a leg', () => {
    const legs = distinctByName(normaliseSplits(cfg381746.splits)).filter((s) => s.isLeg);
    expect(legs.map((l) => l.name).sort()).toEqual(['Leg1', 'Leg2']);
  });

  test('accepts the split names RaceResult actually allows', () => {
    // Verified live on event 154651: [6.7K.Name] resolves to "6.7K", and 15K /
    // 40K / FirstHalf all resolve, so digit-leading and dotted names are fine.
    const rows = ['15K', '6.7K', '40K', 'FirstHalf', 'Announcer']
      .map((Name, i) => ({ Name, SplitType: 0, OrderPos: i }));
    expect(buildListData(rows).names).toEqual(['15K', '6.7K', '40K', 'FirstHalf', 'Announcer']);
  });

  test('rejects names that would break the expression itself', () => {
    for (const bad of ['Finish]', 'Sp[lit', 'Say"what', "It's", 'a;b', '#hash']) {
      expect(() => buildListData([{ Name: bad, SplitType: 0 }]))
        .toThrow(/not valid RaceResult expression tokens/);
    }
  });
});

describe('generated template renders valid JSON', () => {
  const parse = (data, ath) => JSON.parse(renderList(data, ath));

  test('athlete with no data yields only the sentinel', () => {
    const { data } = buildListData(cfg381746.splits);
    const rows = parse(data, athlete({ splits: {} }));
    expect(rows).toEqual([{ Sentinel: true }]);
  });

  test('one row per split the athlete has passed, in course order', () => {
    // The public config fixture carries no OrderPos; real input is v2.splits,
    // which has sort_order. Supply it here so block order is course order.
    const order = { Start: 1, Leg1: 2, Split1: 3, Leg2: 4, Spotter: 5, Finish: 6 };
    const rows381746 = cfg381746.splits.map((s) => ({ ...s, OrderPos: order[s.Name] }));
    const { data } = buildListData(rows381746);
    const rows = parse(data, athlete({
      splits: {
        Start: { OrderPos: 1, ID: 285 },
        Spotter: { OrderPos: 3, ID: 287 },
        Finish: { OrderPos: 4, ID: 288, Overall: 7 },
      },
      lastSplit: 'Finish',
    }));
    const real = rows.filter((r) => !r.Sentinel);
    expect(real.map((r) => r.SplitName)).toEqual(['Start', 'Spotter', 'Finish']);
    expect(real.find((r) => r.SplitName === 'Finish').SplitOverallRank).toBe('7');
  });

  test('RR_SplitID resolves per contest, so a shared name stays correct', () => {
    const { data } = buildListData(cfg381746.splits);
    // Same generated block, two contests, two different RaceResult split ids.
    const c1 = parse(data, athlete({ contest: 1, splits: { Spotter: { OrderPos: 3, ID: 287 } } }));
    const c2 = parse(data, athlete({ contest: 2, splits: { Spotter: { OrderPos: 3, ID: 14 } } }));
    expect(c1.find((r) => r.SplitName === 'Spotter').RR_SplitID).toBe('287');
    expect(c2.find((r) => r.SplitName === 'Spotter').RR_SplitID).toBe('14');
  });

  test('REGRESSION: valid JSON when the first splits have no data', () => {
    // The legacy template decided which block was "first" at render time:
    // Start emitted no comma, Split1 emitted one only if Start had data, and
    // every later block emitted an unconditional comma. With Start and Split1
    // both empty but a later split present, the payload opened `[ , {` and the
    // whole pull failed to parse. The sentinel makes this structural.
    const { data } = buildListData(cfg376606.splits);
    const rows = parse(data, athlete({
      splits: { Split7: { OrderPos: 8, ID: 540 } },
      lastSplit: 'Split7',
    }));
    expect(rows.filter((r) => !r.Sentinel).map((r) => r.SplitName)).toEqual(['Split7']);
  });

  test('push copy appears only on the most recent split', () => {
    const { data } = buildListData(cfg381746.splits);
    const rows = parse(data, athlete({
      splits: { Start: { OrderPos: 1, ID: 285 }, Finish: { OrderPos: 4, ID: 288 } },
      lastSplit: 'Finish',
    })).filter((r) => !r.Sentinel);
    expect(rows.find((r) => r.SplitName === 'Start').Message_en).toBeUndefined();
    expect(rows.find((r) => r.SplitName === 'Finish').Message_en).toBe('push-copy');
  });

  test('pushMessages:false drops the PushMessage UDF entirely', () => {
    const { data } = buildListData(cfg381746.splits, { pushMessages: false });
    expect(data).not.toContain('PushMessage');
    const rows = parse(data, athlete({ splits: { Finish: { OrderPos: 4, ID: 288 } } }));
    expect(rows.filter((r) => !r.Sentinel)).toHaveLength(1);
  });

  test('leg and split records carry the same keys', () => {
    // The legacy template omitted Start/Finish (and push copy) on leg blocks,
    // so leg records arrived with a different shape than split records.
    const { data } = buildListData(cfg381746.splits);
    const rows = parse(data, athlete({
      splits: { Leg1: { OrderPos: 2, ID: 22 }, Finish: { OrderPos: 4, ID: 288 } },
      lastSplit: 'Finish',
    })).filter((r) => !r.Sentinel);
    const leg = rows.find((r) => r.SplitName === 'Leg1');
    const split = rows.find((r) => r.SplitName === 'Finish');
    expect(Object.keys(leg).sort()).toEqual(
      Object.keys(split).filter((k) => !k.startsWith('Message_')).sort()
    );
    expect(leg.Start).toBe(0);
    expect(leg.Finish).toBe(0);
  });

  test('Start and Finish flags are set from the athlete own contest', () => {
    const { data } = buildListData(cfg383237.splits);
    const rows = parse(data, athlete({
      splits: { Finish: { OrderPos: 2, ID: 288 }, Start: { OrderPos: 1, ID: 1 } },
    })).filter((r) => !r.Sentinel);
    expect(rows.find((r) => r.SplitName === 'Finish').Finish).toBe(1);
  });
});

describe('size', () => {
  test('block count matches real splits, not 100 generic slots', () => {
    expect(buildListData(cfg383237.splits).blocks).toBe(1);
    expect(buildListData(cfg381746.splits).blocks).toBe(6);
    expect(buildListData(cfg376606.splits).blocks).toBe(18);
  });
});

describe('splitsHash', () => {
  const rows = cfg381746.splits;

  test('stable across row order', () => {
    expect(splitsHash([...rows].reverse())).toBe(splitsHash(rows));
  });

  test('changes when a split is added', () => {
    const added = [...rows, { ID: 999, Name: 'Split9', Contest: 1, SplitType: 0 }];
    expect(splitsHash(added)).not.toBe(splitsHash(rows));
  });

  test('changes when a split is renamed', () => {
    const renamed = rows.map((r) => (r.ID === 14 ? { ...r, Name: 'Chute' } : r));
    expect(splitsHash(renamed)).not.toBe(splitsHash(rows));
  });
});

describe('coverageGaps', () => {
  test('empty when the list was generated from the same splits', () => {
    const { names } = buildListData(cfg376606.splits);
    expect(coverageGaps(names, cfg376606.splits)).toEqual([]);
  });

  test('reports a split the generated list does not cover', () => {
    const { names } = buildListData(cfg381746.splits);
    const withExtra = [...cfg381746.splits, { ID: 900, Name: 'Turnaround', Contest: 1, SplitType: 0 }];
    expect(coverageGaps(names, withExtra).map((s) => s.name)).toEqual(['Turnaround']);
  });
});
