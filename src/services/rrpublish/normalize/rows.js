/**
 * Row extraction — port of RRPublish.js processPiece via iOS
 * RRResultsController.extractRows / parseRow / loadGroupMore / findGroupArray.
 *
 * The raw `data` node is either an array of row-arrays, or a map of group key
 * → nested node (one level per Grouping order). Output is a list of groups:
 *   { key, labels[], rows[], total, shown, hasMore }
 * Ungrouped lists yield one group with key null. Positions are computed per
 * group in row order (RRPublish.js renders them, the API rank is not used).
 */

const { str, toInt } = require('./util');
const { i18n, groupLabel } = require('./i18n');
const { IGNORE } = require('./filters');

const TIME_SHAPED = /^\d{0,2}:?\d{1,2}:\d{2}/;

/**
 * One participant row-array → normalized row.
 * ctx: { dataFields, nameIdx, resultIdx, lang }
 */
function parseRow(row, ctx) {
  const { dataFields, nameIdx, resultIdx, lang } = ctx;
  const s = (i) => (i >= 0 && i < row.length ? str(row[i]) : '');
  // BIB / ID are RaceResult API constants in DataFields (not organiser
  // labels) — resolve by exact name, fall back to the 0/1 convention.
  const bibIdx = dataFields.findIndex((df) => str(df).toLowerCase() === 'bib');
  const pidIdx = dataFields.findIndex((df) => str(df).toLowerCase() === 'id');
  const p = {
    bib: s(bibIdx !== -1 ? bibIdx : 0),
    pid: s(pidIdx !== -1 ? pidIdx : 1),
    name: i18n(s(nameIdx), lang),
    time: s(resultIdx),
    videoLink: '',
    fields: [],
  };
  if (p.time === '') {
    // regex-scan from the end for a time-shaped value
    for (let i = row.length - 1; i >= 2; i--) {
      if (TIME_SHAPED.test(s(i))) { p.time = s(i); break; }
    }
  }
  for (let i = 2; i < dataFields.length; i++) {
    const v = i18n(s(i), lang);
    if (v !== '') p.fields.push({ expr: dataFields[i], value: v });
    // Video column: a DataField named like "[...Video...]".
    const df = str(dataFields[i]);
    if (df.startsWith('[') && df.toLowerCase().includes('video') && s(i) !== '') {
      p.videoLink = s(i);
    }
  }
  return p;
}

/**
 * Walk the data node into normalized groups.
 * ctx: parseRow ctx + { groupFilter: string[], leadersMode: bool }
 */
function extractGroups(node, ctx) {
  const groups = [];
  walk(node, ctx, 0, '', [], groups);
  return groups;
}

function walk(node, ctx, gfIdx, groupKey, labels, out) {
  if (Array.isArray(node)) {
    const rows = [];
    let total = null;
    for (const row of node) {
      if (!Array.isArray(row)) continue;
      if (row.length === 1) {
        total = toInt(row[0], 0);           // group-total sentinel
      } else if (row.length >= 3) {
        const p = parseRow(row, ctx);
        p.position = rows.length + 1;
        rows.push(p);
      }
    }
    const shown = rows.length;
    if (total == null || total < shown) total = shown;
    out.push({
      key: groupKey === '' ? null : groupKey,
      labels,
      rows,
      total,
      shown,
      // The client only offers "show more" for leader-mode groups — full
      // lists arrive complete (the sentinel is absent or matches).
      hasMore: !!(ctx.leadersMode && groupKey !== '' && total > shown),
    });
    return;
  }
  if (node && typeof node === 'object') {
    const gf = ctx.groupFilter || [];
    let idx = gfIdx;
    while (idx < gf.length && gf[idx] === IGNORE) idx += 1;
    // Suppress the header label when this level is an actively-filtered grouping.
    const filterSet = idx < gf.length && gf[idx] !== '' && gf[idx] !== IGNORE;
    for (const k of Object.keys(node).sort()) {
      const nextLabels = filterSet ? labels : [...labels, groupLabel(k, ctx.lang)];
      walk(node[k], ctx, idx + 1, k, nextLabels, out);
    }
  }
}

/** Depth-first search for a group's row array by its raw key. */
function findGroupArray(node, key) {
  if (node == null || typeof node !== 'object' || Array.isArray(node)) return null;
  for (const [k, v] of Object.entries(node)) {
    if (k === key) {
      if (Array.isArray(v)) return v.filter((r) => Array.isArray(r));
      return null;
    }
    const found = findGroupArray(v, key);
    if (found) return found;
  }
  return null;
}

/**
 * Build ONE group from a `r=group` response (port of loadGroupMore).
 * RR returns the group PREFIX (rows 1..l) — sometimes ignoring l entirely
 * (seen: asked 510, got 4994) — so rows are capped to `limit` server-side.
 */
function extractGroupMore(dataNode, groupKey, limit, ctx) {
  // Some lists answer r=group with the rows array directly (no map wrapper).
  const arr = Array.isArray(dataNode)
    ? dataNode.filter((r) => Array.isArray(r))
    : findGroupArray(dataNode, groupKey);
  if (!arr) return null;
  const rows = [];
  let total = 0;
  let participantCount = 0;
  for (const row of arr) {
    if (row.length === 1) {
      total = toInt(row[0], total);
    } else if (row.length >= 3) {
      participantCount += 1;
      if (rows.length < limit) {
        const p = parseRow(row, ctx);
        p.position = rows.length + 1;
        rows.push(p);
      }
    }
  }
  total = Math.max(total, participantCount);
  return {
    key: groupKey,
    labels: [groupLabel(groupKey, ctx.lang)],
    rows,
    total,
    shown: rows.length,
    hasMore: rows.length < total,
  };
}

module.exports = { parseRow, extractGroups, extractGroupMore, findGroupArray };
