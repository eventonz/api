const pool = require('../../config/database');

async function appInstallRoutes(app) {
  // ---------------------------------------------------------------------------
  // POST /app_install
  // Body: { app_id, platform, install_version, device_id, installed_at }
  // ---------------------------------------------------------------------------
  app.post('/', {
    schema: {
      body: {
        type: 'object',
        properties: {
          app_id:          { type: 'integer' },
          platform:        { type: 'string' },
          install_version: { type: 'string' },
          device_id:       { type: 'string' },
          installed_at:    { type: 'string' },
        },
        required: ['app_id', 'platform', 'install_version', 'device_id', 'installed_at'],
      },
    },
  }, async (request, reply) => {
    const { app_id, platform, install_version, device_id, installed_at } = request.body;

    await pool.query(
      `INSERT INTO app_installs (app_id, platform, install_version, device_id, installed_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [app_id, platform, install_version, device_id, installed_at]
    );

    return reply.code(201).send({ response: 'success' });
  });
}

module.exports = appInstallRoutes;
