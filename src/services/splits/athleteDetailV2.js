/**
 * Athlete detail v2 page builder.
 * Mirrors API/api/v4/modules/split_scripts/athlete_detail_v2.cfm
 *
 * Renders the merged livetiming struct into results.version2.items[]
 * using contest display_settings to choose journey / plain_table / tabbed_table.
 * Then appends the Legs section (sportsplits leg_result is already populated).
 */

function isStarred(s) { return typeof s === 'string' && s.startsWith('*'); }
function stripStar(s)  { return isStarred(s) ? s.slice(1) : s; }

function readDisplaySettings(ds) {
  if (ds && 'type' in ds) {
    return {
      type:           ds.type || 'tabbed_table',
      wide:           !!ds.wide,
      showPace:       !!ds.show_pace,
      showRanks:      !!ds.show_ranks,
      showElevation:  !!ds.show_elevation,
      useEstimates:   !!ds.use_estimates,
      useNet:         !!ds.use_net,
      elevationType:  ds.elevation_type || 'altitude',
      linkedMap:      ds.linked_map || '',
      legDisplay:     ds.leg_display === 'infolist' ? 'infolist' : 'plain',
      journeyColor:   ds.journey_color || 'green',
    };
  }
  return {
    type: 'tabbed_table', wide: false,
    showPace: true, showRanks: true, showElevation: true,
    useEstimates: true, useNet: false,
    elevationType: 'altitude', linkedMap: '',
    legDisplay: 'plain', journeyColor: 'green',
  };
}

function lastActualSplitIndex(splits) {
  let last = -1;
  for (let i = 0; i < splits.length; i++) {
    const sp = splits[i];
    if (sp.visible === 1 && sp.RaceTime && !isStarred(sp.RaceTime)) last = i;
  }
  return last;
}

// ---------------------------------------------------------------------------
// Finish placement infolist
// ---------------------------------------------------------------------------
function insertFinishInfolist(items, livetiming) {
  const genderLabel   = livetiming.gender_name   || 'Gender';
  const categoryLabel = livetiming.category_name || 'Category';

  const ovrGen = String(livetiming.overall_gen_place || '').trim();
  const ovrCat = String(livetiming.overall_cat_place || '').trim();
  const ovrAll = String(livetiming.overall_place     || '').trim();

  const data = [
    { icon: 'gender',   name: genderLabel,   value: ovrGen ? `${ovrGen}${livetiming.gen_pos_finishers || ''}` : '' },
    { icon: 'category', name: categoryLabel, value: ovrCat ? `${ovrCat}${livetiming.cat_pos_finishers || ''}` : '' },
    { icon: 'trophy',   name: 'Overall',     value: ovrAll ? `${ovrAll}${livetiming.overall_pos_finishers || ''}` : '' },
  ];

  // Insert at index 1 (after summary, mirrors arrayInsertAt(items, 2, …))
  items.splice(1, 0, { type: 'infolist', data });
}

