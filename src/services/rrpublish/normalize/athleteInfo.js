/**
 * Athlete info-field classification — union of the iOS controller's
 * infoFields() and the athlete sheet's classified() rules:
 *
 *   - skip identity fields (id / bib / displayname / name_public)
 *   - skip empty / "-" / "--" and the row's own name/time values
 *   - [img:…] → type "image" (relative src resolved against the RR base)
 *   - any other [bracket] value is an RR UDF with no useful display → skipped
 *   - URLs (raw or href="…") → type "link" (rendered as chips, never text)
 *   - remaining labeled values → type "text"; unlabeled → skipped
 */

const { str } = require('./util');
const { i18n } = require('./i18n');

const SKIP = ['id', 'bib', 'displayname', 'name_public'];

function extractImgSrc(value, detailBase) {
  if (!value.toLowerCase().startsWith('[img:')) return null;
  let src = value.slice(5);
  const end = src.search(/[|\]]/);
  if (end !== -1) src = src.slice(0, end);
  if (!src.startsWith('http')) {
    src = src.startsWith('/') ? detailBase + src : `${detailBase}/${src}`;
  }
  return src;
}

function extractUrl(value) {
  if (value.startsWith('http://') || value.startsWith('https://')) return value;
  const m = /href="([^"]+)"/.exec(value);
  return m ? m[1] : null;
}

/**
 * @param {Array<{expr,value}>} fields row fields (values already i18n'd)
 * @param {object} row  { name, time } of the participant row
 * @param {object} ctx  { fieldLabels, detailBase, lang }
 * @returns {Array<{type:'text'|'image'|'link', label, value?, url?}>}
 */
function classifyFields(fields, row, ctx) {
  const out = [];
  for (const { expr, value: raw } of fields) {
    const l = str(expr).toLowerCase();
    if (SKIP.some((s) => l.includes(s))) continue;
    const value = str(raw).trim();
    if (value === '' || value === '-' || value === '--'
      || value === row.time || value === row.name) continue;
    const label = ctx.fieldLabels[expr] || '';
    const imgSrc = extractImgSrc(value, ctx.detailBase);
    if (imgSrc) {
      out.push({ type: 'image', label, url: imgSrc });
      continue;
    }
    if (value.startsWith('[') && value.endsWith(']')) continue;
    if (label === '') continue;
    const url = extractUrl(value);
    if (url) out.push({ type: 'link', label, url });
    else out.push({ type: 'text', label, value: i18n(value, ctx.lang) });
  }
  return out;
}

module.exports = { classifyFields };
