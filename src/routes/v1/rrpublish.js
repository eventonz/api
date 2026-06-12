/**
 * RRPublish pass-through proxy — GET catch-all.
 *
 * One route covers every shape the app calls today, because all RRPublish
 * paths sit under the event ID:
 *   /v1/rrpublish/{rrId}/RRPublish/data/config?lang=&page=&v=1
 *   /v1/rrpublish/{rrId}/results/config?lang=        (and participants/config)
 *   /v1/rrpublish/{rrId}/{detailsPath}/list?key=&...
 *   /v1/rrpublish/{rrId}/{detailsPath}/config?key=&pid=
 *   /v1/rrpublish/{rrId}/{detailsPath}/splits?key=&pid=
 *
 * Registered in the AUTHENTICATED scope: the app attaches the Evento Bearer
 * to every genericGetHttp call (verified in api_handler.dart), so requiring
 * it here costs nothing and stops the proxy being an open RR relay.
 */

const { proxyGet } = require('../../services/rrpublish/client');

async function rrpublishRoutes(app) {
  app.get('/:rrId/*', {
    schema: {
      params: {
        type: 'object',
        properties: {
          rrId: { type: 'integer' },
          '*':  { type: 'string', minLength: 1 },
        },
        required: ['rrId', '*'],
      },
    },
  }, async (request, reply) => {
    const rrId = request.params.rrId;
    // Forward the wildcard path plus the original query string untouched
    const qIdx = request.raw.url.indexOf('?');
    const rawPathAndQuery = request.params['*'] + (qIdx === -1 ? '' : request.raw.url.slice(qIdx));

    try {
      const result = await proxyGet(rrId, rawPathAndQuery, request.headers);
      reply
        .code(result.status)
        .header('content-type', result.contentType)
        .header('x-cache', result.cache);
      if (result.stale) reply.header('x-evento-stale', 'true');
      return reply.send(result.body);
    } catch (err) {
      request.log.error({ err, rrId, path: rawPathAndQuery }, 'rrpublish upstream failure');
      return reply.code(502).send({ error: 'Upstream RaceResult request failed' });
    }
  });
}

module.exports = rrpublishRoutes;
