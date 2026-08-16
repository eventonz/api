const crypto = require('crypto');
const pool   = require('../../config/database');
const timerAuth = require('../../plugins/timer-auth');

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const RR_ENCRYPTION_KEY = process.env.RR_ENCRYPTION_KEY || 'evento_rr_2024';

const s3Client = new S3Client({
  endpoint: 'https://fra1.digitaloceanspaces.com',
  region: 'fra1',
  credentials: {
    accessKeyId: process.env.DO_SPACES_KEY,
    secretAccessKey: process.env.DO_SPACES_SECRET,
  },
});

/**
 * V2 Timer Events API — the V2-app counterpart of /v1/timer/events.
 *
 * POST /v2/timer/events
 *
 * Creates a V2 event and drops its entry into the app index's events array,
 * so the timer's event_list auto-populates. Same auth (evt_ token). There is
 * NO mode — the behaviour derives entirely from the data:
 *
 *   results_link given → the index entry gets `link`: the card taps straight
 *     out to that URL (Racetec-style timers). No pages needed.
 *   rr_event_id given → the event is enriched from RaceResult (name, date,
 *     location, timezone, logo→thumbnail), a v2.races row carries the RR
 *     link, and — unless a results_link overrides the tap — the event opens
 *     to a ready-made my.raceresult results page.
 *   Both → RR-linked event that currently taps out to the external URL;
 *     remove the link later (CMS settings) and the event itself takes over.
 *   Neither RR nor link, just name/date → a bare event shell for the CMS to
 *     build out.
 *
 * Card presentation fields, all optional: `thumbnail` (alias `image`) — the
 * list thumbnail URL; `meta` — full custom meta line (otherwise derived as
 * "location · date"); `badge` — status chip text ("open"/"next"/"live"…);
 * `date` (ISO) — drives the upcoming/past tabs. Explicit fields always win
 * over RaceResult-derived ones.
 *
 * Upgrading to the full pipeline (athletes, tracking, push) is a CMS action
 * later — same event, the loader keys off the race row's rr_raceid.
 *
 * Index entries carry `date` (ISO) so event_list tabs derive upcoming/past
 * automatically. DB-only: the entry goes live on the app's next CMS publish.
 */
