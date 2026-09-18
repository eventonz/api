/**
 * Worker handler for endpoint `rr_webhook`.
 *
 * Mirrors the legacy inline behavior previously in src/routes/v1/rr_webhook.js:
 *   1. Apply bib limit + race edition
 *   2. Atomic upsert (ON CONFLICT race_id + athlete_id), edition on insert and update
 *   3. Write Redis observation entries
 *
 * Runs entirely from queued jobs — no HTTP response involved.
 */

const pool  = require('../../config/database');
const redis = require('../../config/redis');

async function handleRrWebhook(race_id, body) {
  if (!body?.Values) {
    console.warn('[worker] rr_webhook: missing Values', { race_id });
    return;
  }
  const values = body.Values;

  const athleteId   = String(values.ID ?? '');
  const firstName   = String(values.FIRSTNAME ?? '');
  const lastName    = String(values.LASTNAME  ?? '');
  const fullName    = `${firstName} ${lastName}`.trim();
  const rawBib      = parseInt(values.BIB, 10) || 0;

  // Missing contest → 99 with a placeholder name (mirrors the CF handler).
  const contestId   = values['CONTEST.ID'] != null ? values['CONTEST.ID'] : 99;
  const contestName = contestId === 99
    ? 'No Contest assigned'
    : String(values['CONTEST.NAME'] ?? '');

  // 1. Race config — bib limit + edition. Bibs above the limit are dynamic
  //    placeholders and stored blank; edition falls back to the current year.
  const { rows: raceRows } = await pool.query(
    'SELECT raceno_bib_limit, edition FROM races WHERE id = $1 LIMIT 1',
    [race_id]
  );
  const race     = raceRows[0] ?? {};
  const bibLimit = race.raceno_bib_limit != null ? parseInt(race.raceno_bib_limit, 10) : null;
  const bibNo    = (bibLimit !== null && rawBib > bibLimit) ? '' : String(values.BIB ?? '');
  const edition  = race.edition != null && String(race.edition).trim() !== ''
    ? String(race.edition)
    : String(new Date().getFullYear());

  // 2. Atomic upsert on uq_athletes_race_athlete (race_id, athlete_id) —
  //    edition is written on both insert and update, like the CF handler.
  const { rows } = await pool.query(
    `INSERT INTO athletes (race_id, athlete_id, raceno, name, first_name, last_name, contest, info, edition)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (race_id, athlete_id) DO UPDATE SET
       name       = EXCLUDED.name,
       first_name = EXCLUDED.first_name,
       last_name  = EXCLUDED.last_name,
       raceno     = EXCLUDED.raceno,
       contest    = EXCLUDED.contest,
       info       = EXCLUDED.info,
       edition    = EXCLUDED.edition
     RETURNING (xmax = 0) AS inserted`,
    [race_id, athleteId, bibNo, fullName, firstName, lastName, contestId, contestName, edition]
  );
  const action = rows[0]?.inserted ? 'inserted' : 'updated';

  // 3. Observation log
  logWebhookObservation(race_id, { athleteId, bibNo, firstName, lastName, action }).catch(() => {});
}

async function logWebhookObservation(race_id, { athleteId, bibNo, firstName, lastName, action }) {
  const ts      = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const raceStr = String(race_id);

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

module.exports = { handleRrWebhook };
