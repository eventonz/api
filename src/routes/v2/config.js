const { platformRacesForEvent } = require('../../services/v2bridge');

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
    if (!race) return reply.code(404).send({ error: 'No platform race for this event' });
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
