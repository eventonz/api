/** CSV → canonical stage rows for scripts/post-stages.js (no deps, RFC-4180-ish quoting). */

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === ';' || c === '\t') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

// Header aliases → canonical field names.
const ALIASES = {
  bib: ['bib', 'raceno', 'race_no', 'number', 'team', 'team_bib'],
  stage_no: ['stage_no', 'stage', 'stageno', 'stage_number'],
  stage_name: ['stage_name', 'name'],
  stage_time: ['stage_time', 'time_stage', 'stagetime'],
  stage_rank: ['stage_rank', 'rank', 'stage_pos', 'pos'],
  gc_time: ['gc_time', 'gc', 'overall_time', 'total_time'],
  gc_rank: ['gc_rank', 'gc_pos', 'overall_rank', 'overall_pos'],
  cat_rank: ['cat_rank', 'category_rank', 'cat_pos', 'category_pos'],
  gc_gap: ['gc_gap', 'gap', 'behind'],
  date: ['date', 'start_date'],
  time: ['time', 'start_time'],
  chute: ['chute', 'start_chute', 'group', 'start_group', 'wave'],
};
const RESULT_FIELDS = ['bib', 'stage_no', 'stage_name', 'stage_time', 'stage_rank', 'gc_time', 'gc_rank', 'cat_rank', 'gc_gap'];
const START_FIELDS  = ['bib', 'stage_no', 'stage_name', 'date', 'time', 'chute'];
const INT_FIELDS = new Set(['stage_no', 'stage_rank', 'gc_rank', 'cat_rank']);

function canonicalRow(raw, fields) {
  const out = {};
  for (const f of fields) {
    const k = ALIASES[f].find((a) => raw[a] != null && raw[a] !== '');
    if (k == null) continue;
    const v = String(raw[k]).trim();
    out[f] = INT_FIELDS.has(f) ? Number(v) : v;
  }
  return out;
}

/** Rows (from CSV or a JSON array) → POST body for the given format. */
function rowsToBody(rows, format) {
  if (format === 'starts') {
    return { format: 'starts', starts: rows.map((r) => canonicalRow(r, START_FIELDS)).filter((r) => r.bib && r.stage_no) };
  }
  return { format, results: rows.map((r) => canonicalRow(r, RESULT_FIELDS)).filter((r) => r.bib && r.stage_no) };
}

module.exports = { parseCsv, rowsToBody, RESULT_FIELDS, START_FIELDS };
