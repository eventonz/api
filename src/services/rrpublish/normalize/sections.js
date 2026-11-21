/**
 * Athlete page sections — RRPublish view Elements tree → flat, ordered list
 * of typed sections the app renders natively (unknown types are skipped by
 * the client, so new types can ship server-first).
 *
 * RR describes each athlete page as a tree of elements: splits, legs,
 * certificates, photos, comments, list, links, field, text, html, map,
 * chart, favorite — wrapped in box / columns / flexbox layout containers.
 * Containers are flattened: a box contributes only its title, which lands
 * on the first section it contains. RR's inline CSS is dropped — only
 * alignment and a coarse text role survive.
 *
 * Section types: text · stats · html · splits · legs · certificates · photos ·
 * comments · links · table · entries · progress · chart
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

const ALIGN = { 2: 'center', 3: 'right' };

/** RR percent-encodes names, then double-encodes / and \ (CertificatesElement). */
const encName = (s) => encodeURIComponent(s).replace(/%2F/g, '%252F').replace(/%5C/g, '%255C');

/** Coarse role from RR inline CSS: big or bold → heading, small → caption. */
function textRole(styles) {
  const css = str(styles).toLowerCase();
  const m = /font-size:\s*([\d.]+)(px|em)/.exec(css);
  if (m) {
    const px = m[2] === 'em' ? parseFloat(m[1]) * 16 : parseFloat(m[1]);
    if (px >= 18) return 'heading';
    if (px <= 12) return 'caption';
  }
  if (/font-weight:\s*(bold|[6-9]00)/.test(css)) return 'heading';
  return 'body';
}

/** "[img:name|…]" → picture URL; anything else null. */
function imgTag(value, ctx) {
  if (!value.toLowerCase().startsWith('[img:')) return null;
  let src = value.slice(5);
  const end = src.search(/[|\]]/);
  if (end !== -1) src = src.slice(0, end);
  return src.startsWith('http') ? src : `${ctx.base}/api/picture?name=${encodeURIComponent(src)}`;
}

