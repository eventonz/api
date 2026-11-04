const crypto = require('crypto');
const pool = require('../../config/database');
const redis = require('../../config/redis');
const { clientIp } = require('../../plugins/rateLimit');
const { issueSnapToken, verifySnapToken, codesMatch } = require('../../services/snapTokens');

/**
 * Finisher Snap — crew photographers tag finish-line photos with a bib.
 * Contract: docs/platform/finisher-snap.md
 *
 *   /v2/snap/*              photographer app (event code → snap token)
 *   /v2/finisher_photos/*   event app read (normal app auth) — `photosRead`
 *
 * Photos go straight from the phone to Spaces (evento-nz, fra1) on presigned
 * PUT URLs; this API only signs, records and lists them.
 */
const BUCKET = 'evento-nz';
const SPACES_ENDPOINT = 'https://fra1.digitaloceanspaces.com';
const PUBLIC_BASE = 'https://evento-nz.fra1.cdn.digitaloceanspaces.com';
const KEY_ROOT = 'finisher-snap';
const UPLOAD_TTL = 600;
const LIST_CACHE_TTL = 30;
const LOGIN_TRIES = 10;
const LOGIN_WINDOW = 600;

let s3;
function spaces() {
  if (!s3) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3 = new S3Client({
      endpoint: SPACES_ENDPOINT,
      region: 'fra1',
      credentials: { accessKeyId: process.env.DO_SPACES_KEY, secretAccessKey: process.env.DO_SPACES_SECRET },
    });
  }
  return s3;
}
// Test seam.
function setSpacesClient(client) { s3 = client; }

/** Bib/team numbers: letters, digits, dash, up to 16 chars. */
const cleanBib = (b) => {
  const s = String(b ?? '').trim();
  return /^[A-Za-z0-9-]{1,16}$/.test(s) ? s : null;
};
const safeSeg = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');

function orientationOf(w, h) {
  if (!(w > 0) || !(h > 0)) return null;
  if (w === h) return 'square';
  return h > w ? 'portrait' : 'landscape';
}

const cacheKey = (eventId, bib) => `finisher_photos:${eventId}:${bib}`;

function photoOut(r) {
  return {
    id: Number(r.id), bib: r.bib, athlete_id: r.athlete_id ?? null, url: r.url, thumb_url: r.thumb_url ?? r.url,
    width: r.width ?? null, height: r.height ?? null, orientation: r.orientation ?? null,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  };
}

function eventOut(r) {
  const j = r.event_json || {};
  return {
    id: r.id, name: j.name || r.id, date: j.date || null, venue: j.venue || null,
    image: j.heroImage || j.logo || j.thumbnail || null, accent: j.accent || null,
  };
}

const PHOTO_COLS = 'id, bib, athlete_id, url, thumb_url, width, height, orientation, created_at';