// ---------------------------------------------------------------------------
// Journey
// ---------------------------------------------------------------------------
function buildJourney(livetiming, ds, raceobj) {
  const splits = livetiming.splits;
  const total  = splits.length;

  const config = {
    showElevation:   ds.showElevation,
    elevationMode:   ds.elevationType,
    showRestTime:    false,
    showSectionMap:  ds.linkedMap.length > 0,
    paceFormat:      '',
    placeFormat:     ds.showRanks ? ' Cat Pos' : '',
    showGoalTracker: false,
    journeyColor:    ds.journeyColor,
  };
  if (ds.linkedMap) config.sectionMapGeoJson = ds.linkedMap;

  const journeySplits = [];
  for (let i = 0; i < total; i++) {
    const sp = splits[i];
    if (sp.visible !== 1) continue;
    const id = i === 0 ? 'start' : (i === total - 1 ? 'finish' : `cp_${sp.id}`);
    const j  = { id, name: sp.name, distance: Number(sp.split_distance) || 0 };
    if (sp.fixed_elevation && !isNaN(Number(sp.fixed_elevation))) {
      j.elevation = Number(sp.fixed_elevation);
    }
    if (i === 0) j.type = 'start';
    else if (i === total - 1) j.type = 'finish';
    journeySplits.push(j);
  }

  const times = [];
  let lastDistance = 0, lastElapsed = '00:00:00', lastTod = '';
  let prevPos = 0;
  for (let i = 0; i < total; i++) {
    const sp = splits[i];
    if (sp.visible !== 1) continue;
    const hasActual = sp.RaceTime && !isStarred(sp.RaceTime);
    if (hasActual || (i === 0 && sp.tod)) {
      const splitId = i === 0 ? 'start' : (i === total - 1 ? 'finish' : `cp_${sp.id}`);
      const t = { splitId, timeOfDay: sp.tod, raceTime: sp.RaceTime };
      if (sp.split_speed && sp.split_speed !== '0.0km/hr') t.pace = sp.split_speed;
      else if (sp.split_pace) t.pace = sp.split_pace;
      if (ds.showRanks && sp.cat_place && sp.cat_place !== '0') {
        const cur = Number(sp.cat_place);
        t.position = cur;
        if (prevPos > 0 && cur !== prevPos) t.positionChange = prevPos - cur;
        prevPos = cur;
      }
      times.push(t);
      lastDistance = Number(sp.split_distance) || 0;
      lastElapsed  = sp.RaceTime;
      if (sp.tod) lastTod = sp.tod;
    }
  }

  const estimates = [];
  if (ds.useEstimates) {
    for (let i = 0; i < total; i++) {
      const sp = splits[i];
      if (sp.visible !== 1) continue;
      const hasActual = sp.RaceTime && !isStarred(sp.RaceTime);
      if (!hasActual && sp.estTOD) {
        const splitId = i === total - 1 ? 'finish' : `cp_${sp.id}`;
        estimates.push({
          splitId,
          eta:               stripStar(sp.estTOD),
          projectedRaceTime: sp.estRaceTime ? stripStar(sp.estRaceTime) : '',
        });
      }
    }
  }

  const stats = {
    distanceCovered: `${lastDistance.toFixed(1)} km`,
    elapsed:         lastElapsed,
  };
  if (estimates.length) stats.etaFinish = estimates[estimates.length - 1].eta;
  if (lastTod)          stats.currentTimeOfDay = lastTod;

  return {
    type: 'journey',
    data: {
      mode: 'ultra',
      config,
      splits:    journeySplits,
      times,
      estimates,
      stats,
    },
  };
}

// ---------------------------------------------------------------------------
// Plain table
// ---------------------------------------------------------------------------
function buildPlainTable(livetiming, ds) {
  const splits = livetiming.splits;
  const total  = splits.length;
  const lastIdx = lastActualSplitIndex(splits);

  const splitsArr = [{ style: 'header', data: ['Split', 'Race Time', 'Time of Day', 'Cat Pos'] }];

  for (let i = 0; i < total; i++) {
    const sp = splits[i];
    if (sp.visible !== 1) continue;
    const isEstimate = ds.useEstimates && sp.RaceTime === '' && sp.estTOD;
    const row = [sp.name];

    // Race Time
    if (isEstimate) {
      const v = sp.estRaceTime || sp.estTOD;
      row.push('*italic*' + stripStar(v));
    } else if (sp.RaceTime) {
      row.push(sp.RaceTime);
    } else {
      row.push('-');
    }

    // Time of Day
    if (isEstimate) row.push('*italic*' + stripStar(sp.estTOD));
    else if (sp.tod) row.push(sp.tod);
    else row.push('-');

    // Category place
    if (isEstimate) row.push('*italic*-');
    else if (sp.cat_place && sp.cat_place !== '0') row.push(String(sp.cat_place));
    else row.push('-');

    const obj = { data: row };
    if (isEstimate) obj.style = 'estimate';
    else if (i === lastIdx && lastIdx >= 0) obj.style = 'split_black';
    splitsArr.push(obj);
  }

  return [
    { type: 'title', data: { label: 'Split Times' } },
    { type: 'splits', splits: splitsArr },
  ];
}

