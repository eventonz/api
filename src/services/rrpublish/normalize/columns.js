/**
 * Column resolution — port of RRPublish.js setDataCols via iOS
 * RRResultsController.extractFieldMetadata.
 *
 * Matches list Fields[].Expression against the DataFields array, collects
 * per-DataField display labels, and resolves which indices anchor the compact
 * pos/name/result layout.
 */

const { str } = require('./util');
const { i18n } = require('./i18n');

const NAME_PATTERNS = ['affichernom', 'nom', 'name', 'lastname', 'firstname',
  'athlete', 'participant', 'runner'];

/**
 * @param {object} listFormat  the list response's `list` object (Fields, Orders…)
 * @param {string[]} dataFields the list response's DataFields array
 * @returns {{rankIdx, nameIdx, resultIdx, fieldLabels, resultFieldLabel}}
 */
function extractFieldMetadata(listFormat, dataFields, lang) {
  const fields = Array.isArray(listFormat?.Fields) ? listFormat.Fields : [];
  const dfMap = new Map();
  dataFields.forEach((df, i) => dfMap.set(str(df).toLowerCase(), i));

  const visible = [];
  const fieldLabels = {};
  for (const f of fields) {
    const idx = dfMap.get(str(f?.Expression).toLowerCase());
    if (idx == null) continue;
    const label = i18n(str(f?.Label), lang);
    // EVERY matched, labeled field feeds the detail info table.
    if (label !== '') fieldLabels[dataFields[idx]] = label;
    // Flutter parity: ONLY ResponsiveHide == -1 (keep-longest) fields anchor
    // the compact layout — lists without any fall through to the name-pattern
    // + last-DataField fallback.
    if (f?.PreviewOnly === true) continue;
    const rh = typeof f?.ResponsiveHide === 'number' ? f.ResponsiveHide : 0;
    if (rh !== -1 || label === '') continue;
    visible.push({ idx, label });
  }

  // ≥3 → rank/name/result; 2 → name/result; 1 → result only.
  let rankIdx; let nameIdx; let resultIdx;
  if (visible.length >= 3) {
    rankIdx = visible[0].idx; nameIdx = visible[1].idx; resultIdx = visible[visible.length - 1].idx;
  } else if (visible.length === 2) {
    rankIdx = 2; nameIdx = visible[0].idx; resultIdx = visible[1].idx;
  } else if (visible.length === 1) {
    rankIdx = 2; nameIdx = -1; resultIdx = visible[0].idx;
  } else {
    rankIdx = 2; nameIdx = -1; resultIdx = dataFields.length - 1;
  }
  if (nameIdx < 0) {
    const found = dataFields.findIndex((df) => {
      const l = str(df).toLowerCase();
      return NAME_PATTERNS.some((p) => l.includes(p));
    });
    nameIdx = found !== -1 ? found : Math.min(3, dataFields.length - 1);
  }
  const resultFieldLabel = visible.length > 0 ? visible[visible.length - 1].label : 'Time';
  return { rankIdx, nameIdx, resultIdx, fieldLabels, resultFieldLabel };
}

module.exports = { extractFieldMetadata };
