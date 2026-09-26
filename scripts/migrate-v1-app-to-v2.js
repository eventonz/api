#!/usr/bin/env node
/**
 * Migrate an OLD (v1) multi-event app's races into REAL V2 events.
 *
 *   node scripts/migrate-v1-app-to-v2.js --v1-app 27 --v2-app 27 [--apply]
 *
 * Without --apply it is a dry run (everything inside a transaction that is
 * rolled back). Each v1 race joined to the v1 app (public.app_race_join)
 * becomes the same thing the CMS "Results only" flow / POST /v2/timer/events
 * writes:
 *   • v2.events row   {name,status,timeZone,accent,date,venue,heroImage}
 *   • v2.pages home   header block + inline rr_results block (when RR-linked)
 *   • v2.races row    linked by v1_race_id (existing stub rows are UPGRADED
 *                     in place: event_id + rr_raceid set), new rows otherwise
 *   • app index entry {id,name,meta,date,image,published}
 * The app's `events` index is rebuilt: bare numeric-id stub entries (left by
 * the 8 Aug bulk copy) are replaced, anything else is kept, ordered by date
 * (newest first). Idempotent — races whose v2.races row already carries an
 * event_id are skipped.
 *
 * Accent cascade = the CMS one: my.raceresult BrandColorDark → app event
 * defaults → app accent → Evento green. The RR config fetch also tells us
 * whether the RR event is published (reported, not enforced).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const APPLY = args.includes('--apply');
const V1_APP = parseInt(arg('--v1-app', ''), 10);
const V2_APP = String(arg('--v2-app', ''));
const CACHE = arg('--cache', path.join(__dirname, '..', '.rr-config-cache.json'));
if (!V1_APP || !V2_APP) { console.error('usage: --v1-app <id> --v2-app <id> [--apply]'); process.exit(1); }

const pool = new Pool({
  host: process.env.PG_HOST, port: process.env.PG_PORT || 5432, user: process.env.PG_USER,
  password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE,
  ssl: { rejectUnauthorized: false }, max: 2,
});

const EVENTO_GREEN = '#2ABA92';
const BLANK_THUMB = /blankthumb\.png$/i;

function slugify(name) {
  return name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'event';
}
function validTZ(tz) { try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; } catch { return false; } }
function fmtDate(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
}
const hex = (v) => (typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v.trim()) ? v.trim().toUpperCase() : '');

// ---- my.raceresult config (brand colour + published flag), cached on disk ----
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { /* none */ }
async function rrConfig(rr) {
  if (cache[rr] && cache[rr].ok) return cache[rr];
  const out = { ok: false, published: null, accent: '' };
  try {
    const res = await fetch(`https://my.raceresult.com/${rr}/results/config?lang=en`, { signal: AbortSignal.timeout(15000) });
    if (res.status === 404) { out.ok = true; out.published = false; }
    else if (res.ok) {
      const json = await res.json().catch(() => null);
      out.ok = true;
      out.published = !!(json && json.key);
      const k = json ? Object.keys(json).find((x) => x.toLowerCase() === 'brandcolordark') : null;
      const raw = k ? String(json[k] || '').trim().replace(/^#/, '').toUpperCase() : '';
      out.accent = /^[0-9A-F]{6}$/.test(raw) ? `#${raw}` : '';
    }
  } catch { /* unreachable */ }
  cache[rr] = out;
  return out;
}
async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const j = i++; out[j] = await fn(items[j], j); } }));
  return out;
}