async function timerEventsV2Routes(app) {
  app.addHook('onRequest', timerAuth);

  app.post('/', async (request, reply) => {
    const { timerToken } = request;
    const body = request.body || {};

    const rrEventId = body.rr_event_id != null ? String(body.rr_event_id).trim() : '';
    if (rrEventId && !/^\d+$/.test(rrEventId)) {
      return reply.code(422).send(err(422, 'rr_event_id must be numeric.'));
    }

    const resultsLink = (body.results_link || '').trim();
    if (resultsLink && !/^https?:\/\/.+/.test(resultsLink)) {
      return reply.code(422).send(err(422, 'results_link must be a full http(s):// URL.'));
    }

    const manualName     = (body.name || '').trim();
    const manualDate     = (body.date || '').trim();
    const manualLocation = (body.location || '').trim();
    // `thumbnail` and `image` are aliases — the card's list thumbnail.
    const manualImage    = (body.thumbnail || body.image || '').trim();
    // Full custom meta line for the card ("Wānaka · 2-5 July 2026"); when
    // absent it's derived from location · date.
    const manualMeta     = (body.meta || '').trim();
    const badge          = (body.badge || '').trim();
    if (manualDate && !/^\d{4}-\d{2}-\d{2}$/.test(manualDate)) {
      return reply.code(422).send(err(422, 'date must be YYYY-MM-DD.'));
    }
    if (!rrEventId && !manualName) {
      return reply.code(422).send(err(422, 'Provide rr_event_id (details come from RaceResult), or a name (with optional date/location/thumbnail/meta/results_link).'));
    }

    try {
      // --- Resolve the timer's V2 org + app from the v1 token ---
      const orgRes = await pool.query(
        'SELECT id FROM v2.organisations WHERE v1_org_id = $1',
        [timerToken.org_id]
      );
      if (orgRes.rows.length === 0) {
        return reply.code(404).send(err(404, 'This organisation has no V2 workspace yet. Use /v1/timer/events, or contact Evento.'));
      }
      const v2OrgId = orgRes.rows[0].id;

      const appsRes = await pool.query(
        'SELECT id FROM v2.apps WHERE organisation_id = $1 ORDER BY id',
        [v2OrgId]
      );
      if (appsRes.rows.length === 0) {
        return reply.code(404).send(err(404, 'This organisation has no V2 app.'));
      }
      let v2AppId = String(appsRes.rows[0].id);
      if (body.v2_app_id != null) {
        const wanted = String(body.v2_app_id);
        if (!appsRes.rows.some((r) => String(r.id) === wanted)) {
          return reply.code(403).send(err(403, `v2_app_id ${wanted} does not belong to this organisation.`));
        }
        v2AppId = wanted;
      }

      // --- Duplicate check (RR-linked events) ---
      if (rrEventId) {
        const dup = await pool.query(
          'SELECT id, event_id FROM v2.races WHERE rr_raceid = $1 AND organisation_id = $2',
          [parseInt(rrEventId), v2OrgId]
        );
        if (dup.rows.length > 0) {
          return reply.code(409).send({
            status: 'error', code: 409,
            message: `A V2 event already exists for rr_event_id ${rrEventId}.`,
            existing_event_id: dup.rows[0].event_id,
          });
        }
      }

      // --- Enrich from RaceResult (or take the manual fields) ---
      let name = manualName, isoDate = manualDate, location = manualLocation;
      let timeZone = 'Pacific/Auckland', thumbnailUrl = manualImage;

      if (rrEventId) {
        const enriched = await fetchRREvent(app, v2OrgId, timerToken.org_id, rrEventId);
        if (enriched.error) return reply.code(enriched.code).send(err(enriched.code, enriched.error));
        name       = manualName || enriched.name;
        isoDate    = manualDate || enriched.date;
        location   = manualLocation || enriched.location;
        timeZone   = enriched.timeZone || timeZone;
        thumbnailUrl = manualImage || enriched.thumbnailUrl || '';
      }
      if (!name) return reply.code(502).send(err(502, 'Could not determine an event name.'));

      const displayDate = isoDate
        ? new Date(`${isoDate}T00:00:00`).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })
        : '';
      const meta = manualMeta || [location, displayDate].filter(Boolean).join(' · ');

      // Published straight away unless the timer says otherwise (e.g. they
      // want to finish the event in the CMS before it shows).
      const published = body.published !== false;

      // --- v2.events row ---
      const eventId = await uniqueEventId(name);
      let accent = (body.accent || '').trim().toUpperCase();
      if (accent && !/^#[0-9A-F]{6}$/.test(accent)) {
        return reply.code(422).send(err(422, 'accent must be a hex colour like #2ABA92.'));
      }
      // Accent cascade (same as the CMS): explicit accent → the event's
      // my.raceresult BrandColorDark → Evento green.
      if (!accent && rrEventId) accent = await rrBrandColor(rrEventId);
      const eventJson = {
        name,
        status: published ? 'open' : 'hidden',
        timeZone,
        accent: accent || '#2ABA92',
        ...(isoDate ? { date: isoDate } : {}),
        ...(location ? { venue: location } : {}),
      };
      await pool.query(
        'INSERT INTO v2.events (id, organisation_id, event_json) VALUES ($1, $2, $3::jsonb)',
        [eventId, v2OrgId, JSON.stringify(eventJson)]
      );

      // --- Content: RR-linked events open to a my.raceresult results page.
      // (If a results_link is also set, the entry taps out instead — but the
      // page is ready the moment the link is removed.) ---
      if (rrEventId) {
        // The event's whole content is one my.raceresult results page.
        const pageJson = {
          title: 'Results',
          pageType: 'rr_results',
          rrEventId: rrEventId,
          athleteLinks: true,
          blocks: [{
            type: 'hero_image',
            variant: 'full_bleed',
            props: {
              title: name,
              sub: 'Live results',
              image: `https://my.raceresult.com/${rrEventId}/api/cover`,
              height: 300,
            },
          }],
        };
        await pool.query(
          `INSERT INTO v2.pages (event_id, slug, page_type, page_json, sort)
           VALUES ($1, 'results', 'rr_results', $2::jsonb, 0)`,
          [eventId, JSON.stringify(pageJson)]
        );
      }

      if (rrEventId) {
        // The race row carries the RR link — the CMS athlete loader and the
        // full-pipeline upgrade both key off rr_raceid.
        await pool.query(
          `INSERT INTO v2.races (organisation_id, event_id, name, event_date, rr_raceid, time_zone, status)
           VALUES ($1, $2, $3, $4::date, $5, $6, 'active')`,
          [v2OrgId, eventId, name, isoDate || null, parseInt(rrEventId), timeZone]
        );
      }

      // --- Append the index entry (the thing event_list renders) ---
      const entry = {
        id: eventId,
        name,
        ...(meta ? { meta } : {}),
        ...(isoDate ? { date: isoDate } : {}),
        ...(thumbnailUrl ? { image: thumbnailUrl } : {}),
        ...(badge ? { badge } : {}),
        ...(resultsLink ? { link: resultsLink } : {}),
        published,
      };
      await pool.query(
        `UPDATE v2.apps SET events = COALESCE(events, '[]'::jsonb) || $2::jsonb, updated_at = NOW()
         WHERE id = $1`,
        [v2AppId, JSON.stringify([entry])]
      );

      return reply.code(200).send({
        status: 'success',
        data: {
          event_id: eventId,
          app_id: v2AppId,
          name,
          date: isoDate || null,
          meta: meta || null,
          image: thumbnailUrl || null,
          link: resultsLink || null,
          rr_event_id: rrEventId || null,
          published,
          note: 'Entry saved. It goes live in the app on the next CMS publish of this app.',
        },
      });
    } catch (e) {
      app.log.error({ err: e }, 'POST /v2/timer/events error');
      return reply.code(500).send(err(500, e.message));
    }
  });

  // DELETE /v2/timer/events/:event_id — remove the event and its index entries.
  app.delete('/:event_id', async (request, reply) => {
    const { timerToken } = request;
    const eventId = String(request.params.event_id || '').trim();
    if (!eventId) return reply.code(422).send(err(422, 'Missing event_id.'));

    try {
      const orgRes = await pool.query('SELECT id FROM v2.organisations WHERE v1_org_id = $1', [timerToken.org_id]);
      if (orgRes.rows.length === 0) return reply.code(404).send(err(404, 'No V2 workspace for this organisation.'));
      const v2OrgId = orgRes.rows[0].id;

      const evRes = await pool.query(
        'SELECT id FROM v2.events WHERE id = $1 AND organisation_id = $2',
        [eventId, v2OrgId]
      );
      if (evRes.rows.length === 0) return reply.code(404).send(err(404, `No V2 event '${eventId}' for this organisation.`));

      await pool.query('DELETE FROM v2.races WHERE event_id = $1', [eventId]);
      await pool.query('DELETE FROM v2.pages WHERE event_id = $1', [eventId]);
      await pool.query(
        `UPDATE v2.apps
         SET events = (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(events) e WHERE e->>'id' <> $1),
             updated_at = NOW()
         WHERE organisation_id = $2 AND events @> jsonb_build_array(jsonb_build_object('id', $1::text))`,
        [eventId, v2OrgId]
      );
      await pool.query('DELETE FROM v2.events WHERE id = $1', [eventId]);

      return reply.code(200).send({ status: 'success', data: { event_id: eventId, deleted: true } });
    } catch (e) {
      app.log.error({ err: e }, 'DELETE /v2/timer/events error');
      return reply.code(500).send(err(500, e.message));
    }
  });
}

