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
  app.register(require('./tracks'),     { prefix: '/tracks' });
  app.register(require('./rr_webhook'), { prefix: '/rr_webhook' });
  app.register(require('./adverts'),    { prefix: '/adverts' });

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
    authed.register(require('./app_install'),   { prefix: '/app_install' });
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
  });
}

module.exports = v1Routes;
