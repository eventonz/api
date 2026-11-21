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

/** Column labels that mean "who" when the expression gives no clue. */
const NAME_LABELS = ['nom', 'name', 'team', 'equipe', 'équipe', 'athlete', 'athlète',
  'coureur', 'participant'];

/** A list column that holds the athlete / team name, by expression or label. */
function isNameColumn(col) {
  const expr = col.expr.toLowerCase();
  const label = col.label.toLowerCase();
  return NAME_PATTERNS.some((p) => namesMatch(expr, p))
    || NAME_LABELS.some((p) => namesMatch(label, p));
}

function extractFieldMetadata(listFormat, dataFields, lang, sampleRow = null) {
  const fields = Array.isArray(listFormat?.Fields) ? listFormat.Fields : [];
  const dfMap = new Map();
  dataFields.forEach((df, i) => dfMap.set(str(df).toLowerCase(), i));

  const candidates = [];
  const fieldLabels = {};
  const fieldLinks = {};      // DataField → index of the DataField holding its Link URL
  const anchored = [];        // ResponsiveHide -1 AND labelled (original rule)
  const anchoredBare = [];    // ResponsiveHide -1 with no Label
  const narrow = [];          // labelled, not hidden on narrow screens (≤ 0)
  let hidesSome = false;      // the organiser marked columns to hide (> 0)
  for (const f of fields) {
    const expr = str(f?.Expression);
    const idx = dfMap.get(expr.toLowerCase());
    if (idx == null) continue;
    const label = i18n(str(f?.Label), lang);
    const linkIdx = dfMap.get(str(f?.Link).toLowerCase());
    if (str(f?.Link) !== '' && linkIdx != null) fieldLinks[dataFields[idx]] = linkIdx;
    // EVERY matched, labeled field feeds the detail info table.
    if (label !== '') fieldLabels[dataFields[idx]] = label;
    if (f?.PreviewOnly === true) continue;
    // Format directives and placeholder columns render no text — they can
    // never anchor the compact layout (this is what put "BG(#FCE62D)" in the
    // time column: both events end on a directive DataField).
    if (isDirectiveExpr(expr) || isEmptyExpr(expr)) continue;
    candidates.push({ idx, label, expr });
    const rh = typeof f?.ResponsiveHide === 'number' ? f.ResponsiveHide : 0;
    if (rh > 0) hidesSome = true;
    else if (label !== '') narrow.push({ idx, label, expr });
    if (rh !== -1) continue;
    (label === '' ? anchoredBare : anchored).push({ idx, label, expr });
  }

  // Labelled ResponsiveHide -1 columns anchor the compact layout (Flutter
  // parity — unchanged for every list that has any). Only when a list marks
  // its narrow-screen columns but labels NONE of them do the bare ones
  // anchor: Swiss Epic flags rank/team/last-split as -1 with empty Labels,
  // and without this the whole set was discarded and the result column fell
  // to the last DataField — a "BG(#hex)" styling directive.
  let visible = anchored.length > 0 ? anchored : anchoredBare;
  // A lone -1 anchor is not a layout. When the organiser also hides columns
  // on narrow screens, the columns they left showing ARE the phone layout:
  // Race Across Spain pins only the name (-1), leaves rank and total time at
  // 0 and hides the rest — reading the lone anchor as "result only" put the
  // athlete name in the time column and the rank in the name column.
  // Lists with NO anchor keep the positional fallback (start lists rely on it).
  // Only when the lone anchor IS the name: L'Enfer des Canaux pins only the
  // time, and widening there put the bib in the name column and the gap in
  // the time column — a lone time anchor stays "result only".
  if (visible.length === 1 && hidesSome && narrow.length >= 2
      && isNameColumn(visible[0])) visible = narrow;

  // ≥3 → rank/name/result; 2 → name/result; 1 → result only.
  let rankIdx; let nameIdx; let resultIdx;
  if (visible.length >= 3) {
    rankIdx = visible[0].idx; nameIdx = visible[1].idx; resultIdx = visible[visible.length - 1].idx;
  } else if (visible.length === 2) {
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
  // The anchors say which columns matter, not which one is the name: timers
  // pin laps + time (24 Heures Vélo) or a stats icon + time (Marseille-
  // Cassis), and the positional pick then showed a lap count or an icon as
  // the athlete. When the picked column isn't a name and the list has one, use it.
  const picked = visible.find((c) => c.idx === nameIdx);
  if (picked && !isNameColumn(picked)) {
    const real = candidates.find((c) => isNameColumn(c));
    if (real) nameIdx = real.idx;
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
  // rankIdx from the anchor set is a real rank column; the positional
  // fallback of 2 is only a rank when the DataField sitting there says so —
  // 'RANK4' on STEC TIERP, a flag image or status on other lists.
  const hasRank = visible.length >= 3 || RANK_PATTERN.test(str(dataFields[rankIdx]));
  return { rankIdx, nameIdx, resultIdx, hasRank, fieldLabels, fieldLinks, resultFieldLabel };
}

module.exports = { extractFieldMetadata };
