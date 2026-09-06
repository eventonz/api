/**
 * POST /v2/auth/register — exchange the app's API key + an install id for a
 * short-lived install token. Body: { install_id, platform?, app_version? }.
 * Auth: the app API key (an install token cannot mint another).
 * Rate-limited per install id so a lifted app key can't be used to mint at will.
 */
const redis = require('../../config/redis');
const { issueInstallToken } = require('../../services/installTokens');
const { rateLimit } = require('../../plugins/rateLimit');

async function v2AuthRoutes(app) {
  app.post('/register', {
    config: { allowApiKey: true },
    preHandler: rateLimit({ name: 'register', limit: 30, windowSec: 3600, key: (req) => String(req.body?.install_id || req.ip) }),
    schema: {
      body: {
        type: 'object', required: ['install_id'],
        properties: {
          install_id: { type: 'string', minLength: 8, maxLength: 128 },
          platform: { type: 'string', enum: ['ios', 'android'] },
          app_version: { type: 'string', maxLength: 40 },
        },
      },
    },
  }, async (request, reply) => {
    if (request.auth?.type !== 'key') {
      return reply.code(403).send({ error: 'Register with the app API key, not an install token' });
    }
    const { install_id, platform, app_version } = request.body;
    const appId = request.apiKey.app_id;
    const issued = issueInstallToken({ appId, installId: install_id, keyId: request.apiKey.id, platform });
    redis.hset(`install:${appId}:${install_id}`, { last_register: new Date().toISOString(), platform: platform || '', app_version: app_version || '' })
      .then(() => redis.expire(`install:${appId}:${install_id}`, 90 * 86400)).catch(() => {});
    return reply.code(200).send({ ...issued, install_id, app_id: appId });
  });
}

module.exports = v2AuthRoutes;
