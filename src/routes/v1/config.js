const { createHash } = require('crypto');
const pool  = require('../../config/database');
const redis = require('../../config/redis');

const CACHE_TTL  = 60; // 60 seconds — matches ColdFusion
const ORIGIN     = 'https://eventotracker.com';

function sha256(str) {
  return createHash('sha256').update(str).digest('hex');
}

async function configRoutes(app) {
  // ---------------------------------------------------------------------------
  // GET /config/:race_id
  // Full config. Optional ?hash= query param: returns 304 if unchanged, else 200.
  // ---------------------------------------------------------------------------
  app.get('/:race_id', {
    schema: {
      params: {
        type: 'object',
        properties: { race_id: { type: 'integer' } },
        required: ['race_id'],
      },
      querystring: {
        type: 'object',
        properties: { hash: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { race_id }    = request.params;
    const { hash: clientHash } = request.query;
    const cacheKey       = `node:config:${race_id}`;

    // 1. Redis cache check
    const cached = await redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (clientHash && clientHash === parsed._hash) {
        return reply.code(304).send();
      }
      return reply.send(parsed);
    }

    // 2. Run all queries in parallel
    const [
      { rows: raceRows },
      { rows: pages },
      { rows: shortcuts },
      { rows: adverts },
      { rows: miniRows },
      { rows: paths },
      { rows: contests },
      { rows: contestDisplay },
    ] = await Promise.all([
      // Race row + app metadata (api_version, tracking_version, store URLs)
      pool.query(
        `SELECT races.*,
                COALESCE(apps.tracking_version, 1) AS tracking_version,
                COALESCE(apps.api_version, 3)       AS api_version,
                apps.version                        AS app_version,
                apps.android_version                AS app_android_version,
                apps.ios_store_url                  AS app_ios_store_url,
                apps.android_store_url              AS app_android_store_url
         FROM races
         LEFT JOIN app_race_join ON races.id = app_race_join.race_id
         LEFT JOIN apps          ON app_race_join.app_id = apps.id
         WHERE races.id = $1
         LIMIT 1`,
        [race_id]
      ),
      // Published menu pages
      pool.query(
        `SELECT * FROM pages
         WHERE type = ANY(ARRAY['link','carousel','storyslider','social_storyslider',
                                'eventomap','list','assistant','assistantv2','schedule',
                                'feed','divider','inapp','results','leaderboard'])
           AND race_id = $1
           AND (status = 'published' OR status = 'Published')
         ORDER BY sort_order ASC`,
        [race_id]
      ),
      // Shortcuts
      pool.query('SELECT * FROM shortcuts WHERE race_id = $1', [race_id]),
      // Active adverts — Banner (random) then Splash (random), matches CF UNION ALL
      pool.query(
        `SELECT * FROM (SELECT * FROM adverts WHERE type = 'Banner' AND race_id = $1 ORDER BY RANDOM()) b
         UNION ALL
         SELECT * FROM (SELECT * FROM adverts WHERE type = 'Splash' AND race_id = $1 ORDER BY RANDOM()) s`,
        [race_id]
      ),
      // Active miniplayer
      pool.query(
        'SELECT * FROM miniplayer WHERE race_id = $1 AND current = 1',
        [race_id]
      ),
      // Tracking paths via eventoMaps (getPathsFromEventoMaps CFC)
      pool.query(
        `SELECT e.contest_id, e.eventdescr, e.elevation_y_scale,
                m.geojson_file, m.edited
         FROM events e
         JOIN maps m ON e.eventomap = m.uuid
         WHERE e.eventomap IS NOT NULL
           AND e.race_id = $1
           AND e.use_tracking_path IS NULL`,
        [race_id]
      ),
      // Contests (v4+ only, but fetched unconditionally to avoid sequential await)
      pool.query(
        `SELECT contest_id, eventdescr, distance, color
         FROM events
         WHERE race_id = $1
           AND contest_id IS NOT NULL
           AND contest_id > 0
         ORDER BY contest_id ASC`,
        [race_id]
      ),
      // Contest display settings (v4+ only, same reasoning)
      pool.query(
        `SELECT contest_id, ad_display_type, ad_wide, ad_show_pace, ad_show_ranks,
                ad_show_elevation, ad_elevation_type, ad_linked_map
         FROM events
         WHERE race_id = $1`,
        [race_id]
      ),
    ]);

    if (raceRows.length === 0) return reply.notFound('Race not found');

    const race        = raceRows[0];
    const apiVersion  = Number.isFinite(+race.api_version) ? +race.api_version : 3;
    const endpointUrl = `${ORIGIN}/api/v${apiVersion}/api.cfm`;
    const pagesBase   = `${ORIGIN}/api/v${apiVersion}/modules/pages`;

    // 3. Build response — mirrors CF config.cfm field for field
    const data = {};

    // --- Athletes ---
    const athletesUrl = race.alt_athletelist?.trim() || `${endpointUrl}/athletes/${race_id}`;
    const trackingUrl = race.alt_trackingurl?.trim() || `${endpointUrl}/tracking`;

    data.athletes = {
      url:           athletesUrl,
      follow:        `${endpointUrl}/follow`,
      show_athletes: race.showathletes == 1,
      last_updated:  race.entrants_last_loaded,
      text:          race.athlete_text,
      avatar:        race.avatar_mode?.trim() || 'mixed',
      label:         race.athlete_page_label,
      edition:       race.edition,
      progress_rings: !!race.progress_rings,
    };

    data.athlete_details = {
      version: race.athlete_details_version,
      url:     `${endpointUrl}/splits/race/${race_id}/?bib=#{number}&id=#{id}&contest=#{contest}`,
    };

    // Contest display map (v4+)
    if (apiVersion >= 4 && contestDisplay.length > 0) {
      const displayMap = {};
      for (const row of contestDisplay) {
        displayMap[row.contest_id] = {
          type:           row.ad_display_type?.trim() || 'tabbed_table',
          wide:           !!row.ad_wide,
          show_pace:      !!row.ad_show_pace,
          show_ranks:     !!row.ad_show_ranks,
          show_elevation: !!row.ad_show_elevation,
          elevation_type: row.ad_elevation_type?.trim() || 'altitude',
          linked_map:     row.ad_linked_map,
        };
      }
      data.athlete_details.contest_display = displayMap;
    }

    // --- Home page ---
    if (race.home_page?.trim()) {
      data.home = { image: race.home_page };
    }

    // --- Shortcuts ---
    if (shortcuts.length >= 1) {
      const smallCuts = [];
      const largeCuts = [];

      for (const s of shortcuts) {
        if (s.size === 'small') {
          const sc = {
            icon:     s.icon.replace('.svg', ''),
            title:    s.title,
            subtitle: s.subtitle,
            action:   s.action,
          };
          if (s.action === 'openPage') sc.pageid = s.page_id;
          if (s.action === 'openURL')  sc.url    = s.url;
          if (s.color_style == 1) {
            sc.backgroundGradient = { startColor: s.gradient_start, endColor: s.gradient_end };
          }
          smallCuts.push(sc);
        } else {
          const lc = { image: s.image, action: s.action };
          if (s.action === 'openPage') lc.pageid = s.page_id;
          if (s.action === 'openURL')  lc.url    = s.url;
          largeCuts.push(lc);
        }
      }

      if (!data.home) data.home = {};
      data.home.shortcuts = {};
      if (smallCuts.length) data.home.shortcuts.small = smallCuts;
      if (largeCuts.length) data.home.shortcuts.large = largeCuts;
    }

    // --- Theme ---
    data.theme = {
      accent: {
        dark:  `#${race.theme_dark}`,
        light: `#${race.theme_light}`,
      },
    };

    // --- Menu ---
    data.menu = {
      created: '12/20/2024',
      items:   pages.map((item) => buildPage(item, pagesBase, endpointUrl, race_id)),
    };

    // --- Adverts ---
    if (adverts.length >= 1) {
      data.adverts = adverts.map((a) => ({
        id:        a.uuid,
        type:      a.type,
        frequency: a.frequency,
        image:     a.image,
        open_url:  a.open_url,
      }));
    }

    // --- Miniplayer ---
    if (miniRows.length === 1) {
      const m = miniRows[0];
      data.miniplayer = [{
        id:             m.uuid,
        is_live_stream: m.is_live_stream == 1,
        yt_url:         m.yt_url,
        title:          m.title,
      }];
    }

    // --- Results tab (pages where type='results' and tabbar=true) ---
    const tabbarResults = pages.filter((p) => p.type === 'results' && p.tabbar);
    if (tabbarResults.length >= 1) {
      const tr = tabbarResults[0];
      data.results = {
        show_results: true,
        config: {
          icon:               tr.icon,
          id:                 tr.id,
          type:               'results',
          supplier:           'sportsplits',
          sportsplits_raceid: tr.ssraceid,
          title:              tr.title,
          opens_athlete_detail: tr.linkdetails != 0,
        },
      };
    }

    // --- Tracking ---
    if (paths.length >= 1) {
      data.tracking = {
        update_freq: race.tracking_freq,
        data:        trackingUrl,
        map_style:   race.tracking_map_style?.trim() || 'road',
        paths:       paths.map((p) => {
          const path = {
            geojson:      p.geojson_file,
            name:         `p_${p.contest_id}`,
            contest:      p.contest_id,
            contest_name: p.eventdescr,
            // seconds since Unix epoch — mirrors CF dateDiff("s", epoch, edited)
            updated:      Math.floor(new Date(p.edited).getTime() / 1000),
          };
          if (p.elevation_y_scale != null && +p.elevation_y_scale > 0) {
            path.elevation_y_scale = +p.elevation_y_scale;
          }
          return path;
        }),
      };
    }

    // --- Contests (v4+) ---
    if (apiVersion >= 4 && contests.length >= 1) {
      data.contests = contests.map((c) => ({
        id:       c.contest_id,
        name:     c.eventdescr,
        distance: +c.distance || 0,
        color:    c.color?.trim() ? `#${c.color.trim()}` : `#${race.theme_light}`,
      }));
    }

    // --- Settings ---
    data.settings = {
      notifications: [
        { text: 'Event Updates', id: 'event', checkbox: false },
      ],
    };

    // --- App version (for force-update check) ---
    if (race.app_version?.trim()) {
      data.app_version = {
        ios_version:       race.app_version,
        android_version:   race.app_android_version,
        ios_store_url:     race.app_ios_store_url,
        android_store_url: race.app_android_store_url,
      };
    }

    // 4. Stamp hash, write full payload + standalone hash key, then respond
    data._hash    = sha256(JSON.stringify(data));
    const hashKey = `node:config:${race_id}:hash`;
    const payload = JSON.stringify(data);

    await Promise.all([
      redis.setex(cacheKey, CACHE_TTL, payload),
      redis.setex(hashKey,  CACHE_TTL, data._hash),
    ]);

    if (clientHash && clientHash === data._hash) {
      return reply.code(304).send();
    }

    return reply.send(data);
  });

  // ---------------------------------------------------------------------------
  // GET /config/:race_id/check?hash={clientHash}
  // Fast poll. Checks hash key first (no JSON parse).
  // 304 = no change.
  // 200 with full config = changed, apply immediately — no second request needed.
  // ---------------------------------------------------------------------------
  app.get('/:race_id/check', {
    schema: {
      params: {
        type: 'object',
        properties: { race_id: { type: 'integer' } },
        required: ['race_id'],
      },
      querystring: {
        type: 'object',
        properties: { hash: { type: 'string' } },
        required: ['hash'],
      },
    },
  }, async (request, reply) => {
    const { race_id }          = request.params;
    const { hash: clientHash } = request.query;
    const cacheKey             = `node:config:${race_id}`;
    const hashKey              = `node:config:${race_id}:hash`;

    // 1. Check the tiny hash key first — single Redis GET, no JSON parse
    const currentHash = await redis.get(hashKey);

    if (currentHash && currentHash === clientHash) {
      return reply.code(304).send();
    }

    // 2. Hash missing or changed — fetch full config from cache
    const cached = await redis.get(cacheKey);
    if (cached) {
      return reply.send(JSON.parse(cached));
    }

    // 3. Cache cold — forward to the full config handler via redirect
    return reply.redirect(`/v1/config/${race_id}`);
  });
}

// ---------------------------------------------------------------------------
// Page builder — mirrors CF config.cfm createPage() switch/case exactly
// ---------------------------------------------------------------------------
function buildPage(item, pagesBase, endpointUrl, race_id) {
  const page = { id: item.id, title: item.title, icon: item.icon };

  switch (item.type) {
    case 'link':
      page.type          = 'link';
      page.open_external = item.open_external == 1;
      page.link_type     = item.external_source?.toLowerCase().includes('pdf') ? 'pdf' : 'web';
      page.link          = { url: `${pagesBase}/redirect.cfm?page_id=${item.id}` };
      break;

    case 'assistant':
      page.type         = 'assistant';
      page.sourceId     = item.content;
      page.prefixprompt = 'You are a helpful assistant for an event';
      break;

    case 'assistantv2':
      page.type               = 'assistantv2';
      page.sourceId           = item.content;
      page.assistant_id       = item.content;
      page.assistant_base_url = 'https://eventotracker.com/api/v4/api.cfm';
      page.prefixprompt       = '';
      break;

    case 'results':
      page.type               = 'results';
      page.supplier           = 'sportsplits';
      page.sportsplits_raceid = item.ssraceid;
      page.opens_athlete_detail = item.linkdetails != 0;
      break;

    case 'eventomap':
      page.type     = 'eventomap';
      page.sourceId = `${endpointUrl}/maps/${item.mapid}`;
      break;

    case 'inapp':
      page.type      = 'link';
      page.link_type = 'web';
      page.link      = { url: `${pagesBase}/in_app_content.cfm?page=${item.id}` };
      break;

    case 'divider':
      page.type = 'divider';
      delete page.id;
      delete page.icon;
      break;

    case 'carousel':
      page.type     = 'carousel';
      page.carousel = { url: `${pagesBase}/carousel.cfm?page_id=${item.id}` };
      break;

    case 'list':
      page.type  = 'pages';
      page.pages = { url: `${pagesBase}/list.cfm?page_id=${item.id}` };
      break;

    case 'schedule':
      page.type     = 'schedule';
      page.schedule = { url: `${pagesBase}/schedule.cfm?page_id=${item.id}` };
      break;

    case 'social_storyslider':
      page.type        = 'storyslider';
      page.storyslider = { url: `${pagesBase}/social_storyslider.cfm?page_id=${item.id}&r_id=${race_id}` };
      break;

    case 'storyslider':
      page.type        = 'storyslider';
      page.storyslider = { url: `${pagesBase}/storyslider.cfm` };
      break;

    case 'leaderboard':
      page.type        = 'leaderboard';
      page.ss_raceid   = item.ssraceid;
      page.open_on     = item.openevent;
      page.list_events = item.tags
        ? item.tags.split(',').map((t) => +t.trim()).filter(Number.isFinite)
        : [];
      break;

    case 'feed':
      page.type = 'feed';
      page.feed = { url: `${pagesBase}/feed.cfm?page_id=${item.id}` };
      break;
  }

  return page;
}

module.exports = configRoutes;
