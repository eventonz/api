const pool = require('../../config/database');
const redis = require('../../config/redis');

const CACHE_TTL = 310; // 5 min 10 sec

async function scheduleRoutes(app) {
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
    const cacheKey = `node:schedule:${page_id}`;

    // Check cache
    const cached = await redis.get(cacheKey);
    if (cached) {
      return reply.send(JSON.parse(cached));
    }

    // Increment visit count (async)
    pool.query('UPDATE pages SET visits = visits + 1 WHERE id = $1', [page_id]).catch(() => {});

    // Get page tags and timezone
    const { rows: pageRows } = await pool.query(
      `SELECT pages.tags, races.time_zone as tz
       FROM pages
       LEFT JOIN races ON pages.race_id = races.id
       WHERE pages.id = $1`,
      [page_id]
    );

    if (pageRows.length === 0) {
      return reply.notFound('Schedule page not found');
    }

    // Get schedule items
    const { rows: items } = await pool.query(
      `SELECT
        schedule_items.title as qtitle,
        locations.title as location_title,
        locations.lat,
        locations.lng,
        schedule_items.tags as qtags,
        schedule_items.content as qcontent,
        schedule_items.end_time,
        schedule_items.highlighted as qhighlighted,
        schedule_items.date_time,
        schedule_items.location_id,
        schedule_items.start_time
       FROM schedule_items
       LEFT JOIN locations ON schedule_items.location_id = locations.id
       WHERE schedule_items.pid = $1 AND schedule_items.hiddenitem = 0
       ORDER BY schedule_items.start_time ASC`,
      [page_id]
    );

    // Build response
    const schedule = {
      tags: pageRows[0].tags ? pageRows[0].tags.split(',') : [],
      items: items.map(item => {
        const scheduleItem = {
          title: item.qtitle,
          tags: item.qtags ? item.qtags.split(',') : [],
          content: item.qcontent,
          datetime: formatDateTime(item.start_time),
          start_time: formatDateTime(item.start_time),
        };

        if (item.qhighlighted == 1) {
          scheduleItem.highlighted = true;
        }

        if (item.end_time) {
          scheduleItem.end_time = formatDateTime(item.end_time);
        }

        const location = {
          title: item.location_title || '   ',
        };

        if (item.lat && item.lng) {
          location.coordinate = {
            latitude: parseFloat(item.lat),
            longitude: parseFloat(item.lng),
          };
        }

        scheduleItem.location = location;

        return scheduleItem;
      }),
    };

    const response = { schedule };

    // Cache and return
    await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(response));
    return reply.send(response);
  });
}

function formatDateTime(date) {
  if (!date) return null;
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}:00+00:00`;
}

module.exports = scheduleRoutes;
