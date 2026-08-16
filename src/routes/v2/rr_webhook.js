const pool = require('../../config/database');

/**
 * RaceResult participant webhook — V2 edition.
 *
 * POST /v2/rr_webhook/:race_id   (race_id = v2.races.id)
 *
 * The CMS registers this URL into the RaceResult event's webhooks
 * ("Evento Participant Update" Type 1 / "Evento New Participant" Type 0,
 * Fields BIB, ID, FIRSTNAME, LASTNAME, CONTEST.ID, CONTEST.NAME — same
 * payload as /v1/rr_webhook). Public like v1: the race id in the URL is the
 * gate, and the row must exist in v2.races.
 *
 * Upserts straight into v2.athletes: identity = athlete_id (RR pid) when
 * present, bib (raceno) otherwise.
 */
async function rrWebhookV2Routes(app) {
  app.post('/:race_id', {
    schema: {
      params: {
        type: 'object',
        properties: { race_id: { type: 'integer' } },
        required: ['race_id'],
      },
      body: {
        type: 'object',
        properties: { Values: { type: 'object' } },
        required: ['Values'],
      },
    },
  }, async (request, reply) => {
    const raceId = request.params.race_id;
    const values = request.body.Values;

    const { rows: raceRows } = await pool.query('SELECT id FROM v2.races WHERE id = $1', [raceId]);
    if (raceRows.length === 0) {
      return reply.code(404).send({ status: 'error', message: `No v2 race ${raceId}.` });
    }

    const athleteId = String(values.ID ?? '').trim();
    const bib       = String(values.BIB ?? '').trim();
    const firstName = String(values.FIRSTNAME ?? '').trim();
    const lastName  = String(values.LASTNAME ?? '').trim();
    const fullName  = `${firstName} ${lastName}`.trim();
    const contestId = Number(values['CONTEST.ID']);
    const contest   = Number.isFinite(contestId) && contestId > 0 ? contestId : null;
    const contestNm = String(values['CONTEST.NAME'] ?? '').trim();

    if (!athleteId && !bib) {
      return reply.code(422).send({ status: 'error', message: 'Need BIB or ID in Values.' });
    }
    if (!fullName) {
      return reply.code(422).send({ status: 'error', message: 'Need FIRSTNAME/LASTNAME in Values.' });
    }

    const { rows: existing } = await pool.query(
      athleteId
        ? 'SELECT id FROM v2.athletes WHERE race_id = $1 AND athlete_id = $2 LIMIT 1'
        : 'SELECT id FROM v2.athletes WHERE race_id = $1 AND raceno = $2 LIMIT 1',
      [raceId, athleteId || bib]
    );

    let action;
    if (existing.length > 0) {
      await pool.query(
        `UPDATE v2.athletes
         SET name = $2, first_name = $3, last_name = $4,
             raceno = COALESCE(NULLIF($5, ''), raceno),
             athlete_id = COALESCE(NULLIF($6, ''), athlete_id),
             contest = COALESCE($7, contest),
             -- info line 1 = contest name, line 2 = club: replace only line 1
             -- so a participant webhook never wipes the club.
             info = CASE
               WHEN NULLIF($8, '') IS NULL THEN info
               WHEN info LIKE E'%\n%' THEN $8 || substring(info FROM position(E'\n' IN info))
               ELSE $8
             END,
             updated_at = now()
         WHERE id = $1`,
        [existing[0].id, fullName, firstName || null, lastName || null, bib, athleteId, contest, contestNm]
      );
      action = 'updated';
    } else {
      await pool.query(
        `INSERT INTO v2.athletes (race_id, raceno, athlete_id, name, first_name, last_name, contest, info, can_follow)
         VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6, $7, NULLIF($8, ''), true)`,
        [raceId, bib, athleteId, fullName, firstName || null, lastName || null, contest, contestNm]
      );
      action = 'inserted';
    }

    return reply.code(200).send({ status: 'success', action });
  });
}

module.exports = rrWebhookV2Routes;
