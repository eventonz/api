const { buildTracking, buildTrackingV2 } = require('../../services/tracking');
const pool = require('../../config/database');
const { platformRacesForEvent } = require('../../services/v2bridge');

/**
 * POST /v2/tracking/:event_id — body { tracks: [athlete_id, ...] }
 *
 * Live tracking positions for a V2 (block-based) event. Same response body
 * as POST /v1/tracking, so the app's tracking map consumes both identically.
 *
 * V2 events don't carry timing data themselves: each v2.races row bridges to
 * the platform race that does (see services/v2bridge.js). Most events map to
 * one platform race; when there are several, each is queried with the full
 * athlete list and the results merged (first race to report an athlete wins —
 * athlete_ids are platform-scoped so collisions don't happen in practice).
 */
async function v2TrackingRoutes(app) {
  app.post('/:event_id', {
    schema: {
      params: {
        type: 'object',
        properties: { event_id: { type: 'string' } },
        required: ['event_id'],
      },
      body: {
        type: 'object',
        required: ['tracks'],
        properties: {
          tracks: { type: 'array', items: { type: ['integer', 'string'] } },
        },
      },
    },
  }, async (request, reply) => {
    const { event_id } = request.params;
    const tracks = (request.body.tracks || []).map(String);

    const races = await platformRacesForEvent(event_id);
    if (!races.length) return reply.code(404).send({ error: 'Event not found' });

    const seen = new Set();
    const merged = [];
    let lastMeta = null;

    // Worker-fed (V2-native) races take precedence: their live_state is the
    // source of truth and their cache is keyed on the v2 race id.
    const { rows: states } = await pool.query(
      "SELECT id, COALESCE(live_state,'idle') AS live_state FROM v2.races WHERE event_id = $1",
      [event_id]
    );
    const v2Live = new Set(states.filter((r) => ['armed', 'live', 'finalising', 'done'].includes(r.live_state)).map((r) => String(r.id)));

    for (const race of races) {
      let result;
      if (v2Live.has(String(race.id))) {
        result = await buildTrackingV2({ v2RaceId: race.id, eventId: event_id, tracks });
      } else if (race.platform_race_id) {
        result = await buildTracking({ raceId: Number(race.platform_race_id), tracks });
      } else {
        continue;
      }
      const { status, body } = result;
      if (status !== 200) continue;
      lastMeta = body;
      for (const t of (body.tracks || [])) {
        if (seen.has(t.track)) continue;
        seen.add(t.track);
        merged.push(t);
      }
    }

    if (!lastMeta) {
      return reply.code(404).send({ error: 'No timing data for this event' });
    }

    // Preserve the not-live metadata shape when nothing is reporting, so the
    // app can distinguish "quiet" from "not live" exactly as it does on v1.
    if (!merged.length && lastMeta.message) {
      return reply.code(200).send(lastMeta);
    }
    return reply.code(200).send({ tracks: merged });
  });
}

module.exports = v2TrackingRoutes;
