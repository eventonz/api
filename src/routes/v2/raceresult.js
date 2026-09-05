/**
 * RaceResult provisioning for V2 races — /v2/raceresult/*
 *
 * Creates and maintains the splits feed inside the timer's own RaceResult event
 * file, so a live event needs no manual Simple API URL and no GO LIVE button.
 *
 * Auth — one of two per-tenant credentials, no shared key:
 *   • an evt_ timer token (same as /v1/timer/* and /v2/timer/events), or
 *   • the RaceResult API key of the organisation that owns the race in the
 *     URL. The CMS uses this: every organisation already stores its own key
 *     (v2.organisations.rr_apikey), so proving you hold it proves tenancy.
 *
 * Writes to RaceResult stay blocked unless RR_ALLOW_WRITES=1 is set on the
 * server; without it these endpoints run the generate-and-check path and report
 * what they would have written.
 */

const crypto = require('crypto');
const timerAuth = require('../../plugins/timer-auth');
const { provisionRace, splitsChanged, resolveRace, apiKeyForRace } = require('../../services/raceresult/provision');
const { pullV2Race } = require('../../services/raceresult/v2Pull');

const raceIdSchema = {
  params: {
    type: 'object',
    properties: { race_id: { type: 'integer' } },
    required: ['race_id'],
  },
};

function sameSecret(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** evt_ tokens → timer auth; anything else must be the race's own org RR API key. */
async function tenantAuth(request, reply) {
  const header = request.headers['authorization'] || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!bearer) {
    return reply.code(401).send({ status: 'error', code: 401,
      message: 'Missing Authorization header. Expected: Bearer evt_... or the organisation\'s RaceResult API key' });
  }
  if (bearer.startsWith('evt_')) return timerAuth(request, reply);
  try {
    const race = await resolveRace(Number(request.params.race_id));
    const orgKey = await apiKeyForRace(race);
    if (!sameSecret(bearer, orgKey)) throw new Error('key mismatch');
  } catch (err) {
    request.log.warn({ raceId: request.params.race_id, err: err.message }, 'v2 raceresult org-key auth failed');
    return reply.code(401).send({ status: 'error', code: 401, message: 'Invalid credentials for this race' });
  }
}

async function v2RaceResultRoutes(app) {
  app.addHook('onRequest', tenantAuth);

  /**
   * POST /v2/raceresult/provision/:race_id
   *   ?dry=1            generate and check only, never write
   *   ?push=0           omit Message_en/fr/de from the generated list
   *
   * Synchronous: it is an operator action, not a race-day hot path, and the
   * caller wants the verification result.
   */
  const provisionHandler = async (request, reply) => {
    const raceId = Number(request.params.race_id);
    const dryRun = String(request.query?.dry || '') === '1';
    const pushMessages = String(request.query?.push || '') !== '0';

    try {
      const result = await provisionRace(raceId, { dryRun, pushMessages });

      // A feed that does not parse is a failed provision, even though every
      // RaceResult call succeeded — usually a user-defined function missing
      // from the event file.
      if (result.written && result.verification && !result.verification.ok) {
        return reply.code(502).send({
          error: 'Feed was written but did not verify',
          ...result,
        });
      }
      return reply.code(200).send(result);
    } catch (err) {
      request.log.error({ err, raceId }, 'raceresult provision failed');
      return reply.code(502).send({ error: err.message });
    }
  };

  /**
   * GET /v2/raceresult/provision/:race_id/status
   * Whether the event's splits have moved since the list was generated.
   */
  const statusHandler = async (request, reply) => {
    const raceId = Number(request.params.race_id);
    try {
      return reply.code(200).send(await splitsChanged(raceId));
    } catch (err) {
      return reply.code(502).send({ error: err.message });
    }
  };

  /**
   * POST /v2/raceresult/pull/:race_id
   * One refresh of the race's redis_splits cache from its provisioned feed.
   * Synchronous — the scheduler (and manual testing) wants the outcome.
   */
  const pullHandler = async (request, reply) => {
    const raceId = Number(request.params.race_id);
    try {
      return reply.code(200).send(await pullV2Race(raceId));
    } catch (err) {
      request.log.error({ err, raceId }, 'v2 raceresult pull failed');
      return reply.code(502).send({ error: err.message });
    }
  };

  app.post('/provision/:race_id', { schema: raceIdSchema }, provisionHandler);
  app.get('/provision/:race_id/status', { schema: raceIdSchema }, statusHandler);
  app.post('/pull/:race_id', { schema: raceIdSchema }, pullHandler);
}

module.exports = v2RaceResultRoutes;