async function snapAuth(request, reply) {
  const h = request.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return reply.code(401).send({ error: 'Sign in with the event code', code: 'TOKEN_INVALID' });
  try {
    request.snapEventId = verifySnapToken(h.slice(7).trim());
  } catch (err) {
    const expired = err.message === 'expired';
    return reply.code(401).send({ error: expired ? 'Sign-in expired' : 'Sign in with the event code', code: expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID' });
  }
  // Code changed or removed in the CMS → old tokens stop working.
  const { rows } = await pool.query(
    "SELECT event_json->'finisherSnap'->>'code' AS code FROM v2.events WHERE id = $1", [request.snapEventId]
  );
  if (!rows[0]?.code) return reply.code(401).send({ error: 'Finisher Snap is off for this event', code: 'TOKEN_INVALID' });
}

async function snapRoutes(app) {
  // --- public ----------------------------------------------------------------
  app.get('/events', async () => {
    const { rows } = await pool.query(
      `SELECT id, event_json FROM v2.events
        WHERE COALESCE(event_json->'finisherSnap'->>'code', '') <> ''
        ORDER BY event_json->>'date' DESC NULLS LAST, id LIMIT 200`
    );
    return { events: rows.map(eventOut) };
  });

  app.post('/login', {
    schema: {
      body: {
        type: 'object', required: ['event_id', 'code'],
        properties: { event_id: { type: 'string', minLength: 1, maxLength: 120 }, code: { type: 'string', maxLength: 40 } },
      },
    },
  }, async (request, reply) => {
    const { event_id, code } = request.body;
    const tries = `snaplogin:${clientIp(request)}:${event_id}`;
    let n = 0;
    try { n = await redis.incr(tries); if (n === 1) redis.expire(tries, LOGIN_WINDOW).catch(() => {}); } catch { /* fail open */ }
    if (n > LOGIN_TRIES) return reply.code(429).send({ error: 'Too many tries — wait 10 minutes', code: 'RATE_LIMITED' });

    const { rows } = await pool.query('SELECT id, event_json FROM v2.events WHERE id = $1', [event_id]);
    const actual = rows[0]?.event_json?.finisherSnap?.code;
    if (!rows[0] || !codesMatch(code, actual)) return reply.code(401).send({ error: 'Wrong code', code: 'WRONG_CODE' });
    redis.del(tries).catch(() => {});
    return { ...issueSnapToken(event_id), event: eventOut(rows[0]) };
  });

  // --- snap token ------------------------------------------------------------
  app.register(async (s) => {
    s.addHook('onRequest', snapAuth);

    s.get('/athletes', {
      schema: { querystring: { type: 'object', properties: { q: { type: 'string', maxLength: 60 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } } } },
    }, async (request) => {
      const { q = '', limit = 20 } = request.query;
      const { rows } = await pool.query('SELECT * FROM v2.search_athletes($1, $2, $3, $4, $5)',
        [String(q).trim(), request.snapEventId, null, limit, 0]);
      return {
        athletes: rows.map((x) => {
          const riders = Array.isArray(x.athlete_details) ? x.athlete_details.map((m) => m?.name).filter(Boolean) : [];
          return {
            bib: x.raceno, name: x.name, info: (x.info || '').trim() || riders.join(' · '),
            athlete_id: x.athlete_id, race_id: x.race_id == null ? null : Number(x.race_id), race_name: x.race_name,
          };
        }),
      };
    });

    s.post('/uploads', {
      schema: { body: { type: 'object', required: ['bib'], properties: { bib: { type: 'string', maxLength: 16 } } } },
    }, async (request, reply) => {
      const bib = cleanBib(request.body.bib);
      if (!bib) return reply.code(400).send({ error: 'Bad bib number', code: 'BAD_BIB' });
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
      const photoKey = `${KEY_ROOT}/${safeSeg(request.snapEventId)}/${safeSeg(bib)}/${crypto.randomUUID()}.jpg`;
      const thumbKey = photoKey.replace(/\.jpg$/, '_thumb.jpg');
      const headers = { 'Content-Type': 'image/jpeg', 'x-amz-acl': 'public-read', 'Cache-Control': 'public, max-age=31536000, immutable' };
      const sign = (Key) => getSignedUrl(spaces(), new PutObjectCommand({
        Bucket: BUCKET, Key, ContentType: headers['Content-Type'], ACL: 'public-read', CacheControl: headers['Cache-Control'],
      }), { expiresIn: UPLOAD_TTL, unhoistableHeaders: new Set(['x-amz-acl']), signableHeaders: new Set(['content-type', 'cache-control']) });
      const [url, thumbUrl] = await Promise.all([sign(photoKey), sign(thumbKey)]);
      return { photo_key: photoKey, upload: { url, headers }, thumb_upload: { url: thumbUrl, headers }, expires_in: UPLOAD_TTL };
    });

    s.post('/photos', {
      schema: {
        body: {
          type: 'object', required: ['photo_key', 'bib', 'width', 'height'],
          properties: {
            photo_key: { type: 'string', maxLength: 300 }, bib: { type: 'string', maxLength: 16 },
            width: { type: 'integer', minimum: 1, maximum: 20000 }, height: { type: 'integer', minimum: 1, maximum: 20000 },
            athlete_id: { type: ['string', 'null'], maxLength: 120 }, race_id: { type: ['integer', 'null'] },
            device: { type: ['string', 'null'], maxLength: 120 },
          },
        },
      },
    }, async (request, reply) => {
      const { photo_key, width, height, athlete_id = null, race_id = null, device = null } = request.body;
      const bib = cleanBib(request.body.bib);
      if (!bib) return reply.code(400).send({ error: 'Bad bib number', code: 'BAD_BIB' });
      const prefix = `${KEY_ROOT}/${safeSeg(request.snapEventId)}/`;
      if (!photo_key.startsWith(prefix) || !/^[A-Za-z0-9_\-/]+\.jpg$/.test(photo_key) || photo_key.endsWith('_thumb.jpg')) {
        return reply.code(400).send({ error: 'Photo key is not for this event', code: 'BAD_KEY' });
      }
      const { HeadObjectCommand } = require('@aws-sdk/client-s3');
      const thumbKey = photo_key.replace(/\.jpg$/, '_thumb.jpg');
      try {
        await spaces().send(new HeadObjectCommand({ Bucket: BUCKET, Key: photo_key }));
      } catch {
        return reply.code(400).send({ error: 'Photo has not been uploaded', code: 'NOT_UPLOADED' });
      }
      const hasThumb = await spaces().send(new HeadObjectCommand({ Bucket: BUCKET, Key: thumbKey })).then(() => true, () => false);

      // race_id must belong to this event, else it's dropped (not an error).
      let raceId = null;
      if (race_id != null) {
        const r = await pool.query('SELECT id FROM v2.races WHERE id = $1 AND event_id = $2', [race_id, request.snapEventId]);
        raceId = r.rows[0] ? Number(r.rows[0].id) : null;
      }
      const { rows } = await pool.query(
        `INSERT INTO v2.finisher_photos (event_id, race_id, bib, athlete_id, photo_key, url, thumb_url, width, height, orientation, device)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (photo_key) DO UPDATE SET bib = EXCLUDED.bib, athlete_id = EXCLUDED.athlete_id, deleted_at = NULL
         RETURNING ${PHOTO_COLS}`,
        [request.snapEventId, raceId, bib, athlete_id, photo_key, `${PUBLIC_BASE}/${photo_key}`,
          hasThumb ? `${PUBLIC_BASE}/${thumbKey}` : null, width, height, orientationOf(width, height), device]
      );
      redis.del(cacheKey(request.snapEventId, bib)).catch(() => {});
      return { photo: photoOut(rows[0]) };
    });

    s.get('/photos', {
      schema: { querystring: { type: 'object', properties: { bib: { type: 'string', maxLength: 16 } } } },
    }, async (request) => {
      const bib = request.query.bib ? cleanBib(request.query.bib) : null;
      const { rows } = await pool.query(
        `SELECT ${PHOTO_COLS} FROM v2.finisher_photos
          WHERE event_id = $1 AND deleted_at IS NULL AND ($2::text IS NULL OR bib = $2)
          ORDER BY created_at DESC LIMIT 100`,
        [request.snapEventId, bib]
      );
      return { photos: rows.map(photoOut) };
    });

    s.delete('/photos/:id', {
      schema: { params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    }, async (request, reply) => {
      const { rows } = await pool.query(
        `UPDATE v2.finisher_photos SET deleted_at = NOW()
          WHERE id = $1 AND event_id = $2 AND deleted_at IS NULL RETURNING bib`,
        [request.params.id, request.snapEventId]
      );
      if (!rows[0]) return reply.code(404).send({ error: 'Photo not found' });
      redis.del(cacheKey(request.snapEventId, rows[0].bib)).catch(() => {});
      return { ok: true };
    });
  });
}

/** GET /v2/finisher_photos/:event_id/:bib — event app read (app auth applied by the parent). */
async function photosRead(app) {
  app.get('/:event_id/:bib', {
    schema: {
      params: {
        type: 'object', required: ['event_id', 'bib'],
        properties: { event_id: { type: 'string', maxLength: 120 }, bib: { type: 'string', minLength: 1, maxLength: 16 } },
      },
    },
  }, async (request, reply) => {
    const { event_id } = request.params;
    const bib = cleanBib(request.params.bib);
    if (!bib) return { photos: [] };
    const key = cacheKey(event_id, bib);
    const cached = await redis.get(key).catch(() => null);
    if (cached) { reply.header('x-cache', 'hit'); return JSON.parse(cached); }
    const { rows } = await pool.query(
      `SELECT ${PHOTO_COLS} FROM v2.finisher_photos
        WHERE event_id = $1 AND bib = $2 AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 60`,
      [event_id, bib]
    );
    const body = { photos: rows.map(photoOut) };
    redis.setex(key, LIST_CACHE_TTL, JSON.stringify(body)).catch(() => {});
    return body;
  });
}

module.exports = snapRoutes;
module.exports.photosRead = photosRead;
module.exports.setSpacesClient = setSpacesClient;
module.exports._internal = { cleanBib, orientationOf, cacheKey };
