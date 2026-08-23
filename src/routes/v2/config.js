const { platformRacesForEvent } = require('../../services/v2bridge');

/**
 * GET /v2/config/:event_id — the platform config document (/v1/config) for a
 * V2 event, resolved through the event's bridged platform race. The app
 * reads `tracking` (course paths per contest) and `athletes.avatar` from it;
 * everything else is passed through untouched so the contract stays one.
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
    return reply.send(res.body);
  });
}

module.exports = v2ConfigRoutes;
