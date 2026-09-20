const pool = require('../../config/database');
const redis = require('../../config/redis');

/**
 * NorthSouth (northsouth.live) participant photos, proxied so the account
 * authorisation key stays on the server.
 *
 *   GET /v2/photos/:event_id/:bib → { enabled, event, bib, gallery, photos: [{ image, link }] }
 *
 * `event` is the NorthSouth event key the organiser set in the CMS
 * (v2.events.event_json.northsouth.event, e.g. "2026-brighton-beach-marathon").
 * `enabled:false` when the event has no key or NORTHSOUTH_AUTH is unset.
 * Cached 60s per event/bib — photos land in batches, and the athlete page
 * polls while the race is on. Upstream errors return the last cached answer
 * when there is one, else an empty list (never a 5xx to the app).
 */
const TTL_SECONDS = 60;
const UPSTREAM_TIMEOUT_MS = 6000;

const galleryUrl = (event, bib) => `https://northsouth.live/photos/${encodeURIComponent(event)}?bib=${encodeURIComponent(bib)}`;

async function eventKey(eventId) {
  const { rows } = await pool.query(
    "SELECT event_json->'northsouth'->>'event' AS key FROM v2.events WHERE id = $1",
    [eventId]
  );
  const key = rows[0]?.key ? String(rows[0].key).trim() : '';
  return /^[a-z0-9-]+$/i.test(key) ? key : '';
}

async function fetchPhotos(event, bib, auth) {
  const url = `https://northsouth.live/papi/v1/photos/event/${encodeURIComponent(event)}/bib/${encodeURIComponent(bib)}?auth=${encodeURIComponent(auth)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`northsouth ${res.status}`);
  const json = await res.json();
  if (json?.error) throw new Error(`northsouth: ${json.error}`);
  const photos = Array.isArray(json?.data?.photos) ? json.data.photos : [];
  return photos
    .filter((p) => p && typeof p.image === 'string')
    .map((p) => ({ image: p.image, link: typeof p.link === 'string' && p.link ? p.link : galleryUrl(event, bib) }));
}

async function photosRoutes(app) {
  app.get('/:event_id/:bib', {
    schema: {
      params: {
        type: 'object',
        properties: { event_id: { type: 'string', maxLength: 120 }, bib: { type: 'string', minLength: 1, maxLength: 16 } },
        required: ['event_id', 'bib'],
      },
    },
  }, async (request, reply) => {
    const { event_id, bib } = request.params;
    const auth = process.env.NORTHSOUTH_AUTH || '';
    const event = await eventKey(event_id);
    if (!event || !auth) return { enabled: false, event: event || null, bib, gallery: null, photos: [] };

    const cacheKey = `northsouth:${event}:${bib}`;
    const cached = await redis.get(cacheKey).catch(() => null);
    if (cached) {
      reply.header('x-cache', 'hit');
      return JSON.parse(cached);
    }
    let photos;
    try {
      photos = await fetchPhotos(event, bib, auth);
    } catch (err) {
      request.log.warn({ err: err.message, event, bib }, 'northsouth fetch failed');
      const stale = await redis.get(`${cacheKey}:last`).catch(() => null);
      if (stale) { reply.header('x-cache', 'stale'); return JSON.parse(stale); }
      photos = [];
    }
    const body = { enabled: true, event, bib, gallery: galleryUrl(event, bib), photos };
    const encoded = JSON.stringify(body);
    redis.setex(cacheKey, TTL_SECONDS, encoded).catch(() => {});
    redis.setex(`${cacheKey}:last`, 6 * 3600, encoded).catch(() => {});
    return body;
  });
}

module.exports = photosRoutes;
