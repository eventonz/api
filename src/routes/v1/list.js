const pool = require('../../config/database');
const redis = require('../../config/redis');

const CACHE_TTL = 310; // 5 min 10 sec

async function listRoutes(app) {
  app.get('/:page_id', {
    schema: {
      params: {
        type: 'object',
        properties: { page_id: { type: 'integer' } },
        required: ['page_id'],
      },
    },
  }, async (request, reply) => {
    const { page_id } = request.params;
    const cacheKey = `node:list:${page_id}`;

    // Check cache
    const cached = await redis.get(cacheKey);
    if (cached) {
      return reply.send(JSON.parse(cached));
    }

    // Increment visit count (async)
    pool.query('UPDATE pages SET visits = visits + 1 WHERE id = $1', [page_id]).catch(() => {});

    // Get page items
    const { rows: items } = await pool.query(
      `SELECT id, facebook, instagram, title as qtitle, page_id, image as qimage,
              content as qcontent, subtitle, thumbnail, sort_order, mapid,
              buttontext, buttonlink, status, link
       FROM page_items
       WHERE page_id = $1
       ORDER BY sort_order ASC`,
      [page_id]
    );

    // Build response
    const listItems = items.map(item => {
      const listItem = {
        list: {
          title: item.qtitle,
        },
      };

      if (item.subtitle) {
        listItem.list.subtitle = item.subtitle;
      }

      if (item.thumbnail) {
        listItem.list.thumbnail = item.thumbnail;
      }

      // Detail section
      const detail = {};

      if (item.mapid) {
        detail.type = 'eventomap';
        detail.endpoint = `https://eventotracker.com/api/v3/api.cfm/maps/${item.mapid}`;
        listItem.detail = detail;
      } else if (item.link) {
        detail.type = 'embed';
        detail.embed = {
          url: item.link,
          link_type: item.link.toLowerCase().includes('pdf') ? 'pdf' : 'web',
        };
        listItem.detail = detail;
      }

      return listItem;
    });

    const response = { items: listItems };

    // Cache and return
    await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(response));
    return reply.send(response);
  });
}

module.exports = listRoutes;