const absUrl = (u) => (/^https?:\/\//i.test(u) ? u : `http://${u}`);

const decodeEntities = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

/** Free HTML → plain text plus the links and images it carries. */
function htmlParts(html) {
  const links = [];
  const images = [];
  const linked = new Set();
  const aRe = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = aRe.exec(html)) !== null) {
    const url = decodeEntities(m[1]);
    const img = /<img\b[^>]*src="([^"]+)"/i.exec(m[2]);
    if (img) {
      const src = decodeEntities(img[1]);
      images.push({ url: src, link: url });
      linked.add(src);
    } else {
      links.push({ label: decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim(), url });
    }
  }
  const imgRe = /<img\b[^>]*src="([^"]+)"/gi;
  while ((m = imgRe.exec(html)) !== null) {
    const src = decodeEntities(m[1]);
    if (!linked.has(src)) images.push({ url: src, link: null });
  }
  const text = decodeEntities(html
    .replace(/<(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  return { text, links, images };
}

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

/** v2 shape { Sender.DisplayName, TimeStamp }; v1 shape { UserName, Submitted }. */
function comments(data) {
  const items = [];
  for (const c of Array.isArray(data.Comments) ? data.Comments : []) {
    const text = str(c?.Comment).trim();
    if (text === '') continue;
    items.push({
      name: str(c.Sender?.DisplayName || c.UserName),
      text,
      at: str(c.TimeStamp || c.Submitted),
    });
  }
  return items.length ? { type: 'comments', items } : null;
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
 * Embedded list (lap details, stage details, palmarès…). Columns follow the
 * list's Fields on Line 1; a single unlabelled multi-line cell is prose, so
 * it becomes a text section instead of a one-cell table.
 */
function table(el, ctx) {
  const payload = ctx.lists?.[str(el.Config?.List)];
  const fields = (payload?.List?.Fields || payload?.list?.Fields || [])
    .filter((f) => (f?.Line || 1) === 1);
  const rowsIn = payload?.Data || payload?.data;
  if (!fields.length || !Array.isArray(rowsIn) || !rowsIn.length) return null;
  const col = {};
  (payload.DataFields || []).forEach((name, i) => { col[name] = i; });

  const columns = fields.map((f) => ({
    label: i18n(str(f.Label), ctx.lang),
    align: ALIGN[f.Alignment] || 'left',
  }));
  const rows = rowsIn.map((r) => fields.map((f) => {
    const raw = str(Array.isArray(r) ? r[col[f.Expression]] : '');
    return imgTag(raw, ctx) ? '' : i18n(raw, ctx.lang);
  })).filter((r) => r.some((c) => c.trim() !== ''));
  if (!rows.length) return null;

  if (columns.length === 1 && columns[0].label === '' && rows.length === 1) {
    const prose = rows[0][0].trim();
    // Blank-line separated blocks of 2+ lines are records (ITRA palmarès:
    // race / date / place) — a list the app can collapse, not a text wall.
    const blocks = prose.split(/\n\s*\n/).map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean));
    if (blocks.length >= 3 && blocks.every((b) => b.length >= 2)) {
      return { type: 'entries', items: blocks.map(([title, ...lines]) => ({ title, lines })) };
    }
    return { type: 'text', role: 'body', align: columns[0].align, text: prose };
  }
  return { type: 'table', columns, rows };
}

/**
 * RR map element → course progress: every timing point with its distance,
 * and whether/when this athlete reached it (TrackingData, keyed by contest).
 */
function progress(data, ctx) {
  for (const contest of Object.values(data.TrackingData || {})) {
    const cols = contest?.Participants?.Columns || [];
    const mine = contest?.Participants?.Data?.[ctx.pid];
    const splits = Array.isArray(contest?.Splits) ? contest.Splits : [];
    if (!mine || splits.length < 2) continue;
    const times = mine[cols.indexOf('SplitsTime')] || [];
    const exists = str(mine[cols.indexOf('SplitsExists')]);
    return {
      type: 'progress',
      color: str(contest.Color) || null,
      points: splits.map((s, i) => ({
        name: i18n(str(s?.Name), ctx.lang),
        distanceM: Number(s?.Distance) || 0,
        reached: exists[i] === '1',
        // seconds of day
        tod: exists[i] === '1' && Number.isFinite(times[i]) ? times[i] : null,
      })),
    };
  }
  return null;
}

/** RR chart element. splitrank = overall position at each timing point. */
function chart(el, ctx) {
  if (str(el.Config?.ChartType) !== 'splitrank') return null;
  const points = [];
  for (const row of ctx.splits?.rows || []) {
    const rank = parseInt(row.values?.RO, 10);
    if (!Number.isNaN(rank)) points.push({ name: row.name, rank });
  }
  return points.length >= 2 ? { type: 'chart', chart: 'splitrank', points } : null;
}

/**
 * Runs of adjacent titled fields (RR "title above/below" tiles: finish time,
 * swim/bike/run, rankings) collapse into one stats section. A section title
 * (new box) starts a new run.
 */
function groupStats(sections) {
  const out = [];
  let lastRow = null;
  for (const { _row, ...s } of sections) {
    const tile = s.type === 'text' && s.label;
    const last = out[out.length - 1];
    // "--" is RR's empty marker (gap to leader, for the leader): no tile.
    if (tile && /^-+$/.test(s.text.trim())) continue;
    const item = tile ? { label: s.label.replace(/\s*:\s*$/, ''), value: s.text } : null;
    if (tile && last?.type === 'stats' && !s.title) {
      last.items.push(item);
      // `rows` keeps the organiser's own grouping: tiles that shared an RR
      // row (flexbox / columns) stay side by side in the app.
      if (_row != null && _row === lastRow) last.rows[last.rows.length - 1].push(item);
      else last.rows.push([item]);
    } else if (tile) {
      const group = { type: 'stats', items: [item], rows: [[item]] };
      if (s.title) group.title = s.title;
      out.push(group);
    } else {
      out.push(s);
    }
    lastRow = tile ? _row : null;
  }
  return out;
}

function leaf(el, data, ctx) {
  const cfg = el.Config || {};
  switch (el.Type) {
    case 'splits':
      return ctx.splits?.rows.length ? { type: 'splits', ...ctx.splits } : null;
    case 'legs':
      return ctx.legs?.rows.length ? { type: 'legs', ...ctx.legs } : null;
    case 'certificates': return certificates(el, data, ctx);
    case 'photos': return photos(el, data);
    case 'comments': return comments(data);
    case 'links': return links(el, ctx);
    case 'list': return table(el, ctx);
    case 'map': return progress(data, ctx);
    case 'chart': return chart(el, ctx);
    case 'field': {
      const value = str(cfg.Field).trim();
      const image = imgTag(value, ctx);
      if (image) return { type: 'html', text: '', links: [], images: [{ url: image, link: null }] };
      // "[…|…]" is a live TimeUpdater expression — nothing static to show.
      if (value === '' || (value.startsWith('[') && value.endsWith(']'))) return null;
      const out = { type: 'text', role: textRole(el.Styles), align: ALIGN[cfg.Alignment] || 'left',
        text: i18n(value, ctx.lang) };
      if (str(cfg.Title) !== '' && ['titleabove', 'titlebelow'].includes(cfg.DisplayMode)) {
        out.label = i18n(str(cfg.Title), ctx.lang);
      }
      if (cfg.DisplayMode === 'badge') out.role = 'badge';
      return out;
    }
    case 'text': {
      const text = i18n(str(cfg.Text), ctx.lang).trim();
      return text === '' ? null
        : { type: 'text', role: textRole(el.Styles), align: ALIGN[cfg.Alignment] || 'left', text };
    }
    case 'html': {
      const parts = htmlParts(str(cfg.Text));
      return parts.text === '' && !parts.links.length && !parts.images.length
        ? null : { type: 'html', ...parts };
    }
    default:
      return null; // favorite (needs an RR login), unknown future types
  }
}

/**
 * @param {Array} elements view.Elements
 * @param {object} data    view.Data (Comments, Photos, Certificates, Lists, TrackingData…)
 * @param {object} ctx     { base, path, pid, lang, splits, legs, lists }
 *   base  = "https://{rr server}/{eventId}" — direct RR, for PDFs/images
 *   path  = details page segment
 *   splits/legs = { columns, rows } already normalised
 *   lists = { [listName]: list payload } for embedded list elements
 */
function buildSections(elements, data, ctx) {
  const out = [];
  let rowSeq = 0;
  const walk = (els, title, row) => {
    let pending = title;
    for (const el of Array.isArray(els) ? els : []) {
      if (!el || typeof el !== 'object') continue;
      // each flexbox / columns container is one visual row of its children
      const childRow = el.Type === 'flexbox' || el.Type === 'columns' ? ++rowSeq : row;
      let own = '';
      if (el.Type === 'box') {
        const cfg = el.Config || {};
        own = str(cfg.LabelPreset) !== ''
          ? (PRESET_TITLES[cfg.LabelPreset] || str(cfg.LabelPreset))
          : i18n(str(cfg.Label), ctx.lang);
      }
      const before = out.length;
      const section = leaf(el, data || {}, ctx);
      if (section) out.push(row != null ? { ...section, _row: row } : section);
      walk(el.Children, own || pending, childRow);
      if (out.length > before) {
        const first = out[before];
        if (!first.title && (own || pending)) first.title = own || pending;
        pending = '';
      }
    }
  };
  walk(elements, '', null);
  // RRPublish 2.1 shows comments outside the element tree unless hidden.
  if (!ctx.hideComments && !out.some((s) => s.type === 'comments')) {
    const extra = comments(data || {});
    if (extra) out.push({ ...extra, title: 'Comments' });
  }
  return groupStats(out);
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

const HANDLED = new Set(['box', 'columns', 'flexbox', 'inlineblock', 'splits', 'legs',
  'certificates', 'photos', 'comments', 'links', 'list', 'map', 'chart', 'field', 'text',
  'html', 'favorite']);

/**
 * Element types in the tree that buildSections has no mapping for — the
 * coverage signal: a new RR element shows up here before anyone notices a
 * gap on a page.
 */
function unknownTypes(elements) {
  const found = new Set();
  const walk = (els) => {
    for (const el of Array.isArray(els) ? els : []) {
      const t = str(el?.Type);
      if (t !== '' && !HANDLED.has(t)) found.add(t);
      walk(el?.Children);
    }
  };
  walk(elements);
  return [...found].sort();
}

module.exports = { buildSections, listNames, unknownTypes, htmlParts, textRole };
