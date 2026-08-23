const pool = require('../config/database');

/**
 * V2 (block-based) events carry no timing of their own yet: each v2.races row
 * bridges to the platform race that does — v2.races.v1_race_id, else the
 * public.races row sharing its rr_raceid (what the RR pull/webhook pipeline
 * and the Redis splits snapshot are keyed on).
 *
 * Returns [{ id, platform_race_id }] for the event, in race order.
 */
async function platformRacesForEvent(eventId) {
  const { rows } = await pool.query(
    `SELECT r.id, r.v1_race_id, r.rr_raceid,
            COALESCE(r.v1_race_id,
                     (SELECT p.id FROM public.races p WHERE p.rr_raceid = r.rr_raceid ORDER BY p.id DESC LIMIT 1)) AS platform_race_id
     FROM v2.races r WHERE r.event_id = $1 ORDER BY r.id`,
    [eventId]
  );
  return rows;
}

module.exports = { platformRacesForEvent };
