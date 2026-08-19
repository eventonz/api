/**
 * Column resolution — port of RRPublish.js setDataCols via iOS
 * RRResultsController.extractFieldMetadata.
 *
 * Matches list Fields[].Expression against the DataFields array, collects
 * per-DataField display labels, and resolves which indices anchor the compact
 * pos/name/result layout.
 */

const { str, isDirectiveExpr, isEmptyExpr } = require('./util');
const { i18n } = require('./i18n');

const NAME_PATTERNS = ['affichernom', 'nom', 'name', 'lastname', 'firstname',
  'athlete', 'participant', 'runner'];

/** DataField names that identify a rank column in the positional fallback. */
const RANK_PATTERN = /(^|[^a-z])(rank|rang|pos|position|place)/i;

/** A rendered value that reads as a time ("00:01:18.121", "3:10:05.1"). */
const TIME_VALUE = /^\d{1,2}:\d{2}(:\d{2})?([.,]\d+)?$/;

/**
 * French "nombre" (number) starts with "nom" (name) — DataField
 * `NombreDeTours` is a LAP COUNT, and matching it as the athlete name put the
 * lap count in the name column on STEC TIERP. Genuine compounds like
 * `ucase([NomEquipe])` (team name) must keep matching, so blank out only the
 * false-positive stem before testing.
 */
const NAME_ANTIPATTERNS = ['nombre'];

function namesMatch(field, pattern) {
  let hay = field;
  for (const anti of NAME_ANTIPATTERNS) hay = hay.split(anti).join('#');
  return hay.includes(pattern);
}

function extractFieldMetadata(listFormat, dataFields, lang, sampleRow = null) {
  const fields = Array.isArray(listFormat?.Fields) ? listFormat.Fields : [];
  const dfMap = new Map();
  dataFields.forEach((df, i) => dfMap.set(str(df).toLowerCase(), i));

  const candidates = [];
  const fieldLabels = {};
  const anchored = [];        // ResponsiveHide -1 AND labelled (original rule)
  const anchoredBare = [];    // ResponsiveHide -1 with no Label
  for (const f of fields) {
    const expr = str(f?.Expression);
    const idx = dfMap.get(expr.toLowerCase());
    if (idx == null) continue;
    const label = i18n(str(f?.Label), lang);
    // EVERY matched, labeled field feeds the detail info table.
    if (label !== '') fieldLabels[dataFields[idx]] = label;
    if (f?.PreviewOnly === true) continue;
    // Format directives and placeholder columns render no text — they can
    // never anchor the compact layout (this is what put "BG(#FCE62D)" in the
    // time column: both events end on a directive DataField).
    if (isDirectiveExpr(expr) || isEmptyExpr(expr)) continue;
    candidates.push({ idx, label });
    const rh = typeof f?.ResponsiveHide === 'number' ? f.ResponsiveHide : 0;
    if (rh !== -1) continue;
    (label === '' ? anchoredBare : anchored).push({ idx, label });
  }

  // Labelled ResponsiveHide -1 columns anchor the compact layout (Flutter
  // parity — unchanged for every list that has any). Only when a list marks
  // its narrow-screen columns but labels NONE of them do the bare ones
  // anchor: Swiss Epic flags rank/team/last-split as -1 with empty Labels,
  // and without this the whole set was discarded and the result column fell
  // to the last DataField — a "BG(#hex)" styling directive.
  const visible = anchored.length > 0 ? anchored : anchoredBare;

  // ≥3 → rank/name/result; 2 → name/result; 1 → result only.
  let rankIdx; let nameIdx; let resultIdx;
  if (visible.length >= 3) {
    rankIdx = visible[0].idx; nameIdx = visible[1].idx; resultIdx = visible[visible.length - 1].idx;
  } else if (visible.length === 2) {  // eslint-disable-line no-dupe-else-if
    rankIdx = 2; nameIdx = visible[0].idx; resultIdx = visible[1].idx;
  } else if (visible.length === 1) {
    rankIdx = 2; nameIdx = -1; resultIdx = visible[0].idx;
  } else {
    // No responsive-hide guidance at all. Walk back from the end past format
    // directives, then prefer the last column that actually renders a TIME —
    // otherwise the result column lands on whatever trails the list, which on
    // STEC TIERP is the gap ("-" for the leader) and on other lists is a
    // category name.
    let last = dataFields.length - 1;
    while (last > 1 && (isDirectiveExpr(dataFields[last]) || isEmptyExpr(dataFields[last]))) last -= 1;
    if (Array.isArray(sampleRow)) {
      for (let i = last; i > 1; i--) {
        if (isDirectiveExpr(dataFields[i]) || isEmptyExpr(dataFields[i])) continue;
        if (TIME_VALUE.test(str(sampleRow[i]))) { last = i; break; }
      }
    }
    rankIdx = 2; nameIdx = -1; resultIdx = last;
  }
  if (nameIdx < 0) {
    const found = dataFields.findIndex((df) => {
      const l = str(df).toLowerCase();
      return NAME_PATTERNS.some((p) => namesMatch(l, p));
    });
    nameIdx = found !== -1 ? found : Math.min(3, dataFields.length - 1);
  }
  // Anchored columns often carry no Label (Swiss Epic labels nothing); the
  // positional fallback has no anchor at all, so name the column RR gave it
  // ("Best Time", "Gun Time") rather than a generic "Time".
  const resultLabel = visible.length > 0
    ? visible[visible.length - 1].label
    : str(fieldLabels[dataFields[resultIdx]]);
  const resultFieldLabel = resultLabel === '' ? 'Time' : resultLabel;
  // rankIdx is only a REAL rank column when it came from the anchor set;
  // the other branches fall back to the positional guess of 2, which lands on
  // whatever DataField happens to sit there (a flag image, a status, a
  // category). Callers must not present that as a rank.
  // The positional fallback (rankIdx = 2) is only a rank when the DataField
  // sitting there says so — 'RANK4' on STEC TIERP, a flag image elsewhere.
  const hasRank = visible.length >= 3 || RANK_PATTERN.test(str(dataFields[rankIdx]));
  return { rankIdx, nameIdx, resultIdx, hasRank, fieldLabels, resultFieldLabel };
}

module.exports = { extractFieldMetadata };
