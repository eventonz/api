/**
 * Splits/legs normalization — port of iOS RRResultsController's
 * splitConfigFromElements / inferColumnBits / normaliseSplitRows and
 * RRSplitTable's column gating, pruning and segment-time derivation.
 */

const { str, parseSeconds, formatSeconds } = require('./util');
const { i18n } = require('./i18n');

/**
 * Reverse-map the modern view Elements into the legacy 11-bit SplitConfig
 * so one pipeline serves both generations.
 */
function splitConfigFromElements(elements, hasSplits, hasLegs) {
  const bits = new Array(11).fill('0');
  const cfg = {};
  for (const el of Array.isArray(elements) ? elements : []) {
    const type = str(el?.Type).toLowerCase();
    if (type.includes('legs')) bits[0] = '1';
    if (type.includes('splits')) bits[1] = '1';
    if (el?.Config && typeof el.Config === 'object') {
      for (const [k, v] of Object.entries(el.Config)) {
        if (!(k in cfg)) cfg[k] = v;              // first occurrence wins
      }
    }
  }
  if (hasLegs) bits[0] = '1';
  if (hasSplits) bits[1] = '1';
  const flagBit = [['ShowOverallRank', 3], ['ShowGenderRank', 4], ['ShowAgeGroupRank', 5],
    ['ShowTOD', 6], ['ShowGunTime', 7], ['ShowChipTime', 8], ['ShowSectorTime', 9],
    ['ShowPace', 10]];
  for (const [flag, bit] of flagBit) {
    if (cfg[flag] === true) bits[bit] = '1';
  }
  return bits.join('');
}

/**
 * Modern views often declare NO Show* flags in their elements (plain
 * box/columns layouts) — every column bit stays 0 and the split table would
 * prune fully-populated TOD/Gun/Chip/rank columns. When no column bit
 * survived the element scan, infer them from the data itself.
 */
function inferColumnBits(sc, splits, legs) {
  const padded = sc.length >= 11 ? sc : sc + '0'.repeat(11 - sc.length);
  const bits = padded.split('');
  if (bits.slice(2).includes('1')) return sc;
  const rows = [...splits, ...legs];
  const any = (key) => rows.some((r) => {
    const v = str(r?.[key]);
    return v !== '' && v !== '-1' && v !== '<null>';
  });
  if (any('RO')) bits[3] = '1';
  if (any('RG')) bits[4] = '1';
  if (any('RA')) bits[5] = '1';
  if (any('TOD')) bits[6] = '1';
  if (any('Gun')) bits[7] = '1';
  if (any('Chip')) bits[8] = '1';
  if (any('Sector')) bits[9] = '1';
  if (any('Speed')) bits[10] = '1';
  return bits.join('');
}

/** `Exists` is an integer 1/0, NOT a bool. `-1` rank = "no rank" sentinel. */
function normaliseSplitRows(rowsIn, dropMissing) {
  const out = [];
  for (const row of Array.isArray(rowsIn) ? rowsIn : []) {
    const exists = row?.Exists;
    const present = exists === true || str(exists ?? '1') === '1';
    if (dropMissing && !present) continue;
    const r = { ...row };
    for (const k of ['RO', 'RG', 'RA']) {
      if (str(r[k]) === '-1') r[k] = '';
    }
    out.push(r);
  }
  return out;
}

/** Bitmask → named booleans for the client. */
function showFlags(sc) {
  const bit = (i) => sc.length > i && sc[i] === '1';
  return {
    legs: bit(0),
    splits: bit(1),
    overallRank: bit(3),
    genderRank: bit(4),
    ageGroupRank: bit(5),
    tod: bit(6),
    gun: bit(7),
    chip: bit(8),
    sector: bit(9),
    pace: bit(10),
  };
}

/** Trailing "." stripped (RR pads some values) — RRSplitTable.value port. */
const cellValue = (row, key) => str(row?.[key]).replace(/\.$/, '');

/**
 * Bit-gated time/rank columns, pruned to keys that actually hold values
 * (RRSplitTable timeColumns / rankColumns / prune port).
 */
function resolveColumns(rows, sc) {
  const bit = (i) => sc.length > i && sc[i] === '1';
  const timeCandidates = [
    ['Chip', 'Race time', bit(8)], ['TOD', 'TOD', bit(6)], ['Time', 'Time', true],
    ['Speed', 'Speed', bit(10)], ['Behind', 'Behind', true], ['Gun', 'Gun', bit(7)],
    ['Sector', 'Sector', bit(9)],
  ];
  const rankCandidates = [
    ['RO', 'Overall', bit(3)], ['RG', 'Gender', bit(4)], ['RA', 'Category', bit(5)],
  ];
  const prune = (cands) => cands
    .filter(([, , show]) => show)
    .filter(([key]) => rows.some((r) => str(r?.[key]) !== ''))
    .map(([key, label]) => ({ key, label }));
  return { time: prune(timeCandidates), rank: prune(rankCandidates) };
}

/**
 * Derived display rows (RRSplitTable.splitRows port): per-point segment time
 * (diff of the primary cumulative), places gained/lost from RO, and the raw
 * per-column values.
 */
function deriveRows(rows, columns, lang) {
  const timeKeys = columns.time.map((c) => c.key);
  const primary = ['Chip', 'Time', 'Gun'].find((k) => timeKeys.includes(k)) || timeKeys[0] || null;
  const times = rows.map((r) => (primary ? cellValue(r, primary) : ''));
  const secs = times.map((t) => parseSeconds(t));
  const ranks = rows.map((r) => {
    const v = cellValue(r, 'RO');
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? null : n;
  });
  return rows.map((row, i) => {
    let segment = null;
    if (i > 0 && secs[i] != null && secs[i - 1] != null && secs[i] > secs[i - 1]) {
      segment = formatSeconds(secs[i] - secs[i - 1]);
    }
    let delta = null;
    if (i > 0 && ranks[i] != null && ranks[i - 1] != null) delta = ranks[i - 1] - ranks[i];
    const values = {};
    for (const c of [...columns.time, ...columns.rank]) {
      values[c.key] = cellValue(row, c.key);
    }
    return {
      name: i18n(str(row?.Name), lang),
      time: times[i],
      segment,
      delta,
      values,
    };
  });
}

module.exports = {
  splitConfigFromElements, inferColumnBits, normaliseSplitRows,
  showFlags, resolveColumns, deriveRows,
};