(async () => {
  const c = await pool.connect();
  try {
    const { rows: [app] } = await c.query('SELECT id, organisation_id, accent, events, event_defaults FROM v2.apps WHERE id = $1', [V2_APP]);
    if (!app) throw new Error(`v2.apps ${V2_APP} not found`);
    const orgId = app.organisation_id;
    const d = app.event_defaults || {};
    const defaults = {
      headerImage: typeof d.headerImage === 'string' ? d.headerImage.trim() : '',
      headerVariant: ['hero', 'compact'].includes(d.headerVariant) ? d.headerVariant : 'backdrop',
      accent: hex(d.accent) || hex(app.accent),
    };
    console.log(`v2 app ${V2_APP} (org ${orgId}) defaults:`, defaults);

    const { rows: races } = await c.query(
      `SELECT r.id, r.event_name, r.event_date::text AS event_date, r.display_location, r.time_zone,
              r.rr_eventid, r.status, r.thumbnail, r.results_link,
              v.id AS v2_race_id, v.event_id AS v2_event_id
         FROM public.races r
         JOIN public.app_race_join j ON j.race_id = r.id AND j.app_id = $1
         LEFT JOIN v2.races v ON v.v1_race_id = r.id
        ORDER BY r.event_date DESC NULLS LAST, r.id DESC`, [V1_APP]);
    console.log(`${races.length} v1 races on app ${V1_APP}; ${races.filter((r) => r.v2_event_id).length} already migrated`);

    // RR lookups first (network), then one transaction.
    const rrIds = [...new Set(races.filter((r) => r.rr_eventid > 0 && !r.v2_event_id).map((r) => String(r.rr_eventid)))];
    if (args.includes('--no-fetch')) console.log(`--no-fetch: using cached my.raceresult configs only (${Object.keys(cache).length} cached)`);
    else {
      process.stdout.write(`fetching ${rrIds.length} my.raceresult configs… `);
      await mapLimit(rrIds, 3, rrConfig);
      fs.writeFileSync(CACHE, JSON.stringify(cache));
      console.log('done');
    }

    await c.query('BEGIN');
    const taken = new Set((await c.query('SELECT id FROM v2.events')).rows.map((r) => r.id));
    const uniqueId = (name) => {
      const base = slugify(name);
      for (let i = 0; ; i++) { const cand = i === 0 ? base : `${base}-${i + 1}`; if (!taken.has(cand)) { taken.add(cand); return cand; } }
    };

    const entries = new Map(); // v1 race id → index entry
    const report = { created: 0, skipped: 0, hidden: 0, noRR: 0, rrUnpublished: [], rrUnreachable: [], accentsFromRR: 0 };
    for (const r of races) {
      if (r.v2_event_id) { report.skipped++; continue; }
      const name = String(r.event_name || '').trim();
      if (!name) { console.warn(`race ${r.id}: no name, skipped`); report.skipped++; continue; }
      const rr = r.rr_eventid > 0 ? String(r.rr_eventid) : '';
      const date = r.event_date || '';
      const venue = String(r.display_location || '').trim();
      const timeZone = validTZ(r.time_zone || '') ? r.time_zone : 'Pacific/Auckland';
      const published = r.status === 'open';
      const thumb = r.thumbnail && !BLANK_THUMB.test(r.thumbnail) ? r.thumbnail : '';
      const link = /^https?:\/\//.test(r.results_link || '') && !/evento\.co\.nz\/?$/.test(r.results_link) ? r.results_link.trim() : '';

      let accent = '';
      if (rr) {
        const cfg = cache[rr] || {};
        if (!cfg.ok) report.rrUnreachable.push(rr);
        else if (cfg.published === false) report.rrUnpublished.push(`${rr} (${name})`);
        accent = cfg.accent || '';
        if (accent) report.accentsFromRR++;
      } else report.noRR++;
      accent = accent || defaults.accent || EVENTO_GREEN;
      if (!published) report.hidden++;

      const eventId = uniqueId(name);
      const heroImage = defaults.headerImage || thumb;
      const eventJson = {
        name, status: published ? 'open' : 'hidden', timeZone, accent,
        ...(date ? { date } : {}), ...(venue ? { venue } : {}), ...(heroImage ? { heroImage } : {}),
      };
      await c.query('INSERT INTO v2.events (id, organisation_id, event_json) VALUES ($1, $2, $3::jsonb)', [eventId, orgId, JSON.stringify(eventJson)]);

      const blocks = [{ type: 'header', variant: defaults.headerVariant, props: { ...(heroImage ? { image: heroImage } : {}), title: name, ...(defaults.headerVariant === 'compact' ? {} : { sub: 'Live results' }) } }];
      if (rr) blocks.push({ type: 'rr_results', props: { rrEventId: rr, athleteLinks: true, tabs: 'all' } });
      await c.query(`INSERT INTO v2.pages (event_id, slug, page_type, page_json, sort) VALUES ($1, 'home', 'home', $2::jsonb, -1)`,
        [eventId, JSON.stringify({ title: 'Home', blocks })]);

      if (r.v2_race_id) {
        await c.query(`UPDATE v2.races SET event_id=$2, name=$3, event_date=$4::date, rr_raceid=$5, time_zone=$6, status='active', app_id=$7, updated_at=NOW() WHERE id=$1`,
          [r.v2_race_id, eventId, name, date || null, rr ? parseInt(rr, 10) : null, timeZone, V2_APP]);
      } else {
        await c.query(`INSERT INTO v2.races (organisation_id, app_id, event_id, name, event_date, rr_raceid, time_zone, status, v1_race_id) VALUES ($1,$2,$3,$4,$5::date,$6,$7,'active',$8)`,
          [orgId, V2_APP, eventId, name, date || null, rr ? parseInt(rr, 10) : null, timeZone, r.id]);
      }

      const meta = [venue, date ? fmtDate(date) : ''].filter(Boolean).join(' · ');
      entries.set(String(r.id), { id: eventId, name, ...(meta ? { meta } : {}), ...(date ? { date } : {}), ...(thumb ? { image: thumb } : {}), ...(link ? { link } : {}), published });
      report.created++;
    }

    // Rebuild the index: stub numeric entries → real ones; keep everything else.
    const existing = Array.isArray(app.events) ? app.events : [];
    const kept = existing.filter((e) => !/^\d+$/.test(String(e.id)));
    const byDate = (a, b) => String(b.date || '').localeCompare(String(a.date || ''));
    const index = [...kept, ...entries.values()].sort(byDate);
    const stubsDropped = existing.length - kept.length;
    await c.query('UPDATE v2.apps SET events = $2::jsonb, updated_at = NOW() WHERE id = $1', [V2_APP, JSON.stringify(index)]);

    console.log('\n--- summary ---');
    console.log(`events created: ${report.created}  (hidden: ${report.hidden}, no RR link: ${report.noRR}, accent from RR: ${report.accentsFromRR})`);
    console.log(`skipped (already migrated / unnamed): ${report.skipped}`);
    console.log(`app index: ${existing.length} → ${index.length} entries (${stubsDropped} stubs replaced, ${kept.length} kept)`);
    if (report.rrUnpublished.length) console.log(`RR events NOT published on my.raceresult (${report.rrUnpublished.length}):\n  ${report.rrUnpublished.join('\n  ')}`);
    if (report.rrUnreachable.length) console.log(`RR config unreachable: ${report.rrUnreachable.join(', ')}`);
    console.log('sample entries:', JSON.stringify(index.slice(0, 2), null, 1));

    if (APPLY) { await c.query('COMMIT'); console.log('\nAPPLIED.'); }
    else { await c.query('ROLLBACK'); console.log('\nDRY RUN — rolled back. Re-run with --apply.'); }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error(e);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
})();
