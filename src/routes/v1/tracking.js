const redis = require('../../config/redis');
const { raceconfigByRaceId } = require('../../services/raceConfig');

// Mirrors API/api/v4/modules/tracking.cfm + tracking_scripts/general.cfm

function nowInTzSecs(tz) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz || 'UTC',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  let h = get('hour');
  if (h === 24) h = 0; // Intl quirk
  return h * 3600 + get('minute') * 60 + get('second');
}

function hmsToSecs(hms) {
  if (!hms) return 0;
  const clean = String(hms).split('.')[0];
  const parts = clean.split(':').map((n) => Number(n) || 0);
  if (parts.length === 2) return parts[0] * 3600 + parts[1] * 60;
  if (parts.length >= 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function secsToHms(total) {
  const t = Math.max(0, Math.floor(total));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function predictPos(lastDistance, speed, lastSplitTOD, totalDistance, tz) {
  const nowSecs   = nowInTzSecs(tz);
  const splitSecs = hmsToSecs(lastSplitTOD);
  const secsDiff  = nowSecs - splitSecs;
  const currentDistance = (Number(speed) || 0) * (secsDiff / 3600) + (Number(lastDistance) || 0);
  let pct = (currentDistance / (Number(totalDistance) || 1)) * 100;
  if (pct >= 100) pct = 100;
  if (pct < 0)    pct = 0;
  return Number(pct.toFixed(2));
}

function calculateLiveRaceTime(splittod, racetime, tz) {
  try {
    if (!racetime || String(racetime).trim() === '') {
      return { live_racetime: '', is_counting: false };
    }
    const nowSecs   = nowInTzSecs(tz);
    const splitSecs = hmsToSecs(splittod);
    const secsDiff  = nowSecs - splitSecs;
    if (secsDiff < 0) {
      return { live_racetime: racetime, is_counting: false };
    }
    const total = hmsToSecs(racetime) + secsDiff;
    return { live_racetime: secsToHms(total), is_counting: true };
  } catch {
    return { live_racetime: racetime, is_counting: false };
  }
}

async function getLatestTracksRedis(tracks, raceId) {
  if (!tracks.length) return [];
  const keys = tracks.map((id) => `tracking:race:${raceId}:${id}`);
  const values = await redis.mget(keys);
  const out = [];
  for (const v of values) {
    if (v) {
      try { out.push(JSON.parse(v)); } catch { /* skip malformed */ }
    }
  }
  return out;
}

async function trackingRoutes(app) {
  app.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['race_id', 'tracks'],
        properties: {
          race_id: { type: ['integer', 'string'] },
          tracks:  { type: 'array', items: { type: ['integer', 'string'] } },
        },
      },
    },
  }, async (request, reply) => {
    const raceId = Number(request.body.race_id);
    const tracks = (request.body.tracks || []).map(String);

    let race;
    const cached = await redis.get(`raceobj:race:${raceId}`);
    if (cached) {
      try { race = JSON.parse(cached); } catch { /* fall through to PG */ }
    }
    if (!race) {
      race = await raceconfigByRaceId(raceId);
      if (race) {
        redis.setex(`raceobj:race:${raceId}`, 300, JSON.stringify(race)).catch(() => {});
      }
    }
    if (!race) return reply.notFound('Race not found');

    let isWithinReceptionWindow = false;
    if (race.data_reception_start && race.data_reception_end) {
      const now = new Date();
      const start = new Date(race.data_reception_start);
      const end   = new Date(race.data_reception_end);
      isWithinReceptionWindow = now >= start && now <= end;
    }

    const isTestMode    = race.tracking_scriptv3 === 'test_script.cfm';
    const canReceiveData = isTestMode || race.islive || isWithinReceptionWindow;

    if (!canReceiveData) {
      return {
        tracks: [],
        islive: !!race.islive,
        isWithinReceptionWindow,
        message: 'Event is not Live or not within data reception window',
      };
    }

    if (!race.tracking_scriptv3 || race.tracking_scriptv3 === '') {
      return { islive: true, message: 'No tracking Script', tracks: [] };
    }

    const latest = await getLatestTracksRedis(tracks, raceId);
    const tz     = race.timezone || 'UTC';

    const out = [];
    for (const t of latest) {
      const path = `p_${t.use_tracking_path}`;

      if (Number(t.percent_course) === 100) {
        const finalRacetime = t.splitracetime || t.racetime || '';
        out.push({
          track:        String(t.athlete_id),
          location:     100,
          speed:        0,
          path,
          info:         'FINISHED ',
          marker_text:  String(t.marker_text ?? ''),
          live_racetime: finalRacetime,
          is_counting:  false,
        });
        continue;
      }

      let latestPosition = predictPos(t.distance, t.speed, t.splittod, t.course_distance, tz);
      let speed   = Number(t.speed) || 0;
      let message = t.isgps
        ? `GPS Update, ${t.splitname} @ ${String(t.splittod).slice(0, 5)} \nSpeed: ${speed} km/h`
        : `Last Timing Split, ${t.splitname} @ ${String(t.splittod).slice(0, 5)} `;

      try {
        if (latestPosition > Number(t.next_splitpercent)) {
          latestPosition = Number(t.next_splitpercent);
          speed = 0;
          message = 'Awaiting Update';
        }
      } catch { /* swallow */ }

      const trackRacetime = t.racetime || '';
      const liveTimeData = latestPosition >= 100
        ? { live_racetime: trackRacetime, is_counting: false }
        : calculateLiveRaceTime(t.splittod, trackRacetime, tz);

      out.push({
        track:        String(t.athlete_id),
        location:     Number(latestPosition),
        speed:        Number(speed.toFixed(1)),
        path,
        info:         message,
        marker_text:  String(t.marker_text ?? ''),
        live_racetime: liveTimeData.live_racetime,
        is_counting:  liveTimeData.is_counting,
      });
    }

    return { tracks: out };
  });
}

module.exports = trackingRoutes;
