const authHook = require('../../plugins/auth');

/**
 * v1 route registrations
 * Auth hook is added directly to this scope so it applies to all child routes.
 */
async function v1Routes(app) {
  app.addHook('onRequest', authHook);

  // Mount route modules as they're built
  app.register(require('./events'),        { prefix: '/events' });
  app.register(require('./notifications'), { prefix: '/notifications' });
  app.register(require('./athletes'),      { prefix: '/athletes' });
  app.register(require('./config'),        { prefix: '/config' });
  app.register(require('./follow'),        { prefix: '/follow' });
  app.register(require('./app_install'),   { prefix: '/app_install' });
  app.register(require('./app_version'),   { prefix: '/app_version' });
  app.register(require('./rr_webhook'),    { prefix: '/rr_webhook' });
  app.register(require('./tracks'),        { prefix: '/tracks' });
  app.register(require('./timer_events'),  { prefix: '/timer/events' });
  app.register(require('./redirect'),      { prefix: '/redirect' });
  app.register(require('./schedule'),      { prefix: '/schedule' });
  app.register(require('./list'),          { prefix: '/list' });
  app.register(require('./carousel'),      { prefix: '/carousel' });
  // app.register(require('./splits'),   { prefix: '/splits' });
  // app.register(require('./tracking'), { prefix: '/tracking' });
  // app.register(require('./assistant'),{ prefix: '/assistant' });
}

module.exports = v1Routes;
