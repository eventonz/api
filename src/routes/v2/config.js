const { platformRacesForEvent } = require('../../services/v2bridge');
const pool = require('../../config/database');

const CDN = process.env.SPACES_CDN || 'https://evento-events.syd1.cdn.digitaloceanspaces.com';

/**
 * GET /v2/config/:event_id — the platform config document (/v1/config) for a
 * V2 event, resolved through the event's bridged platform race. The app
 * reads `tracking` (course paths per contest) and `athletes.avatar` from it.
 *
 * The default eventoapi /v1 URLs inside the document are rewritten to their
 * /v2 bridge equivalents for this event: the app follows them verbatim, and
 * a v2 event id POSTed at /v1/tracking is not a platform race id. Explicit
 * alt_* overrides (any non-default URL) pass through untouched.
 */
async function v2ConfigRoutes(app) {
  app.get('/:event_id', {
    schema: {
      params: { type: 'object', properties: { event_id: { type: 'string' } }, required: ['event_id'] },
      querystring: { type: 'object', properties: { hash: { type: 'string' } } },
    },
  }, async (request, reply) => {
    const races = await platformRacesForEvent(request.params.event_id);
    const race = races.find((r) => r.platform_race_id);
    // V2-native event (worker-fed, no platform race): build the document from
    // the v2 tables instead of bridging.
    if (!race) {
      const doc = await nativeConfig(request.params.event_id);
      if (!doc) return reply.code(404).send({ error: 'Event not found' });
      return reply.send(doc);
    }
    const qs = request.query?.hash ? `?hash=${encodeURIComponent(request.query.hash)}` : '';
    const res = await app.inject({
      method: 'GET',
      url: `/v1/config/${race.platform_race_id}${qs}`,
      headers: { authorization: request.headers.authorization || '' },
    });
    reply.code(res.statusCode);
    if (res.statusCode === 304) return reply.send();
    const ct = res.headers['content-type'];
    if (ct) reply.header('content-type', ct);
    if (res.statusCode !== 200) return reply.send(res.body);
    let doc;
    try { doc = JSON.parse(res.body); } catch { return reply.send(res.body); }
    return reply.send(rewriteV1Urls(doc, request.params.event_id, race.platform_race_id));
  });
}

/**
 * Config for a V2-native event: the parts of the platform document the app
 * reads — tracking (one path per contest that has a course; contests sharing a
 * course repeat the same geojson URL and carry course_id so the app can draw
 * it once), athletes and athlete_details URLs on /v2.
 */
async function nativeConfig(eventId) {
  const { rows: ev } = await pool.query('SELECT id, event_json FROM v2.events WHERE id = $1', [eventId]);
  if (!ev.length) return null;
  const { rows: paths } = await pool.query(
    `SELECT c.contest_id, c.name AS contest_name, c.is_tracking, c.elevation_y_scale,
            k.id AS course_id, k.name AS course_name, k.is_tracking AS course_tracking,
            EXTRACT(EPOCH FROM k.updated_at)::bigint AS updated
       FROM v2.contests c
       JOIN v2.races r ON r.id = c.race_id AND r.event_id = $1
       JOIN v2.courses k ON k.id = c.course_id
      ORDER BY r.id, c.sort_order, c.name`,
    [eventId]
  );
  const v2 = 'https://eventoapi.com/v2';
  const doc = {
    event_id: eventId,
    source: 'v2',
    athletes: { url: `${v2}/athletes/${eventId}`, avatar: 'mixed', show_athletes: true },
    athlete_details: { url: `${v2}/splits/${eventId}?bib=#{number}&id=#{id}&contest=#{contest}` },
  };
  if (paths.length) {
    doc.tracking = {
      update_freq: 30,
      data: `${v2}/tracking/${eventId}`,
      map_style: 'road',
      paths: paths.map((p) => ({
        geojson: `${CDN}/events/${eventId}/courses/${p.course_id}.geojson`,
        name: `p_${p.contest_id}`,
        contest: String(p.contest_id),
        contest_name: p.contest_name,
        course_id: Number(p.course_id),
        course_name: p.course_name,
        is_tracking: p.is_tracking === true,
        updated: Number(p.updated) || 0,
        ...(p.elevation_y_scale != null && +p.elevation_y_scale > 0 ? { elevation_y_scale: +p.elevation_y_scale } : {}),
      })),
    };
  }
  return doc;
}

/** Default eventoapi /v1 URLs (keyed on the platform race id) → the /v2
 * bridge for this event. Only exact defaults are rewritten. */
function rewriteV1Urls(doc, eventId, raceId) {
  const v1 = 'https://eventoapi.com/v1';
  const v2 = 'https://eventoapi.com/v2';
  if (doc.tracking?.data === `${v1}/tracking`) {
    doc.tracking.data = `${v2}/tracking/${eventId}`;
  }
  if (doc.athletes?.url === `${v1}/athletes/${raceId}`) {
    doc.athletes.url = `${v2}/athletes/${eventId}`;
  }
  const details = doc.athlete_details?.url;
  if (typeof details === 'string' && details.startsWith(`${v1}/splits/race/${raceId}?`)) {
    doc.athlete_details.url = `${v2}/splits/${eventId}?${details.split('?').slice(1).join('?')}`;
  }
  return doc;
}

module.exports = v2ConfigRoutes;
