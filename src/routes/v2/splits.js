const pool = require('../../config/database');
const { buildSplits } = require('../../services/splits');

/**
 * GET /v2/splits/:event_id?id=&contest=&bib=
 *
 * Live athlete detail for a V2 (block-based) event — the same `version2`
 * page document /v1/splits/race/{race_id} returns, so the app's LiveAthlete
 * mapper and every athlete-page block work unchanged.
 *
 * V2 events don't carry timing data themselves: each v2.races row bridges to
 * the platform race that does (v2.races.v1_race_id, or the public.races row
 * sharing its rr_raceid — the RR webhook / Redis pull pipeline is keyed on
 * that). The app sends `contest` = the v2.races id it knows the athlete by;
 * that is swapped for the athlete's real RR contest (v2.athletes.contest) so
 * the transformer resolves splits config for the right stage.
 */
async function v2SplitsRoutes(app) {
  app.get('/:event_id', {
    schema: {
      params: { type: 'object', properties: { event_id: { type: 'string' } }, required: ['event_id'] },
      querystring: { type: 'object', properties: {
        id: { type: 'string' }, bib: { type: 'string' }, contest: { type: 'string' },
      } },
    },
  }, async (request, reply) => {
    const { event_id } = request.params;
    const q = request.query || {};
    const athleteId = (q.id || '').trim();
    const bib = (q.bib || q.id || '').trim();
    const contestParam = (q.contest || '').trim();

    const { rows: races } = await pool.query(
      `SELECT r.id, r.v1_race_id, r.rr_raceid,
              COALESCE(r.v1_race_id, (SELECT p.id FROM public.races p WHERE p.rr_raceid = r.rr_raceid ORDER BY p.id DESC LIMIT 1)) AS platform_race_id
       FROM v2.races r WHERE r.event_id = $1 ORDER BY r.id`,
      [event_id]
    );
    if (!races.length) return reply.code(404).send({ error: 'Event not found' });

    // `contest` naming a v2 race narrows to it; otherwise it's already an RR contest.
    const byRace = races.find((r) => String(r.id) === contestParam);
    const candidates = byRace ? [byRace] : races;
    let contest = byRace ? '' : contestParam;

    for (const race of candidates) {
      if (!race.platform_race_id) continue;
      if (!contest && athleteId) {
        const { rows } = await pool.query(
          'SELECT contest FROM v2.athletes WHERE race_id = $1 AND athlete_id = $2 LIMIT 1',
          [race.id, athleteId]
        );
        contest = String(rows[0]?.contest ?? '').trim();
      }
      const { status, body } = await buildSplits({
        raceId: Number(race.platform_race_id), bib, athleteId, contest,
      });
      if (status === 200) return reply.code(200).send(body);
    }
    return reply.code(404).send({ error: 'No timing data for this event' });
  });
}

module.exports = v2SplitsRoutes;
