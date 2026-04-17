/**
 * Race Config Service — Stage 1 of the tracks pipeline
 *
 * Mirrors CF udf.cfc: raceconfig(), raceconfigsportsplits(),
 * raceconfigracetec(), raceconfigraceresult(), and raceObjData().
 *
 * Cache keys (shared with ColdFusion):
 *   raceobj:race:{r_id}          — canonical key, used by all lookup paths
 *   raceobj:ss:{ss_raceid}       — SportSplits lookup
 *   raceobj:racetec:{apikey}     — RaceTec lookup
 *
 * TTL: 300s (5 minutes) — matches CF
 */

const pool  = require('../config/database');
const redis = require('../config/redis');

const CACHE_TTL = 300;

// ---------------------------------------------------------------------------
// Internal: build raceobj from DB. `whereClause` / `params` select the race.
// ---------------------------------------------------------------------------
async function buildRaceObj(whereClause, params) {
  const { rows } = await pool.query(
    `SELECT
       races.id,
       races.marker_text,
       races.time_zone,
       races.racetec_apikey,
       races.racetec_baseurl,
       races.event_name,
       races.testmode,
       races.use_redis,
       races.edition,
       races.results_table,
       races.timer,
       races.islive,
       races.israceresult,
       races.race_data,
       races.appid,
       races.rr_results,
       races.rr_splits,
       races.rr_eventid,
       races.rr_startlist,
       races.rr_results_type,
       races.split_script,
       races.ss_raceid,
       races.send_push,
       races.logsplits,
       races.logpush,
       races.logtracks,
       races.logprocessed,
       races.tracking_scriptv3,
       races.rr_payloadtype,
       races.athlete_key,
       races.raceno_bib_limit,
       races.data_reception_start,
       races.data_reception_end,
       races.live_test_mode,
       apps.onesignal_id,
       apps.onesignal_restkey,
       timers.name          AS timer_name,
       timers.platform_id,
       timers.script        AS timer_script,
       platforms.name       AS platform,
       platform_settings.rr_startlist    AS platform_rr_startlist,
       platform_settings.rr_results      AS platform_rr_results,
       platform_settings.rr_splits       AS platform_rr_splits,
       platform_settings.racetec_baseurl AS platform_racetec_baseurl,
       platform_settings.racetec_apikey  AS platform_racetec_apikey,
       platform_settings.ss_raceid       AS platform_ss_raceid,
       platform_settings.rr_eventid      AS platform_rr_eventid
     FROM races
     INNER JOIN apps             ON races.appid         = apps.id
     LEFT JOIN  timers           ON races.timer_id      = timers.id
     LEFT JOIN  platforms        ON timers.platform_id  = platforms.id
     LEFT JOIN  platform_settings ON platform_settings.race_id = races.id
     WHERE ${whereClause}
     LIMIT 1`,
    params
  );

  if (rows.length === 0) return null;

  const r    = rows[0];
  const r_id = r.id;

  // --- Timing sub-object (mirrors CF platform_id switch) ---
  const timing = {
    name:     r.timer_name ?? '',
    platform: r.platform   ? r.platform.toLowerCase()     : '',
    script:   r.timer_script ? r.timer_script.toLowerCase() : '',
  };

  if (r.platform_id == 1) {
    timing.ss_raceid = r.ss_raceid;
  } else if (r.platform_id == 2) {
    timing.racetec_apikey  = r.racetec_apikey;
    timing.racetec_baseurl = r.racetec_baseurl;
  } else if (r.platform_id == 3) {
    timing.rr_eventid    = r.rr_eventid;
    timing.rr_results    = r.rr_results;
    timing.rr_startlist  = r.rr_startlist;
    timing.rr_splits     = r.rr_splits;
    timing.results_table = r.results_table;
  }

  const raceobj = {
    r_id,
    race_name:           r.event_name,
    timezone:            r.time_zone,
    appid:               r.appid,
    onesignal_id:        r.onesignal_id,
    onesignal_restkey:   r.onesignal_restkey,
    split_script:        r.split_script,
    tracking_scriptv3:   r.tracking_scriptv3,
    test_mode:           r.testmode        == 1,
    live_test_mode:      r.live_test_mode  == 1,
    islive:              r.islive          == 1,
    israceresult:        r.israceresult    == 1,
    send_push:           r.send_push       == 1,
    use_redis:           r.use_redis       == 1,
    log_splits:          r.logsplits       == 1,
    log_push:            r.logpush         == 1,
    log_tracks:          r.logtracks       == 1,
    log_processed:       r.logprocessed    == 1,
    edition:             r.edition,
    ss_raceid:           r.ss_raceid,
    racetec_apikey:      r.racetec_apikey,
    racetec_baseurl:     r.racetec_baseurl,
    rr_results:          r.rr_results      ?? '',
    rr_startlist:        r.rr_startlist    ?? '',
    timer:               r.timer           ?? '',
    marker_text:         r.marker_text     ?? '',
    rr_payloadtype:      r.rr_payloadtype  ?? '',
    athlete_key:         r.athlete_key?.trim() || 'athlete_id',
    raceno_bib_limit:    (r.raceno_bib_limit != null && !isNaN(r.raceno_bib_limit))
                           ? Number(r.raceno_bib_limit) : 0,
    data_reception_start: r.data_reception_start ?? null,
    data_reception_end:   r.data_reception_end   ?? null,
    results_table:       r.results_table ?? '',
    race_data:           parseJson(r.race_data, {}),
    writtenfrom:         'node-api',
    timing,
    events: [],
  };

  // --- Events → splits + legs + live cameras (all in parallel per event) ---
  // Note: the CF query aliases events.id as event_id throughout.
  const { rows: eventRows } = await pool.query(
    'SELECT *, id AS event_id FROM events WHERE race_id = $1',
    [r_id]
  );

  raceobj.events = await Promise.all(eventRows.map((ev) => buildEventObj(ev, r_id)));

  return raceobj;
}