// =============================================================================
// Helpers
// =============================================================================

function err(code, message) {
  return { status: 'error', code, message };
}

function slugify(name) {
  return name.toLowerCase().normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60) || 'event';
}

async function uniqueEventId(name) {
  const base = slugify(name);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const { rows } = await pool.query('SELECT 1 FROM v2.events WHERE id = $1', [candidate]);
    if (rows.length === 0) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

/** RR org login + event settings + logo upload — the same enrichment /v1 does. */
async function fetchRREvent(app, v2OrgId, v1OrgId, rrEventId) {
  // V2 key first, frozen v1 key as fallback (same cascade as the CMS).
  const keyRes = await pool.query(
    `SELECT o.rr_apikey AS v2key, v1.rr_apikey AS v1key
     FROM v2.organisations o
     LEFT JOIN public.organisations v1 ON v1.id = $2
     WHERE o.id = $1`,
    [v2OrgId, v1OrgId]
  );
  const keys = keyRes.rows[0] || {};
  const encrypted = keys.v2key || keys.v1key;
  if (!encrypted) return { error: 'No RaceResult API key configured for this organisation.', code: 403 };

  let apikey;
  try {
    apikey = decrypt(encrypted, RR_ENCRYPTION_KEY);
  } catch {
    return { error: 'Could not decrypt the RaceResult API key.', code: 500 };
  }

  const loginResp = await fetch('https://events.raceresult.com/api/public/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `apikey=${encodeURIComponent(apikey)}`,
  });
  if (!loginResp.ok) return { error: `RaceResult authentication failed (HTTP ${loginResp.status}).`, code: 502 };
  let token;
  try {
    token = (await loginResp.clone().json()).Token || '';
  } catch {
    token = await loginResp.text();
  }
  if (!token || !token.trim()) return { error: 'RaceResult login returned no token.', code: 502 };

  const detResp = await fetch(`https://events.raceresult.com/_${rrEventId}/api/multirequest`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: '["Settings:EventName,EventDate,EventLocation,Eventtimezone,EventLogo"]',
  });
  if (!detResp.ok) return { error: `Could not fetch RaceResult event ${rrEventId} (HTTP ${detResp.status}).`, code: 502 };
  let settings;
  try {
    settings = (await detResp.json()).Settings;
  } catch {
    return { error: 'Invalid response from RaceResult.', code: 502 };
  }
  if (!settings || !settings.EventName) return { error: `RaceResult event ${rrEventId} not found.`, code: 502 };

  const parsed = new Date(settings.EventDate);
  const date = isNaN(parsed) ? '' : parsed.toISOString().split('T')[0];

  let thumbnailUrl = '';
  if (settings.EventLogo && settings.EventLogo.trim()) {
    try {
      const logoResp = await fetch(
        `https://events.raceresult.com/_${rrEventId}/api/pictures/thumbnail?name=${encodeURIComponent(settings.EventLogo.trim())}&maxWidth=360&maxHeight=180`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      if (logoResp.ok) {
        const contentType = logoResp.headers.get('content-type') || '';
        let buf = Buffer.from(await logoResp.arrayBuffer());
        let ext = 'png';
        if (contentType.includes('application/json')) {
          const j = JSON.parse(buf.toString('utf8'));
          const b64 = j.data || j.Data || j.base64;
          if (b64) { buf = Buffer.from(b64, 'base64'); ext = j.type || 'png'; }
        } else {
          const t = contentType.split('/')[1];
          if (t && t !== 'octet-stream') ext = t;
        }
        const fileName = `${crypto.randomUUID()}.${ext}`;
        await s3Client.send(new PutObjectCommand({
          Bucket: 'evento-nz',
          Key: `rrlogos/${fileName}`,
          Body: buf,
          ContentType: contentType || `image/${ext}`,
          ACL: 'public-read',
        }));
        thumbnailUrl = `https://evento-nz.fra1.cdn.digitaloceanspaces.com/rrlogos/${fileName}`;
      }
    } catch (e) {
      app.log.warn(`RR logo upload failed: ${e.message}`);
    }
  }

  return {
    name: settings.EventName,
    date,
    location: settings.EventLocation || '',
    timeZone: settings.Eventtimezone || '',
    thumbnailUrl,
  };
}

