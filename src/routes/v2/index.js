/**
 * v2 route registrations — endpoints that operate on the V2 (block-based
 * native app) world: v2.events / v2.apps / v2.pages / v2.races.
 *
 * Timer endpoints authenticate with the same evt_ tokens as /v1/timer/*
 * (timer-auth is applied inside each module).
 */
async function v2Routes(app) {
  app.register(require('./timer_events'), { prefix: '/timer/events' });
  // Public — the v2.races id in the URL is the gate (same policy as /v1).
  app.register(require('./rr_webhook'), { prefix: '/rr_webhook' });
}

module.exports = v2Routes;
