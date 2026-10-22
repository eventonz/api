const pool  = require('../../config/database');
const redis = require('../../config/redis');

/**
 * GET /v2/app_version/:app_id — the V2 apps' must-update gate.
 *
 * Returns the minimum installed version per platform and the store links
 * (v2.apps min_*_version, migration 046 + app_store_url / play_store_url; set
 * in the CMS under App → Settings). An app whose
 * installed version is older shows a blocking "Update required" screen; an
 * empty minimum turns the gate off. Cached 5 min, so a CMS change reaches
 * phones within ~5 min. The Flutter apps keep /v1/app_version (public.apps).
 */
const CACHE_TTL = 300;
const cacheKey  = (appId) => `v2_app_version:${appId}`;

async function v2AppVersionRoutes(app) {
  app.get('/:app_id', {
    schema: {
      params: { type: 'object', properties: { app_id: { type: 'integer' } }, required: ['app_id'] },
    },
  }, async (request, reply) => {
    const { app_id } = request.params;
    const key = cacheKey(app_id);
    const cached = await redis.get(key).catch(() => null);
    if (cached) {
      reply.header('X-Cache', 'HIT');
      return reply.send(JSON.parse(cached));
    }
    const { rows } = await pool.query(
      `SELECT min_ios_version, min_android_version, app_store_url, play_store_url
         FROM v2.apps WHERE id = $1`,
      [app_id]
    );
    if (!rows.length) return reply.code(404).send({ error: 'App not found' });
    const r = rows[0];
    const payload = {
      min_ios_version:     r.min_ios_version     || '',
      min_android_version: r.min_android_version || '',
      ios_store_url:       r.app_store_url       || '',
      android_store_url:   r.play_store_url      || '',
    };
    redis.setex(key, CACHE_TTL, JSON.stringify(payload)).catch(() => {});
    reply.header('X-Cache', 'MISS');
    return reply.send(payload);
  });
  /**
   * POST /v2/app_version/:app_id — build.sh `upload` records which block
   * contract (blocks.schema.json version) the build it just sent to the store
   * understands, so the CMS can grey out newer blocks for this app
   * (v2.apps.live_contract, migration 047). Auth: the app's own API key
   * (allowed even once reads require install tokens) or a server key.
   */
  app.post('/:app_id', {
    config: { allowApiKey: true },
    schema: {
      params: { type: 'object', properties: { app_id: { type: 'integer' } }, required: ['app_id'] },
      body: {
        type: 'object',
        properties: {
          contract: { type: 'integer', minimum: 1 },
          version:  { type: 'string' },
          platform: { type: 'string', enum: ['ios', 'android'] },
        },
        required: ['contract', 'version'],
      },
    },
  }, async (request, reply) => {
    const { app_id } = request.params;
    const auth = request.auth || {};
    if (auth.kind !== 'server' && Number(auth.app_id) !== Number(app_id)) {
      return reply.code(403).send({ error: 'Key does not belong to this app' });
    }
    const { contract, version } = request.body;
    const { rowCount } = await pool.query(
      `UPDATE v2.apps SET live_contract = $2, live_version = $3, live_contract_at = now() WHERE id = $1`,
      [app_id, contract, version]
    );
    if (!rowCount) return reply.code(404).send({ error: 'App not found' });
    return reply.send({ ok: true, app_id, live_contract: contract, live_version: version });
  });
}

module.exports = v2AppVersionRoutes;
