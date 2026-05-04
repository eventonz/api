/**
 * Settings — OneSignal notification preferences (segments table)
 *
 * Mirrors API/api/v4/modules/settings.cfm:
 *   POST /v1/settings   { race_id, player_id, notifications: {...} }
 *   GET  /v1/settings/:player_id
 *
 * The boolean flags collapse to two columns in segments:
 *   athlete = (notifications.athlete || notifications.entrants_info)
 *   event   = (notifications.event   || notifications.general_updates)
 */

const pool = require('../../config/database');

async function settingsRoutes(app) {
  app.post('/', {
    schema: {
      body: {
        type: 'object',
        properties: {
          race_id:       { type: 'integer' },
          player_id:     { type: 'string' },
          notifications: { type: 'object' },
        },
        required: ['race_id', 'player_id', 'notifications'],
      },
    },
  }, async (request, reply) => {
    const { race_id, player_id, notifications } = request.body;

    const athleteOn = !!(notifications.athlete || notifications.entrants_info);
    const eventOn   = !!(notifications.event   || notifications.general_updates);

    const { rows } = await pool.query(
      'SELECT id FROM segments WHERE onesignal = $1 AND race_id = $2 LIMIT 1',
      [player_id, race_id]
    );

    if (rows.length > 0) {
      await pool.query(
        'UPDATE segments SET athlete = $1, event = $2 WHERE onesignal = $3 AND race_id = $4',
        [athleteOn ? 1 : 0, eventOn ? 1 : 0, player_id, race_id]
      );
    } else {
      await pool.query(
        'INSERT INTO segments (race_id, onesignal, athlete, event) VALUES ($1, $2, $3, $4)',
        [race_id, player_id, athleteOn ? 1 : 0, eventOn ? 1 : 0]
      );
    }

    return reply.send({ response: 'success' });
  });

  app.get('/:player_id', {
    schema: {
      params: {
        type: 'object',
        properties: { player_id: { type: 'string' } },
        required: ['player_id'],
      },
    },
  }, async (request, reply) => {
    const { player_id } = request.params;

    const { rows } = await pool.query(
      'SELECT event, crew, athlete FROM segments WHERE onesignal = $1 LIMIT 1',
      [player_id]
    );

    const notifications = {};
    if (rows.length === 1) {
      notifications.event   = rows[0].event   === 1;
      notifications.crew    = rows[0].crew    === 1;
      notifications.athlete = rows[0].athlete === 1;
    }

    return reply.send({ notifications });
  });
}

module.exports = settingsRoutes;
