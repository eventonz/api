const pool  = require('../../config/database');
const redis = require('../../config/redis');

async function rrWebhookRoutes(app) {
  // ---------------------------------------------------------------------------
  // POST /rr_webhook/:race_id
  // RaceResult participant_update webhook — upserts athlete from RR Values struct.
  // Body: { Values: { ID, BIB, FIRSTNAME, LASTNAME, "CONTEST.ID", "CONTEST.NAME" } }
  // ---------------------------------------------------------------------------
  app.post('/:race_id', {
    schema: {
      params: {
        type: 'object',
        properties: { race_id: { type: 'integer' } },
        required: ['race_id'],
      },
      body: {
        type: 'object',
        properties: {
          Values: { type: 'object' },
        },
        required: ['Values'],
      },
    },
  }, async (request, reply) => {
    const { race_id } = request.params;
    const values      = request.body.Values;

    const athleteId   = String(values.ID   ?? '');
    const firstName   = String(values.FIRSTNAME ?? '');
    const lastName    = String(values.LASTNAME  ?? '');
    const fullName    = `${firstName} ${lastName}`.trim();
    const rawBib      = parseInt(values.BIB, 10) || 0;
    const contestId   = values['CONTEST.ID']   ?? null;
    const contestName = values['CONTEST.NAME'] ?? '';

    // 1. Check bib limit — if bib exceeds it, treat as dynamic/placeholder (no bib)
    const { rows: limitRows } = await pool.query(
      'SELECT raceno_bib_limit FROM races WHERE id = $1 LIMIT 1',
      [race_id]
    );
    const bibLimit = limitRows.length > 0 && limitRows[0].raceno_bib_limit != null
      ? parseInt(limitRows[0].raceno_bib_limit, 10)
      : null;
    const bibNo = (bibLimit !== null && rawBib > bibLimit) ? '' : String(values.BIB ?? '');

    // 2. Upsert athlete — look up by race_id + athlete_id (bib can change)
    const { rows: existing } = await pool.query(
      'SELECT id FROM athletes WHERE race_id = $1 AND athlete_id = $2 LIMIT 1',
      [race_id, athleteId]
    );

    let action;
    if (existing.length > 0) {
      await pool.query(
        `UPDATE athletes
         SET name = $1, first_name = $2, last_name = $3, raceno = $4, contest = $5, info = $6
         WHERE race_id = $7 AND athlete_id = $8`,
        [fullName, firstName, lastName, bibNo, contestId, contestName, race_id, athleteId]
      );
      action = 'updated';
    } else {
      await pool.query(
        `INSERT INTO athletes (race_id, athlete_id, raceno, name, first_name, last_name, contest, info)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [race_id, athleteId, bibNo, fullName, firstName, lastName, contestId, contestName]
      );
      action = 'inserted';
    }

    // 3. Redis observation log — fire and forget, never blocks response
    logWebhookObservation(race_id, { athleteId, bibNo, firstName, lastName, action }).catch(() => {});

    return reply.send({ status: 'ok', action });
  });
}

// ---------------------------------------------------------------------------
// Mirrors CF observation logging in rr_webhook.cfm
// Keys: observe:webhook:count/{last}/{ids}/{feed}
// ---------------------------------------------------------------------------
async function logWebhookObservation(race_id, { athleteId, bibNo, firstName, lastName, action }) {
  const ts      = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const raceStr = String(race_id);

  // Read cached race name (set elsewhere by the push acceptance flow)
  const raceName = await redis.get(`observe:push:accepted:name:${race_id}`) ?? '';

  const entry = JSON.stringify({
    ts,
    r_id:       race_id,
    name:       raceName,
    athlete_id: athleteId,
    bib:        bibNo,
    firstname:  firstName,
    lastname:   lastName,
    action,
  });

  const TTL = 604800; // 7 days

  await Promise.all([
    redis.incr(`observe:webhook:count:${race_id}`).then(() =>
      redis.expire(`observe:webhook:count:${race_id}`, TTL)
    ),
    redis.set(`observe:webhook:last:${race_id}`, ts).then(() =>
      redis.expire(`observe:webhook:last:${race_id}`, TTL)
    ),
    redis.sadd(`observe:webhook:ids`, raceStr),
    redis.rpush(`observe:webhook:feed`, entry).then(() =>
      redis.ltrim(`observe:webhook:feed`, -200, -1)
    ),
  ]);
}

module.exports = rrWebhookRoutes;
