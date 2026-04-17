const pool  = require('../../config/database');
const redis = require('../../config/redis');

const CACHE_TTL = 120; // 2 minutes — matches ColdFusion cachedWithin

async function eventsRoutes(app) {
  // Shared handler — filter is 'upcoming', 'past', or '' (all)
  async function handleEvents(request, reply, eventsFilter = '') {
    const { appid }    = request.params;
    const cacheKey     = `node:events:${appid}:${eventsFilter}`;

    // 1. Redis cache check
    const cached = await redis.get(cacheKey);
    if (cached) return reply.send(JSON.parse(cached));

    // 2. Load app config
    const { rows: appRows } = await pool.query(
      'SELECT * FROM apps WHERE id = $1',
      [appid]
    );
    if (appRows.length === 0) return reply.notFound('App not found');
    const appRow     = appRows[0];
    const apiVersion = Number.isFinite(+appRow.api_version) ? +appRow.api_version : 3;

    // 3. Load races — cutoff is 2 days ago (matches ColdFusion behaviour)
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 2);

    let racesWhere = 'ar.app_id = $1';
    const racesParams = [appid];

    if (eventsFilter === 'past') {
      racesWhere += ` AND r.status = 'open' AND r.event_date <= $2`;
      racesParams.push(cutoff);
    } else if (eventsFilter === 'upcoming') {
      racesWhere += ` AND r.status = 'open' AND r.event_date > $2`;
      racesParams.push(cutoff);
    } else {
      racesWhere += ` AND (r.status = 'open' OR r.status = 'closed')`;
    }

    const orderBy = eventsFilter === 'past' ? 'r.event_date DESC' : 'r.event_date ASC';

    const { rows: races } = await pool.query(
      `SELECT r.* FROM races r
       JOIN app_race_join ar ON r.id = ar.race_id
       WHERE ${racesWhere}
       ORDER BY ${orderBy}`,
      racesParams
    );

    // 4. Load promo cards
    const { rows: promoRows } = await pool.query(
      'SELECT * FROM app_promo_cards WHERE app_id = $1 ORDER BY sort_order ASC',
      [appid]
    );

    // 5. Build response
    const data = {
      header: {
        color: `#${appRow.bg_color}`,
        logo:  appRow.header_image,
      },
      searchbar:     !!appRow.hassearch,
      show_upcoming: !!appRow.show_upcoming,
      show_past:     !!appRow.show_past,
      promo_cards:   promoRows.map(buildPromoCard),
      items:         [],
    };

    // Large events float to the top (matches ColdFusion arraymerge behaviour)
    const largeItems  = [];
    const normalItems = [];

    for (const race of races) {
      const item = buildEventItem(race, apiVersion);
      if (race.size === 'large') {
        largeItems.push(item);
      } else {
        normalItems.push(item);
      }
    }

    data.items = [...largeItems, ...normalItems];

    // 6. Cache and respond
    await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(data));
    return reply.send(data);
  }

  const params = {
    type: 'object',
    properties: { appid: { type: 'integer' } },
    required: ['appid'],
  };

  app.get('/:appid',          { schema: { params } }, (req, reply) => handleEvents(req, reply, ''));
  app.get('/:appid/upcoming', { schema: { params } }, (req, reply) => handleEvents(req, reply, 'upcoming'));
  app.get('/:appid/past',     { schema: { params } }, (req, reply) => handleEvents(req, reply, 'past'));
}

function buildPromoCard(row) {
  const card = {
    id:       row.id,
    title:    row.title,
    link_url: row.link_url,
  };
  if (row.image_url) {
    card.type      = 'image';
    card.image_url = row.image_url;
  } else if (row.background) {
    card.type       = 'color';
    card.background = row.background;
    card.text_color = row.text_color;
  }
  return card;
}

function buildEventItem(race, apiVersion) {
  const configUrl = `https://eventotracker.com/api/v${apiVersion}/api.cfm/config/${race.id}`;
  const item      = {};

  if (race.mode === 'rr_results') {
    item.id   = race.id;
    item.type = 'rr_results';
    item.config = configUrl;
    if (race.rr_eventid) item.rr_id = race.rr_eventid;
    item.show_medals = !!race.show_medals;
    if (race.theme_dark) item.theme = `#${race.theme_dark}`;
    item.background_image = race.large_image || '';
    if (race.startlist != null) item.startlist = !!race.startlist;
    if (race.live      != null) item.live      = !!race.live;
    if (race.registration_url) {
      item.registration_url  = race.registration_url;
      item.registration_text = race.registration_text || 'Register';
    }
  } else if (race.mode === 'results' && race.results_link) {
    item.id     = 0;
    item.type   = 'link';
    item.link   = race.results_link;
    item.config = configUrl;
    if (race.theme_dark) item.theme = `#${race.theme_dark}`;
  } else {
    item.id     = race.id;
    item.type   = 'event';
    item.config = configUrl;
  }

  item.size        = race.size;
  item.title       = race.event_name;
  item.subtitle    = race.display_location?.trim()
    ? `${race.display_location.trim()}\n${race.display_date}`
    : race.display_date;
  item.small_image = race.thumbnail;
  item.open        = race.status !== 'closed';

  if (race.large_image) item.large_image = race.large_image;

  if (race.tag_color && race.tag_text && race.large_image) {
    item.tag = {
      color:    `#${race.tag_color}`,
      text:     race.tag_text,
      blinking: race.tag_blink !== 0,
    };
  }

  return item;
}

module.exports = eventsRoutes;