async function buildEventObj(ev, r_id) {
  const [{ rows: splitRows }, { rows: legRows }, { rows: cameraRows }] = await Promise.all([
    // Splits for this event (ordered by split_order)
    pool.query(
      'SELECT * FROM splits WHERE event_id = $1 ORDER BY split_order ASC',
      [ev.event_id]
    ),
    // Legs — CF uses contest_id as the FK into legs.event_id (intentional schema choice)
    pool.query(
      `SELECT * FROM legs
       WHERE event_id = $1 AND race_id = $2 AND display = 1
       ORDER BY sort_order ASC, id ASC`,
      [ev.contest_id, r_id]
    ),
    // Live cameras for this event
    pool.query(
      `SELECT id, split_id, yt_video_id, start_time, label
       FROM live_cameras
       WHERE race_id = $1 AND event_id = $2
       ORDER BY split_id ASC`,
      [r_id, ev.event_id]
    ),
  ]);

  const splits = splitRows.map((s) => ({
    id:              s.split_id,
    rr_splitid:      (s.rr_splitid != null && Number(s.rr_splitid) > 0) ? Number(s.rr_splitid) : 0,
    name:            s.split_name,
    order:           s.split_order,
    type:            s.type,
    visible:         s.visible,
    default_spd:     s.default_speed,
    push:            s.sendpush,   // PG lowercases column names
    percent_course:  s.percent_course,
    push_type:       s.push_type,
    split_type:      s.split_type,
    speed_adjust:    s.speed_adjust,
    split_distance:  s.accum_distance,
    fixed_elevation: s.fixed_elevation,
  }));

  const legs = legRows.map((l) => ({
    label:      l.label,
    start:      l.start_id,
    end:        l.end_id,
    rr_splitid: l.rr_splitid,
    distance:   l.distance,
    icon:       l.icon       ?? '',
    speed_type: l.speed_type ?? 'speed',
  }));

  const live_cameras = cameraRows.map((c) => ({
    id:          c.id,
    split_id:    c.split_id,
    yt_video_id: c.yt_video_id,
    start_time:  c.start_time,
    label:       c.label,
  }));

  return {
    id:               ev.event_id,
    event_code:       ev.event_code,
    contest_id:       ev.contest_id,
    event_descr:      ev.eventdescr,
    distance:         ev.distance,
    split_script:     ev.split_script,
    splits,
    legs,
    live_cameras,
    racedata:         ev.race_data,
    medal:            ev.medal_url,
    photo_link:       ev.photo_link,
    cert_link:        ev.cert_link,
    use_net_times:    ev.use_net_times       == 1,
    await_at_next_split: ev.await_at_next_split == 1,
    // If use_tracking_path is blank, default to contest_id (matches CF)
    use_tracking_path: ev.use_tracking_path?.trim()
                         ? ev.use_tracking_path
                         : String(ev.contest_id),
    use_estimates:    ev.use_estimates  == 1,
    is_tracking:      ev.is_tracking    == 1,
    showRank:         ev.showrank       == 1,  // PG lowercases
    showPace:         ev.showpace       == 1,
    fourth_col:       ev.fourth_col,
    contest_type:     ev.contest_type,
    display_settings: {
      type:           ev.ad_display_type?.trim()   || 'journey',
      wide:           !!ev.ad_wide,
      show_pace:      !!ev.ad_show_pace,
      show_ranks:     !!ev.ad_show_ranks,
      show_elevation: !!ev.ad_show_elevation,
      elevation_type: ev.ad_elevation_type?.trim() || 'altitude',
      linked_map:     ev.ad_linked_map?.trim()     || '',
      use_estimates:  ev.use_estimates  == 1,
      use_net:        ev.use_net_times  == 1,
      leg_display:    ev.leg_display?.trim()       || 'plain',
    },
  };
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------
async function fromCache(key) {
  const raw = await redis.get(key);
  return raw ? JSON.parse(raw) : null;
}

async function toCache(key, raceobj) {
  await redis.setex(key, CACHE_TTL, JSON.stringify(raceobj));
}

// ---------------------------------------------------------------------------
// Public API — mirrors the four CF raceconfig* functions
// ---------------------------------------------------------------------------

/** Load raceobj by Evento race ID (canonical). */
async function raceconfigByRaceId(race_id) {
  const key    = `raceobj:race:${race_id}`;
  const cached = await fromCache(key);
  if (cached) return cached;

  const raceobj = await buildRaceObj('races.id = $1', [race_id]);
  if (raceobj) await toCache(key, raceobj);
  return raceobj;
}

/** Load raceobj by SportSplits race ID. */
async function raceconfigBySportSplits(ss_raceid) {
  const key    = `raceobj:ss:${ss_raceid}`;
  const cached = await fromCache(key);
  if (cached) return cached;

  const raceobj = await buildRaceObj('races.ss_raceid = $1', [ss_raceid]);
  if (raceobj) await toCache(key, raceobj);
  return raceobj;
}

/** Load raceobj by RaceTec API key. */
async function raceconfigByRaceTec(racetec_apikey) {
  const key    = `raceobj:racetec:${racetec_apikey}`;
  const cached = await fromCache(key);
  if (cached) return cached;

  const raceobj = await buildRaceObj("races.racetec_apikey = $1", [racetec_apikey]);
  if (raceobj) await toCache(key, raceobj);
  return raceobj;
}

/**
 * Load raceobj by RaceResult event ID.
 * Resolves to the Evento race ID then delegates to raceconfigByRaceId
 * so both lookup paths share the same raceobj:race:{r_id} cache key.
 */
async function raceconfigByRaceResult(rr_eventid) {
  const { rows } = await pool.query(
    'SELECT id FROM races WHERE rr_eventid = $1 LIMIT 1',
    [rr_eventid]
  );
  if (rows.length === 0) return null;
  return raceconfigByRaceId(rows[0].id);
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function parseJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

module.exports = {
  raceconfigByRaceId,
  raceconfigBySportSplits,
  raceconfigByRaceTec,
  raceconfigByRaceResult,
};
