const pool = require('../../config/database');
const redis = require('../../config/redis');

const CACHE_TTL = 310; // 5 min 10 sec

async function carouselRoutes(app) {
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
    const cacheKey = `node:carousel:${page_id}`;

    // Check cache
    const cached = await redis.get(cacheKey);
    if (cached) {
      return reply.send(JSON.parse(cached));
    }

    // Increment visit count (async)
    pool.query('UPDATE pages SET visits = visits + 1 WHERE id = $1', [page_id]).catch(() => {});

    // Get carousel items
    const { rows: items } = await pool.query(
      `SELECT * FROM page_items
       WHERE page_id = $1
       ORDER BY id ASC`,
      [page_id]
    );

    // Build response
    const carouselItems = items.map(item => {
      const carouselItem = {
        title: item.title,
        content: item.content,
        media: {
          type: 'image',
          image: { url: item.image },
        },
      };

      // Build buttons array
      const buttons = [];

      // Label button
      if (item.buttontext) {
        buttons.push({
          type: 'label',
          label: {
            text: item.buttontext,
            open: item.buttonlink,
          },
        });
      }

      // Facebook button
      if (item.facebook) {
        buttons.push({
          type: 'social_media',
          social_media: {
            medium: 'facebook',
            open: item.facebook,
          },
        });
      }

      // Instagram button
      if (item.instagram) {
        buttons.push({
          type: 'social_media',
          social_media: {
            medium: 'instagram',
            open: item.instagram,
          },
        });
      }

      carouselItem.buttons = buttons;

      return carouselItem;
    });

    const response = {
      random: false,
      items: carouselItems,
    };

    // Cache and return
    await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(response));
    return reply.send(response);
  });
}

module.exports = carouselRoutes;
