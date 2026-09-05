const pool = require('../../config/database');
const { buildSplits } = require('../../services/splits');
const { platformRacesForEvent } = require('../../services/v2bridge');
const { v2RaceObj } = require('../../services/v2RaceConfig');
const { buildHeader } = require('../../services/splits/buildHeader');
const athleteDetailV2 = require('../../services/splits/athleteDetailV2');
const v2rr = require('../../services/splits/v2rr');

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

    const races = await platformRacesForEvent(event_id);
    if (!races.length) return reply.code(404).send({ error: 'Event not found' });

    // `contest` naming a v2 race narrows to it; otherwise it's already an RR contest.
    const byRace = races.find((r) => String(r.id) === contestParam);
    const candidates = byRace ? [byRace] : races;
    let contest = byRace ? '' : contestParam;

    // --- V2-native path: the race's own redis_splits cache (written by the
    // provisioned-feed pull, keyed on the v2 race id). Takes precedence over
    // the platform-race bridge; a miss falls through untouched. ---
    if (athleteId) {
      for (const race of candidates) {
        const built = await buildFromV2Redis({
          v2RaceId: race.id, event_id, athleteId, bib, contest: contest || contestParam,
        });
        if (built) return reply.code(200).send(built);
      }
    }

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
    // No platform race behind this event — render from the V2 config itself,
    // so the contest and every configured timing point still come back (with
    // whatever times the athlete has). Same document, same builders.
    const built = await buildFromV2Config({ event_id, athleteId, bib, contest: contestParam });
    if (built) return reply.code(200).send(built);
    return reply.code(404).send({ error: 'No timing data for this event' });
  });
}

/**
 * Build the athlete-detail document from the v2-native redis_splits cache.
 * Returns null when the athlete has no cached records (caller falls through
 * to the platform bridge / v2 config path).
 */
async function buildFromV2Redis({ v2RaceId, event_id, athleteId, bib, contest }) {
  const raceobj = await v2RaceObj(event_id).catch(() => null);

  // Resolve the athlete's contest from v2.athletes when the app didn't send
  // a usable one (it may send its v2 race id instead of an RR contest).
  let contestId = String(contest || '').trim();
  const known = (raceobj?.events || []).some((e) => String(e.contest_id) === contestId);
  if (!known) contestId = '';
  if (!contestId && athleteId) {
    const { rows } = await pool.query(
      'SELECT contest::text FROM v2.athletes WHERE race_id = $1 AND athlete_id = $2 LIMIT 1',
      [v2RaceId, athleteId]
    ).catch(() => ({ rows: [] }));
    contestId = String(rows[0]?.contest || '').trim();
  }

  const result = await v2rr.transform({
    v2RaceId, athleteId, raceobj, contest: contestId,
  });
  if (!result) return null;

  const rObj = raceobj || { events: [], timezone: 'UTC' };
  const evt = (rObj.events || []).find(
    (e) => String(e.contest_id) === String(result.livetiming.contest_id)
  );
  const header = buildHeader(result.livetiming, rObj, { bib, athleteId, contest: contestId });
  return athleteDetailV2.build(result.livetiming, rObj, evt?.display_settings || {}, header);
}

/** Build the athlete-detail document from v2.contests / v2.splits / v2.rr_results. */
async function buildFromV2Config({ event_id, athleteId, bib, contest }) {
  const raceobj = await v2RaceObj(event_id);
  if (!raceobj || !raceobj.events.length) return null;

  // Which contest? The app sends its v2.races id or an RR contest; fall back to
  // the athlete's own contest, then to the only one.
  let contestId = String(contest || '').trim();
  if (!raceobj.events.some((e) => String(e.contest_id) === contestId)) contestId = '';
  if (!contestId && athleteId) {
    const { rows } = await pool.query(
      `SELECT a.contest::text FROM v2.athletes a JOIN v2.races r ON r.id = a.race_id
        WHERE r.event_id = $1 AND a.athlete_id = $2 LIMIT 1`,
      [event_id, athleteId]
    );
    contestId = String(rows[0]?.contest || '').trim();
  }
  if (!contestId) contestId = String(raceobj.events[0].contest_id);
  const evt = raceobj.events.find((e) => String(e.contest_id) === contestId) || raceobj.events[0];

  // The athlete's times from the finalised results table (v2.rr_results — one
  // row per athlete per RR split, written by the worker at Stop live), keyed
  // on rr_splitid so they line up with the configured timing points.
  const byRr = new Map();
  if (athleteId || bib) {
    const { rows } = await pool.query(
      `SELECT res.rr_splitid, res.split_tod, res.split_gun, res.split_chip, res.overall_rank,
              res.gender_rank, res.agegroup_rank, res.splitpace, res.splitspeed
         FROM v2.rr_results res JOIN v2.races r ON r.id = res.race_id
        WHERE r.event_id = $1
          AND (res.athlete_id = $2 OR ($3 <> '' AND res.race_no::text = $3))`,
      [event_id, String(athleteId || ''), String(bib || '')]
    );
    for (const row of rows) if (row.rr_splitid) byRr.set(String(row.rr_splitid), row);
  }
  const timeFor = (cfg) => byRr.get(String(cfg.rr_splitid || '')) || null;
  const finishCfg = evt.splits.find((c) => String(c.split_type || c.type || '').toLowerCase() === 'finish')
    || evt.splits[evt.splits.length - 1];
  const finishRow = finishCfg ? timeFor(finishCfg) : null;
  const timed = evt.splits.filter((c) => (timeFor(c)?.split_tod || '') !== '').length;

  const livetiming = {
    contest_id: evt.contest_id,
    contest_name: evt.event_descr,
    contest_distance: evt.distance,
    finish_status: finishRow?.split_gun ? 4 : (timed ? 3 : 2),
    result: finishRow?.split_gun || '',
    overall_place: finishRow?.overall_rank ?? '',
    overall_gen_place: finishRow?.gender_rank ?? '',
    overall_cat_place: finishRow?.agegroup_rank ?? '',
    avg_pace: finishRow?.splitpace ?? '',
    showPace: evt.showPace,
    showRank: evt.showRank,
    // Config is merged in by buildHeader; these carry whatever times exist.
    splits: evt.splits.map((cfg) => {
      const t = timeFor(cfg) || {};
      return { id: cfg.id, RaceTime: t.split_gun ?? '', tod: t.split_tod ?? '',
               split_pace: t.splitpace ?? '', split_speed: t.splitspeed ?? '',
               overall_place: t.overall_rank ?? '', gen_place: t.gender_rank ?? '', cat_place: t.agegroup_rank ?? '' };
    }),
    legs: [],
  };

  const header = buildHeader(livetiming, raceobj, { bib, athleteId, contest: contestId });
  return athleteDetailV2.build(livetiming, raceobj, evt.display_settings, header);
}

module.exports = v2SplitsRoutes;
