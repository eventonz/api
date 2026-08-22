const authHook = require('../../plugins/auth');

/**
 * v1 route registrations.
 *
 * Public endpoints (URL param is the auth):
 *   /v1/tracks/*       timing-system pushes (race_id / ss_raceid / racetec_apikey / rr_eventid)
 *   /v1/rr_webhook/*   RaceResult webhook (race_id)
 *
 * Everything else requires a Bearer API key (auth hook in nested scope).
 */
async function v1Routes(app) {
  // ---------------------------------------------------------------------------
  // Public — no bearer required
  // ---------------------------------------------------------------------------
  app.register(require('./tracks'),        { prefix: '/tracks' });
  app.register(require('./rr_webhook'),    { prefix: '/rr_webhook' });
  app.register(require('./rr_follow_push'),{ prefix: '/rr_follow_push' });
  app.register(require('./adverts'),       { prefix: '/adverts' });
  // Push scheduler runner for EasyCron: POST/GET /v1/push_cron?key=<PUSH_CRON_SECRET>
  app.route({ method: ['GET', 'POST'], url: '/push_cron', handler: async (request, reply) => {
    const secret = process.env.PUSH_CRON_SECRET;
    if (!secret || request.query.key !== secret) return reply.code(401).send({ error: 'bad key' });
    const res = await app.inject({ method: 'POST', url: '/v1/push/run', headers: { authorization: `Bearer ${process.env.PUSH_CRON_BEARER || ''}` } });
    return reply.code(res.statusCode).send(res.json());
  } });

  // ---------------------------------------------------------------------------
  // Authenticated — bearer required
  // ---------------------------------------------------------------------------
  app.register(async (authed) => {
    authed.addHook('onRequest', authHook);

    authed.register(require('./events'),        { prefix: '/events' });
    authed.register(require('./notifications'), { prefix: '/notifications' });
    authed.register(require('./athletes'),      { prefix: '/athletes' });
    authed.register(require('./config'),        { prefix: '/config' });
    authed.register(require('./follow'),        { prefix: '/follow' });
    authed.register(require('./rr_follow'),     { prefix: '/rr_follow' });
    authed.register(require('./app_install'),   { prefix: '/app_install' });
    authed.register(require('./analytics'),     { prefix: '/analytics' });
    authed.register(require('./app_version'),   { prefix: '/app_version' });
    authed.register(require('./timer_events'),  { prefix: '/timer/events' });
    authed.register(require('./schedule'),      { prefix: '/schedule' });
    authed.register(require('./list'),          { prefix: '/list' });
    authed.register(require('./carousel'),      { prefix: '/carousel' });
    authed.register(require('./maps'),          { prefix: '/maps' });
    authed.register(require('./settings'),      { prefix: '/settings' });
    authed.register(require('./assistant'),     { prefix: '/assistant' });
    authed.register(require('./tracking'),      { prefix: '/tracking' });
    authed.register(require('./splits'),        { prefix: '/splits' });
    authed.register(require('./raceresult'),    { prefix: '/raceresult' });
    authed.register(require('./racemap'),       { prefix: '/racemap' });
    authed.register(require('./rrpublish'),     { prefix: '/rrpublish' });
    authed.register(require('./push'),          { prefix: '/push' });
  });
}

module.exports = v1Routes;
