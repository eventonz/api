const pool = require('../config/database');

async function linkRoutes(app) {
  // ---------------------------------------------------------------------------
  // GET /link/:page_id
  // Tracks page visits and redirects to external URL (replaces redirect.cfm)
  // ---------------------------------------------------------------------------
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

    pool.query('UPDATE pages SET visits = visits + 1 WHERE id = $1', [page_id]).catch(() => {});

    const { rows } = await pool.query(
      'SELECT external_source FROM pages WHERE id = $1',
      [page_id]
    );

    if (rows.length === 0) {
      return reply.notFound('Page not found');
    }

    return reply.redirect(302, rows[0].external_source);
  });
}

module.exports = linkRoutes;