// ---------------------------------------------------------------------------
// Tabbed table
// ---------------------------------------------------------------------------
function buildTabbedTable(livetiming, ds, raceobj) {
  const splits = livetiming.splits;
  const total  = splits.length;
  const genderLabel   = livetiming.gender_name   || 'Gender';
  const categoryLabel = livetiming.category_name || 'Category';

  // Sportsplits gets the extra "Split Time" column.
  const hasSplitTime = raceobj?.timing?.script === 'sportsplits';

  // --- Time tab ---
  const timeColumns = ['Split', 'Race Time', 'Time of Day'];
  if (hasSplitTime) timeColumns.push('Split Time');

  const timeRows = [{ style: 'header', data: timeColumns }];
  for (let i = 0; i < total; i++) {
    const sp = splits[i];
    if (sp.visible !== 1) continue;
    const isEstimate = ds.useEstimates && sp.RaceTime === '' && sp.estTOD;

    const row = [sp.name];

    // Race Time — never show estimated value
    row.push(sp.RaceTime && !isStarred(sp.RaceTime) ? sp.RaceTime : '-');

    // Time of Day
    if (isEstimate) row.push('*italic*' + stripStar(sp.estTOD));
    else if (sp.tod) row.push(sp.tod);
    else row.push('-');

    if (hasSplitTime) {
      if (isEstimate) row.push('*italic*-');
      else if (sp.split_time && String(sp.split_time).trim()) row.push(sp.split_time);
      else row.push('-');
    }

    const obj = { data: row };
    if (isEstimate) obj.style = 'estimate';
    timeRows.push(obj);
  }
  const tabs = [{ name: 'Time', columns: timeColumns, rows: timeRows }];

  // --- Pace tab ---
  if (ds.showPace) {
    const paceColumns = ['Split', 'Avg Pace', 'Avg Speed'];
    const paceRows = [{ style: 'header', data: paceColumns }];
    for (let i = 0; i < total; i++) {
      const sp = splits[i];
      if (sp.visible !== 1) continue;
      paceRows.push({
        data: [
          sp.name,
          sp.split_pace ? sp.split_pace : '-',
          (sp.split_speed && sp.split_speed !== '0.0km/hr') ? sp.split_speed : '-',
        ],
      });
    }
    tabs.push({ name: 'Pace', columns: paceColumns, rows: paceRows });
  }

  // --- Position tab ---
  if (ds.showRanks) {
    const rankColumns = ['Split', 'Overall', genderLabel, categoryLabel];
    const rankRows = [{ style: 'header', data: rankColumns }];
    for (let i = 0; i < total; i++) {
      const sp = splits[i];
      if (sp.visible !== 1) continue;
      rankRows.push({
        data: [
          sp.name,
          sp.overall_place && sp.overall_place !== '0' ? String(sp.overall_place) : '-',
          sp.gen_place     && sp.gen_place     !== '0' ? String(sp.gen_place)     : '-',
          sp.cat_place     && sp.cat_place     !== '0' ? String(sp.cat_place)     : '-',
        ],
      });
    }
    tabs.push({ name: 'Position', columns: rankColumns, rows: rankRows });
  }

  return [
    { type: 'title', data: { label: 'Splits' } },
    { type: ds.wide ? 'tabbedtablewide' : 'tabbedtable', tabs },
  ];
}

