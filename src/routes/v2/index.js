/**
 * v2 route registrations — endpoints that operate on the V2 (block-based
 * native app) world: v2.events / v2.apps / v2.pages / v2.races.
 *
 * Timer endpoints authenticate with the same evt_ tokens as /v1/timer/*
 * (timer-auth is applied inside each module).
 */
const authHook = require('../../plugins/auth');
const { rateLimit, clientIp } = require('../../plugins/rateLimit');

async function v2Routes(app) {
  app.register(require('./timer_events'), { prefix: '/timer/events' });
  // RaceResult feed provisioning — evt_ timer auth (applied inside the module).
  app.register(require('./raceresult'), { prefix: '/raceresult' });
  // App endpoints — Bearer API key (same keys as /v1).
  app.register(async (authed) => {
    authed.addHook('onRequest', authHook);
    // Per-identity ceiling on reads: an install token (normal) or a raw app key.
    authed.addHook('preHandler', rateLimit({
      name: 'reads', limit: Number(process.env.READS_PER_MINUTE || 600), windowSec: 60,
      key: (req) => req.auth?.type === 'install' ? `i:${req.auth.install_id}` : `k:${req.auth?.key_hash || 'anon'}`,
    }));
    authed.register(require('./auth'), { prefix: '/auth' });
    authed.register(require('./athletes'), { prefix: '/athletes' });
    authed.register(require('./splits'), { prefix: '/splits' });
    authed.register(require('./tracking'), { prefix: '/tracking' });
    authed.register(require('./config'), { prefix: '/config' });
    authed.register(require('./cheers'), { prefix: '/cheers' });
    // App-level endpoints aliased from /v1 so the V2 app and CMS talk /v2
    // only — same handlers, same contracts (push is app/event-scoped, not
    // race-scoped, so no bridge is needed; rrpublish keys on the RR id).
    authed.register(require('../v1/push'), { prefix: '/push' });
    authed.register(require('../v1/analytics'), { prefix: '/analytics' });
    authed.register(require('../v1/app_install'), { prefix: '/app_install' });
    authed.register(require('../v1/rrpublish'), { prefix: '/rrpublish' });
  });
  // Public — the v2.races id in the URL is the gate (same policy as /v1).
  // Public ingest is IP-limited so a stray script can't flood the queue
  // (a real start-line burst from one RaceResult box is a few hundred/min).
  app.register(async (pub) => {
    pub.addHook('preHandler', rateLimit({ name: 'ingest', limit: Number(process.env.INGEST_PER_MINUTE || 3000), windowSec: 60, key: clientIp }));
    pub.register(require('./rr_webhook'), { prefix: '/rr_webhook' });
    pub.register(require('./tracks'), { prefix: '/tracks' });
  });
}

module.exports = v2Routes;
