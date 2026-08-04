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
const { normalizedConfig, normalizedList, normalizedAthlete } =
  require('../../services/rrpublish/normalize');

async function rrpublishRoutes(app) {
  // -------------------------------------------------------------------------
  // app/v1 — normalized schema for mobile clients (RR quirks resolved server-
  // side; the session key never leaves the proxy). Static path segments win
  // over the /:rrId/* wildcard in Fastify's router, and no RR upstream path
  // starts with "app/", so the raw passthrough below is untouched.
  // -------------------------------------------------------------------------

  const rrIdParams = {
    type: 'object',
    properties: { rrId: { type: 'integer' } },
    required: ['rrId'],
  };

  const sendNormalized = (reply, res) => {
    reply.code(res.status);
    if (res.stale) reply.header('x-evento-stale', 'true');
    return reply.send(res.body);
  };

  const normalizedHandler = (fn, pickParams) => async (request, reply) => {
    try {
      const res = await fn(request.params.rrId, pickParams(request.query || {}));
      return sendNormalized(reply, res);
    } catch (err) {
      request.log.error({ err, rrId: request.params.rrId }, 'rrpublish normalize failure');
      return reply.code(502).send({ error: 'Upstream RaceResult request failed' });
    }
  };

  app.get('/:rrId/app/v1/config', {
    schema: {
      params: rrIdParams,
      querystring: {
        type: 'object',
        properties: { lang: { type: 'string', maxLength: 5 } },
      },
    },
  }, normalizedHandler(normalizedConfig, (q) => ({ lang: q.lang })));

  app.get('/:rrId/app/v1/list', {
    schema: {
      params: rrIdParams,
      querystring: {
        type: 'object',
        properties: {
          tab:      { type: 'string', enum: ['results', 'participants', 'live'] },
          listname: { type: 'string' },
          contest:  { type: 'string' },
          lang:     { type: 'string', maxLength: 5 },
          search:   { type: 'string' },
          f:        { type: 'string' },   // \f-joined group-filter slots
          group:    { type: 'string' },   // raw group key → single-group paging
          limit:    { type: 'integer', minimum: 1, maximum: 5000 },
        },
      },
    },
  }, normalizedHandler(normalizedList, (q) => ({
    tab: q.tab, listname: q.listname, contest: q.contest, lang: q.lang,
    search: q.search, f: q.f, group: q.group, limit: q.limit,
  })));

  app.get('/:rrId/app/v1/athlete', {
    schema: {
      params: rrIdParams,
      querystring: {
        type: 'object',
        properties: {
          pid:      { type: 'string', minLength: 1 },
          listname: { type: 'string' },
          lang:     { type: 'string', maxLength: 5 },
        },
        required: ['pid'],
      },
    },
  }, normalizedHandler(normalizedAthlete, (q) => ({
    pid: q.pid, listname: q.listname, lang: q.lang,
  })));
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
