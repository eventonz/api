const pool = require('../../config/database');

async function appVersionRoutes(app) {
  // ---------------------------------------------------------------------------
  // GET /app_version/:app_id
  // Returns current iOS/Android version strings and store URLs.
  // ---------------------------------------------------------------------------
  app.get('/:app_id', {
    schema: {
      params: {
        type: 'object',
        properties: { app_id: { type: 'integer' } },
        required: ['app_id'],
      },
    },
  }, async (request, reply) => {
    const { app_id } = request.params;

    const { rows } = await pool.query(
      `SELECT version, android_version, ios_store_url, android_store_url
       FROM apps
       WHERE id = $1`,
      [app_id]
    );

    if (rows.length === 0) return reply.notFound('App not found');

    const r = rows[0];
    return reply.send({
      ios_version:       r.version,
      android_version:   r.android_version,
      ios_store_url:     r.ios_store_url,
      android_store_url: r.android_store_url,
    });
  });

  // ---------------------------------------------------------------------------
  // POST /app_version/:app_id
  // Body: { version, android_version, ios_store_url?, android_store_url? }
  // Updates version strings; store URLs only updated if provided.
  // ---------------------------------------------------------------------------
  app.post('/:app_id', {
    schema: {
      params: {
        type: 'object',
        properties: { app_id: { type: 'integer' } },
        required: ['app_id'],
      },
      body: {
        type: 'object',
        properties: {
          version:          { type: 'string' },
          android_version:  { type: 'string' },
          ios_store_url:    { type: 'string' },
          android_store_url:{ type: 'string' },
        },
        required: ['version', 'android_version'],
      },
    },
  }, async (request, reply) => {
    const { app_id }                                          = request.params;
    const { version, android_version, ios_store_url, android_store_url } = request.body;

    // Build SET clause — store URLs only updated when provided
    const sets   = ['version = $2', 'android_version = $3'];
    const params = [app_id, version, android_version];

    if (ios_store_url?.trim()) {
      params.push(ios_store_url);
      sets.push(`ios_store_url = $${params.length}`);
    }
    if (android_store_url?.trim()) {
      params.push(android_store_url);
      sets.push(`android_store_url = $${params.length}`);
    }

    await pool.query(
      `UPDATE apps SET ${sets.join(', ')} WHERE id = $1`,
      params
    );

    return reply.send({ success: true, message: 'App version updated successfully' });
  });
}

module.exports = appVersionRoutes;
