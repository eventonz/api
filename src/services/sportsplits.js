/**
 * Sportsplits (api.sportsplits.com/v2) — live team results for stage races
 * (Wines2Whales 2026). Nothing is stored: like RaceTec, the API asks
 * Sportsplits each time a team page is opened, with a short Redis cache so a
 * busy race day can't flood them (Sportsplits' own edge cache is ~60 s).
 *
 *   GET /races/{ss_race}/events/{event}/results/teams/race_no/{team}?splits=true
 *     → { race_event_team: { finish_time, overall_pos, overall_total, type_pos,
 *         type_total, splits: [{ split_id, name, tod, race_time, split_time,
 *         split_speed, leg_speed, overall_pos, type_pos }] } }
 *   404 "No Team found" = no result yet (not started / not entered).
 *
 * v2.races (migration 052): sportsplits_raceid, sportsplits_apikey,
 * sportsplits_live_stage, sportsplits_gc and the e-bike pair. An e-bike team
 * is an athlete row whose contest = sportsplits_ebike_gc.
 *
 * Checkpoint key: v2.splits.rr_splitid = contest * 1000 + split_id (Sportsplits
 * reuses split ids in every stage). Same rule in NEXTJS-CMS
 * lib/sportsplits-core.ts and evento-worker normalisers/sportsplits.js.
 */

const pool  = require('../config/database');
const redis = require('../config/redis');

const BASE        = 'https://api.sportsplits.com/v2';
const TIMEOUT_MS  = 10_000;
const CACHE_SECS  = 30;
const SPLIT_FACTOR = 1000;

const str = (v) => (v == null ? '' : String(v)).trim();

function splitKey(contestId, splitId) {
  return Number(contestId) * SPLIT_FACTOR + Number(splitId);
}

/** The Sportsplits settings of a v2 race, or null when it isn't a Sportsplits race. */
async function sportsplitsRace(v2RaceId) {
  const { rows } = await pool.query(
    `SELECT id, sportsplits_raceid, sportsplits_apikey, sportsplits_live_stage, sportsplits_gc,
            sportsplits_ebike_live_stage, sportsplits_ebike_gc
       FROM v2.races WHERE id = $1 AND timer_platform = 'sportsplits'`,
    [v2RaceId]
  ).catch(() => ({ rows: [] }));
  const r = rows[0];
  if (!r || !r.sportsplits_raceid || !r.sportsplits_apikey) return null;
  return r;
}

/**
 * Which stage + GC a team reads: the e-bike pair when the team's contest is the
 * e-bike GC, else the normal pair. GC falls back to Sportsplits event 1.
 */
function stagesFor(race, teamContest) {
  const ebike = race.sportsplits_ebike_gc && str(teamContest) === str(race.sportsplits_ebike_gc);
  return ebike
    ? { live: str(race.sportsplits_ebike_live_stage), gc: str(race.sportsplits_ebike_gc), ebike: true }
    : { live: str(race.sportsplits_live_stage), gc: str(race.sportsplits_gc) || '1', ebike: false };
}

/** A team's raceno + contest from v2.athletes (the app may send the athlete id or the bib). */
async function findTeam(v2RaceId, athleteId, bib) {
  const { rows } = await pool.query(
    `SELECT raceno, athlete_id, contest::text AS contest FROM v2.athletes
      WHERE race_id = $1 AND (athlete_id = $2 OR raceno = $3)
      ORDER BY (athlete_id = $2) DESC, updated_at DESC NULLS LAST, id DESC LIMIT 1`,
    [v2RaceId, str(athleteId), str(bib)]
  ).catch(() => ({ rows: [] }));
  return rows[0] || null;
}

/**
 * The team's result in one Sportsplits event: the race_event_team object, or
 * null when Sportsplits has none (404). Throws on network/5xx so callers can
 * fall back to pushed data. Cached CACHE_SECS (misses too).
 */
async function fetchTeamResult(race, eventId, teamNo) {
  const ssRace = race.sportsplits_raceid;
  const cacheKey = `ss:team:${ssRace}:${eventId}:${teamNo}`;
  try {
    const hit = await redis.get(cacheKey);
    if (hit) return JSON.parse(hit).team ?? null;
  } catch { /* fetch */ }

  const url = `${BASE}/races/${ssRace}/events/${encodeURIComponent(eventId)}/results/teams/race_no/${encodeURIComponent(teamNo)}?splits=true`;
  const res = await fetch(url, {
    headers: { 'X-API-KEY': race.sportsplits_apikey, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let team = null;
  if (res.status === 404) team = null;
  else if (!res.ok) throw new Error(`Sportsplits team result → HTTP ${res.status}`);
  else {
    const body = await res.json();
    team = body?.race_event_team && typeof body.race_event_team === 'object' ? body.race_event_team : null;
  }
  redis.set(cacheKey, JSON.stringify({ team }), 'EX', CACHE_SECS).catch(() => {});
  return team;
}

/** "Stage 2" → 2, "Prologue" → 0, else position + 1. */
function stageNumber(name, index) {
  const n = str(name);
  if (/prologue/i.test(n)) return 0;
  const m = /stage\s*(\d+)/i.exec(n);
  return m ? Number(m[1]) : index + 1;
}

/**
 * GC team result → rows for services/stages buildStagesDoc. Each GC "split" is
 * a stage: split_time = the stage time, race_time = GC time after it,
 * overall_pos = GC rank, type_pos = category rank.
 */
function gcStageRows(gcTeam, raceId, raceno) {
  const splits = Array.isArray(gcTeam?.splits) ? gcTeam.splits : [];
  return splits.map((s, i) => ({
    race_id: raceId,
    raceno,
    stage_no: stageNumber(s.name, i),
    stage_name: str(s.name),
    stage_time: str(s.split_time),
    stage_rank: null,
    gc_time: str(s.race_time),
    gc_rank: s.overall_pos ?? null,
    cat_rank: s.type_pos ?? null,
    gc_gap: null,
    updated_at: new Date().toISOString(),
  }));
}

module.exports = {
  SPLIT_FACTOR, splitKey, sportsplitsRace, stagesFor, findTeam, fetchTeamResult, stageNumber, gcStageRows,
};
