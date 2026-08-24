const pool = require('../config/database');

/**
 * A raceobj built from the V2 tables (v2.races / v2.contests / v2.splits /
 * v2.legs), shaped exactly like services/raceConfig.js builds one from the
 * platform tables — so the SAME splits pipeline (buildHeader +
 * athleteDetailV2) renders a V2 event that has no platform race behind it.
 *
 * Config is the source of truth in that pipeline, so every configured timing
 * point comes back whether or not the athlete has crossed it. That is what
 * lets the app draw the splits list before the first mat fires.
 */

/** RaceResult multi-language labels: "{EN:Finish|DE:Ziel|FR:Arrivée}". */
function rrText(v) {
  const raw = String(v ?? '').trim();
  const m = raw.match(/^\{(.*)\}$/);
  if (!m) return raw;
  const parts = m[1].split('|').map((x) => x.trim());
  const en = parts.find((x) => /^EN:/i.test(x));
  return (en ?? parts[0] ?? '').replace(/^[A-Z]{2}:/i, '').trim();
}

async function v2RaceObj(eventId) {
  const { rows: races } = await pool.query(
    `SELECT r.id, r.name, r.time_zone, r.status
       FROM v2.races r WHERE r.event_id = $1 ORDER BY r.id`,
    [eventId]
  );
  if (!races.length) return null;

  const raceIds = races.map((r) => r.id);
  const [{ rows: contests }, { rows: splits }, { rows: legs }, { rows: ev }] = await Promise.all([
    pool.query(
      `SELECT race_id, contest_id, name, distance_km, is_tracking, await_at_split, summary_split_ids
         FROM v2.contests WHERE race_id = ANY($1::bigint[]) ORDER BY race_id, sort_order, name`,
      [raceIds]
    ),
    pool.query(
      `SELECT id, race_id, contest_id, name, sort_order, visible, split_type, is_leg,
              accum_km, percent_course, default_speed, speed_adjust, fixed_elevation,
              send_push, push_type, rr_splitid
         FROM v2.splits WHERE race_id = ANY($1::bigint[]) ORDER BY race_id, contest_id, sort_order, id`,
      [raceIds]
    ),
    pool.query(
      `SELECT id, race_id, contest_id, label, icon, speed_type, distance_m, sort_order, rr_legid
         FROM v2.legs WHERE race_id = ANY($1::bigint[]) ORDER BY race_id, contest_id, sort_order, id`,
      [raceIds]
    ),
    pool.query('SELECT event_json FROM v2.events WHERE id = $1', [eventId]),
  ]);

  const events = contests.map((c) => {
    const key = String(c.contest_id);
    const mine = splits.filter((s) => String(s.race_id) === String(c.race_id)
                                   && String(s.contest_id) === key && !s.is_leg);
    return {
      id: key,
      contest_id: key,
      event_descr: rrText(c.name),
      distance: c.distance_km == null ? null : Number(c.distance_km),
      splits: mine.map((s) => ({
        id: Number(s.id),
        rr_splitid: s.rr_splitid != null && Number(s.rr_splitid) > 0 ? Number(s.rr_splitid) : 0,
        name: rrText(s.name),
        order: s.sort_order,
        type: s.split_type,
        // NUMERIC 1/0 — athleteDetailV2 does a strict `visible !== 1`.
        visible: s.visible === false ? 0 : 1,
        default_spd: s.default_speed,
        push: s.send_push === true,
        percent_course: s.percent_course == null ? null : Number(s.percent_course),
        push_type: s.push_type,
        split_type: s.split_type,
        speed_adjust: s.speed_adjust,
        split_distance: s.accum_km == null ? null : Number(s.accum_km),
        fixed_elevation: s.fixed_elevation == null ? null : Number(s.fixed_elevation),
      })),
      legs: legs.filter((l) => String(l.race_id) === String(c.race_id) && String(l.contest_id) === key)
        .map((l) => ({ id: Number(l.id), rr_splitid: l.rr_legid ?? 0, label: rrText(l.label),
                       icon: l.icon, speed_type: l.speed_type || 'speed',
                       distance: l.distance_m == null ? null : Number(l.distance_m) / 1000 })),
      live_cameras: [],
      medal: null, photo_link: null, cert_link: null,
      use_net_times: false, use_estimates: false,
      await_at_next_split: c.await_at_split === true,
      is_tracking: c.is_tracking === true,
      use_tracking_path: key,
      showRank: true, showPace: true,
      contest_type: null,
      display_settings: { type: 'tabbed_table', wide: false, show_pace: true, show_ranks: true,
                          show_elevation: false, elevation_type: 'altitude', linked_map: '',
                          use_estimates: false, use_net: false, leg_display: 'plain' },
    };
  });

  const race = races[0];
  return {
    r_id: race.id,
    timezone: race.time_zone || ev[0]?.event_json?.timeZone || 'UTC',
    islive: String(race.status || '').toLowerCase() === 'live',
    use_redis: false,
    israceresult: false,
    results_table: null,
    timing: { script: 'v2' },
    events,
  };
}

module.exports = { v2RaceObj, rrText };
