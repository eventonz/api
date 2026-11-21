/**
 * Athlete page sections — what the app takes from the timer's RaceResult
 * athlete page, as a flat, ordered list of typed sections it renders natively.
 *
 * Evento draws its own athlete page (header, summary, splits). RR describes
 * each timer's page as a tree of elements wrapped in box / columns / flexbox
 * containers; from that tree only these ride along:
 *
 *   splits · legs · photos · certificates · links · entries
 *
 * Everything else a timer builds there (status and ranking tiles, free text,
 * tables, charts, maps, comments) is deliberately NOT mirrored — it stays on
 * the timer's own results page, one tap away via `sourceUrl`. Containers are
 * flattened: a box contributes only its title, which lands on the first
 * section it contains.
 */

const { str } = require('./util');
const { i18n } = require('./i18n');

// RRPublish langItems for box LabelPreset (v1.2 keys; v2.1 uses plain words).
const PRESET_TITLES = {
  SplitsLabel1: 'Legs',
  SplitsLabel2: 'Splits',
  detailsCertificates: 'Certificates',
  detailsLinks: 'Links',
  detailsComments: 'Comments',
  detailsDetails: 'Result Details',
};

/** RR percent-encodes names, then double-encodes / and \ (CertificatesElement). */
const encName = (s) => encodeURIComponent(s).replace(/%2F/g, '%252F').replace(/%5C/g, '%255C');

const absUrl = (u) => (/^https?:\/\//i.test(u) ? u : `http://${u}`);

function certificates(el, data, ctx) {
  const sets = new Set((el.Config?.CertificateSets || []).map((s) => str(s?.Name)));
  const items = [];
  for (const c of Array.isArray(data.Certificates) ? data.Certificates : []) {
    const cs = str(c?.cs);
    if (!sets.has(cs)) continue;
    items.push({
      label: i18n(str(c.label) || cs, ctx.lang),
      url: `${ctx.base}/${ctx.path}/certificate/${ctx.pid}/${encName(cs)}`,
      thumbnail: str(c.pic) !== ''
        ? `${ctx.base}/api/picture?name=${encodeURIComponent(str(c.pic))}`
        : `${ctx.base}/${ctx.path}/certificates/thumbnail?name=${encodeURIComponent(cs)}`,
    });
  }
  return items.length ? { type: 'certificates', items } : null;
}

function photos(el, data) {
  const cfg = el.Config || {};
  const items = [];
  for (const p of Array.isArray(data.Photos) ? data.Photos : []) {
    if (str(p?.PhotographerEventID) !== str(cfg.PhotographerEventID)
      || str(p?.Photographer) !== str(cfg.PortalPhotographer)
      || str(p?.PhotographerBibField) !== str(cfg.PortalPhotographerBib)) continue;
    if (str(p.Thumbnail) === '') continue;
    items.push({ thumbnail: str(p.Thumbnail), url: str(p.URL) });
  }
  return items.length
    ? { type: 'photos', photographer: str(cfg.PortalPhotographer), items }
    : null;
}

function links(el, ctx) {
  const items = [];
  for (const l of Array.isArray(el.Config?.Links) ? el.Config.Links : []) {
    if (l?.Disabled || str(l?.URL) === '') continue;
    items.push({
      label: i18n(str(l.Label), ctx.lang),
      url: absUrl(str(l.URL)),
      image: str(l.Picture) !== ''
        ? `${ctx.base}/api/picture?name=${encodeURIComponent(str(l.Picture))}`
        : null,
    });
  }
  return items.length ? { type: 'links', items } : null;
}

/**
 * Embedded list whose single unlabelled cell is prose in blank-line separated
 * blocks of 2+ lines — records (ITRA palmarès: race / date / place), which
 * the app shows as a collapsible list. Any other embedded list is a table the
 * app doesn't draw.
 */
function entries(el, ctx) {
  const payload = ctx.lists?.[str(el.Config?.List)];
  const fields = (payload?.List?.Fields || payload?.list?.Fields || [])
    .filter((f) => (f?.Line || 1) === 1);
  const rowsIn = payload?.Data || payload?.data;
  if (fields.length !== 1 || str(fields[0].Label) !== '' || !Array.isArray(rowsIn)) return null;
  const at = (payload.DataFields || []).indexOf(fields[0].Expression);
  const cells = rowsIn.map((r) => i18n(str(Array.isArray(r) ? r[at] : ''), ctx.lang).trim())
    .filter((c) => c !== '' && !c.toLowerCase().startsWith('[img:'));
  if (cells.length !== 1) return null;
  const blocks = cells[0].split(/\n\s*\n/)
    .map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean));
  return blocks.length >= 3 && blocks.every((b) => b.length >= 2)
    ? { type: 'entries', items: blocks.map(([title, ...lines]) => ({ title, lines })) }
    : null;
}

function leaf(el, data, ctx) {
  switch (el.Type) {
    case 'splits':
      return ctx.splits?.rows.length ? { type: 'splits', ...ctx.splits } : null;
    case 'legs':
      return ctx.legs?.rows.length ? { type: 'legs', ...ctx.legs } : null;
    case 'certificates': return certificates(el, data, ctx);
    case 'photos': return photos(el, data);
    case 'links': return links(el, ctx);
    case 'list': return entries(el, ctx);
    default:
      return null; // not mirrored — see the file header
  }
}

/**
 * @param {Array} elements view.Elements
 * @param {object} data    view.Data (Photos, Certificates, Lists…)
 * @param {object} ctx     { base, path, pid, lang, splits, legs, lists }
 *   base  = "https://{rr server}/{eventId}" — direct RR, for PDFs/images
 *   path  = details page segment
 *   splits/legs = { columns, rows } already normalised
 *   lists = { [listName]: list payload } for embedded list elements
 */
function buildSections(elements, data, ctx) {
  const out = [];
  const walk = (els, title) => {
    let pending = title;
    for (const el of Array.isArray(els) ? els : []) {
      if (!el || typeof el !== 'object') continue;
      let own = '';
      if (el.Type === 'box') {
        const cfg = el.Config || {};
        own = str(cfg.LabelPreset) !== ''
          ? (PRESET_TITLES[cfg.LabelPreset] || str(cfg.LabelPreset))
          : i18n(str(cfg.Label), ctx.lang);
      }
      const before = out.length;
      const section = leaf(el, data || {}, ctx);
      if (section) out.push(section);
      walk(el.Children, own || pending);
      if (out.length > before) {
        const first = out[before];
        if (!first.title && (own || pending)) first.title = own || pending;
        pending = '';
      }
    }
  };
  walk(elements, '');
  return out;
}

/** List names referenced by `list` elements (for the pre-2.1 fetch fallback). */
function listNames(elements) {
  const names = [];
  const walk = (els) => {
    for (const el of Array.isArray(els) ? els : []) {
      if (el?.Type === 'list' && str(el.Config?.List) !== '') names.push(str(el.Config.List));
      walk(el?.Children);
    }
  };
  walk(elements);
  return [...new Set(names)];
}

module.exports = { buildSections, listNames };