/** The event's public my.raceresult brand colour (BrandColorDark) — same
 * source as the CMS's rrBrandColor. Empty string when unset/unreachable. */
async function rrBrandColor(rrEventId) {
  try {
    const res = await fetch(`https://my.raceresult.com/${rrEventId}/results/config?lang=en`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return '';
    const json = await res.json();
    const key = Object.keys(json).find((k) => k.toLowerCase() === 'brandcolordark');
    const raw = key ? json[key] : '';
    if (typeof raw !== 'string') return '';
    const hex = raw.trim().replace(/^#/, '').toUpperCase();
    return /^[0-9A-F]{6}$/.test(hex) ? `#${hex}` : '';
  } catch {
    return '';
  }
}

/** ColdFusion CFMX_COMPAT decrypt (same as /v1/timer/events). */
function decrypt(encryptedHex, key) {
  const keyHash = crypto.createHash('md5').update(key, 'utf8').digest();
  const keyBuffer = Buffer.concat([keyHash, keyHash.slice(0, 8)]);
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv('des-ede3', keyBuffer, Buffer.alloc(0));
  decipher.setAutoPadding(true);
  let out = decipher.update(encrypted);
  out = Buffer.concat([out, decipher.final()]);
  return out.toString('utf8');
}

module.exports = timerEventsV2Routes;