// ---------------------------------------------------------------------------
// Legs section (sportsplits leg_result is pre-populated by the transformer)
// ---------------------------------------------------------------------------
function appendLegs(items, livetiming, ds) {
  if (!Array.isArray(livetiming.legs) || !livetiming.legs.length) return;

  const splitTimeLookup     = {};
  const splitDistanceLookup = {};
  for (const sp of livetiming.splits) {
    if (sp.id != null && sp.RaceTime && !isStarred(sp.RaceTime)) {
      splitTimeLookup[sp.id] = sp.RaceTime;
    }
    if (sp.id != null && sp.split_distance != null) {
      splitDistanceLookup[sp.id] = Number(sp.split_distance) || 0;
    }
  }

  const resolved = [];
  for (const leg of livetiming.legs) {
    const label = leg.label?.trim() || 'Leg';
    const icon  = leg.icon || '';
    let result  = leg.leg_result?.trim() || '';
    let pace    = leg.leg_pace || '';

    // Calc fallback (racetec/timit) — only kicks in if transformer didn't set
    // leg_result. For sportsplits this is rare.
    if (!result && leg.start != null && leg.end != null
        && splitTimeLookup[leg.start] && splitTimeLookup[leg.end]) {
      const toSecs = (hms) => {
        const p = String(hms).split(':');
        let s = (Number(p[0]) || 0) * 3600 + (Number(p[1]) || 0) * 60;
        if (p.length >= 3) s += Number(p[2]) || 0;
        return s;
      };
      const startS = toSecs(splitTimeLookup[leg.start]);
      const endS   = toSecs(splitTimeLookup[leg.end]);
      const diff   = endS - startS;
      if (diff > 0) {
        const h = Math.floor(diff / 3600);
        const m = Math.floor((diff % 3600) / 60);
        const s = diff % 60;
        result = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        const sd = splitDistanceLookup[leg.start];
        const ed = splitDistanceLookup[leg.end];
        if (sd != null && ed != null) {
          const dist = ed - sd;
          if (dist > 0) pace = `${(dist / (diff / 3600)).toFixed(1)}km/hr`;
        }
      }
    }

    if (result) resolved.push({ label, icon, result, pace });
  }

  if (!resolved.length) return;

  // Find insertion point: before "Splits" title if present, else end
  let pos = items.length;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it?.type === 'title' && it?.data?.label === 'Splits') { pos = i; break; }
  }

  items.splice(pos, 0, { type: 'title', data: { label: 'Legs' } });

  if (ds.legDisplay === 'infolist') {
    const data = resolved.map((r) => {
      const item = { name: r.label || 'Leg', value: r.result || '' };
      if (r.icon) item.icon = r.icon;
      return item;
    });
    items.splice(pos + 1, 0, { type: 'infolist', data });
  } else {
    const splitsArr = [{ style: 'header', data: ['Leg', 'Time', 'Speed/Pace'] }];
    for (const r of resolved) {
      splitsArr.push({ data: [r.label || 'Leg', r.result || '', r.pace || ''] });
    }
    items.splice(pos + 1, 0, { type: 'splits', splits: splitsArr });
  }
}

// ---------------------------------------------------------------------------
// Live camera clips — videos for splits the athlete has passed.
// Mirrors CF athlete_detail_v2.cfm B.5: one YouTube link per camera-covered
// split, seeked to (split TOD - camera start - 10s). Rendered above the table.
// ---------------------------------------------------------------------------
function todToSecs(t) {
  const parts = String(t).split('.')[0].split(':');
  return (Number(parts[0]) || 0) * 3600 + (Number(parts[1]) || 0) * 60 + (Number(parts[2]) || 0);
}

function buildCamVideos(livetiming, raceobj) {
  const camLookup = {};
  for (const evt of raceobj.events || []) {
    for (const cam of evt.live_cameras || []) camLookup[cam.split_id] = cam;
  }
  if (!Object.keys(camLookup).length) return null;

  const videos = [];
  for (const sp of livetiming.splits || []) {
    if (sp.visible != 1 || !String(sp.tod || '').trim()) continue;
    const cam = camLookup[sp.id];
    if (!cam) continue;
    let offset = 0;
    try {
      offset = todToSecs(sp.tod) - todToSecs(cam.start_time) - 10;
    } catch (_) {
      offset = 0;
    }
    if (offset <= 0) continue;
    videos.push({
      url:           `https://youtu.be/${cam.yt_video_id}?t=${offset}&app=desktop`,
      title:         '',
      thumbnail_url: '',
    });
  }
  return videos.length ? { type: 'videos', data: videos } : null;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
function build(livetiming, raceobj, displaySettings, header) {
  const ds = readDisplaySettings(displaySettings);
  const items = header.results.version2.items;

  if (header.isFinished) {
    insertFinishInfolist(items, livetiming);
  }

  const camVideos = buildCamVideos(livetiming, raceobj);
  if (camVideos) items.push(camVideos);

  if (ds.type === 'journey') {
    items.push(buildJourney(livetiming, ds, raceobj));
  } else if (ds.type === 'plain_table') {
    items.push(...buildPlainTable(livetiming, ds));
  } else {
    items.push(...buildTabbedTable(livetiming, ds, raceobj));
  }

  appendLegs(items, livetiming, ds);

  return header.results;
}

module.exports = { build };
