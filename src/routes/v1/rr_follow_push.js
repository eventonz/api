/**
 * Finish-notification ingest for followed RaceResult participants.
 *
 * The "Evento Finish Notifications" exporter (created from the CMS) pushes one
 * crossing struct per athlete here. We only act on FINISH crossings: match the
 * athlete against rr_follows, claim each not-yet-notified follower atomically
 * (so a replayed finish can't double-send), and enqueue to the existing
 * athlete_push_queue → push-worker → OneSignal.
 *
 * Public + URL-gated by rr_eventid, same as /v1/tracks/*.
 */

const pool  = require('../../config/database');
const redis = require('../../config/redis');
const { raceconfigByRaceResult } = require('../../services/raceConfig');

// Minutes between a HH:MM:SS time-of-day and now in the race timezone.
// Mirrors services/trackPush.js so old replays are suppressed.
function minutesSinceTod(tod, timezone) {
  try {
    const nowStr = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || 'UTC',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date());
    return (timeToSeconds(nowStr) - timeToSeconds(String(tod ?? ''))) / 60;
  } catch {
    return 0; // malformed → treat as fresh, don't suppress
  }
}
function timeToSeconds(str) {
  const p = str.split('.')[0].split(':');
  return (parseInt(p[0], 10) || 0) * 3600 + (parseInt(p[1], 10) || 0) * 60 + (parseInt(p[2], 10) || 0);
}

function isTruthy(v) {
  return v === 1 || v === '1' || v === true || v === 'true';
}

async function rrFollowPushRoutes(app) {
  app.post('/:rr_eventid', {
    schema: {
      params: {
        type: 'object',
        properties: { rr_eventid: { type: 'integer' } },
        required: ['rr_eventid'],
      },
    },
  }, async (request, reply) => {
    const rrId = request.params.rr_eventid;
    // Body is JSON when sent as application/json; tolerate a text/plain string too.
    let body = request.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { return reply.code(202).send({ status: 'unparseable' }); }
    }
    // The exporter sends a single struct; accept an array too, just in case.
    const items = Array.isArray(body) ? body : [body];
    const finishes = items.filter((it) => it && isTruthy(it.finish));

    // Nothing to do for start/split crossings — ack and move on.
    if (finishes.length === 0) return reply.code(202).send({ status: 'ignored' });

    let raceobj;
    try {
      raceobj = await raceconfigByRaceResult(rrId);
    } catch (err) {
      request.log.error({ err, rrId }, 'rr_follow_push: race config lookup failed');
      return reply.code(202).send({ status: 'no_event' });
    }
    if (!raceobj || !raceobj.r_id) return reply.code(202).send({ status: 'no_event' });

    let queued = 0;
    for (const item of finishes) {
      const athleteId = String(item.athlete_id ?? '');
      if (!athleteId) continue;

      const tod = item.tod ?? '';
      // Suppress stale replays (unless the race is in live test mode).
      if (!raceobj.live_test_mode && minutesSinceTod(tod, raceobj.timezone) >= 5) {
        continue;
      }

      // Atomic claim: take only followers not yet notified, flip them, return
      // their player_ids. A replayed finish finds 0 rows → no second push.
      const { rows } = await pool.query(
        `UPDATE rr_follows SET notified = true
         WHERE rr_eventid = $1 AND athlete_id = $2 AND notified = false
         RETURNING player_id`,
        [rrId, athleteId]
      );
      if (rows.length === 0) continue;

      const name = `${item.firstname ?? ''} ${item.lastname ?? ''}`.trim() || (item.name ?? 'Your athlete');
      const raceTime = item.race_time ?? '';
      const entry = JSON.stringify({
        raceNo: String(item.bib ?? ''),
        athlete_id: athleteId,
        race_id: Number(raceobj.r_id),
        name,
        race_name: raceobj.race_name,
        splitname: 'Finish',
        racetime: raceTime,
        os_appid: raceobj.onesignal_id,
        os_restkey: raceobj.onesignal_restkey,
        message: `${name} has finished in a time of ${raceTime} (Provisional)`,
        split_tod: tod,
        timezone: raceobj.timezone,
        include_player_ids: rows.map((r) => r.player_id).filter(Boolean),
      });
      await redis.rpush('athlete_push_queue', entry);
      queued += rows.length;
    }

    return reply.code(202).send({ status: 'queued', recipients: queued });
  });
}

module.exports = rrFollowPushRoutes;
