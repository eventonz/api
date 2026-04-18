const pool = require('../../config/database');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

// DigitalOcean Spaces configuration
const s3Client = new S3Client({
  endpoint: 'https://fra1.digitaloceanspaces.com',
  region: 'fra1',
  credentials: {
    accessKeyId: process.env.DO_SPACES_KEY,
    secretAccessKey: process.env.DO_SPACES_SECRET,
  },
});

module.exports = async function (fastify, opts) {

  /**
   * GET /v1/maps/:uuid
   * Get map data by UUID
   *
   * Query params:
   *  - elevation: true|false (default: true)
   */
  fastify.get('/maps/:uuid', async (request, reply) => {
    const { uuid } = request.params;
    const { elevation = 'true' } = request.query;

    try {
      const result = await pool.query(
        'SELECT uuid, title, default_style, geojson_file, elevation FROM maps WHERE uuid = $1',
        [uuid]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Map not found' });
      }

      const map = result.rows[0];

      // Increment view count
      await pool.query(
        'UPDATE maps SET mapcount = mapcount + 1 WHERE uuid = $1',
        [uuid]
      );

      // Return map data
      return {
        uuid: map.uuid,
        title: map.title,
        default_Style: map.default_style || 'outdoors',
        geojson_file: map.geojson_file,
        elevationData: (elevation === 'true' && map.elevation) ? map.elevation : null,
      };

    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: 'Failed to fetch map' });
    }
  });


  /**
   * POST /v1/maps/:uuid
   * Update map data (saves GeoJSON to DigitalOcean Spaces)
   *
   * Body:
   * {
   *   "geojson": {...},        // GeoJSON object
   *   "default_style": "...",  // Optional: outdoors, satellite, etc
   *   "title": "...",          // Optional: map title
   *   "elevation": [...]       // Optional: elevation data array
   * }
   */
  fastify.post('/maps/:uuid', async (request, reply) => {
    const { uuid } = request.params;
    const { geojson, default_style = 'outdoors', title, elevation } = request.body;

    if (!geojson) {
      return reply.code(400).send({ error: 'geojson is required' });
    }

    try {
      let geojsonFileUrl = null;

      // Upload GeoJSON to DigitalOcean Spaces
      if (geojson) {
        const fileName = `${uuid}.geojson`;
        const bucketPath = `geojson/${fileName}`;
        const geojsonContent = JSON.stringify(geojson);

        // Delete existing file first (if it exists)
        try {
          await s3Client.send(new DeleteObjectCommand({
            Bucket: 'evento-nz',
            Key: bucketPath,
          }));
        } catch (deleteError) {
          // File might not exist, ignore error
        }

        // Upload new file
        await s3Client.send(new PutObjectCommand({
          Bucket: 'evento-nz',
          Key: bucketPath,
          Body: geojsonContent,
          ContentType: 'application/json',
          ACL: 'public-read',
        }));

        geojsonFileUrl = `https://evento-nz.fra1.cdn.digitaloceanspaces.com/${bucketPath}`;
      }

      // Build UPDATE query dynamically
      const updates = [];
      const values = [];
      let paramIndex = 1;

      updates.push(`edited = NOW()`);

      if (default_style) {
        updates.push(`default_style = $${paramIndex++}`);
        values.push(default_style);
      }

      if (title && title.trim()) {
        updates.push(`title = $${paramIndex++}`);
        values.push(title.trim());
      }

      if (geojsonFileUrl) {
        updates.push(`geojson_file = $${paramIndex++}`);
        values.push(geojsonFileUrl);
      }

      if (elevation !== undefined) {
        if (Array.isArray(elevation) && elevation.length === 0) {
          updates.push(`elevation = NULL`);
        } else if (Array.isArray(elevation) && elevation.length > 0) {
          updates.push(`elevation = $${paramIndex++}`);
          values.push(JSON.stringify(elevation));
        }
      }

      // Add UUID as last parameter
      values.push(uuid);

      const query = `
        UPDATE maps
        SET ${updates.join(', ')}
        WHERE uuid = $${paramIndex}
      `;

      await pool.query(query, values);

      return { status: 'ok', geojson_file: geojsonFileUrl };

    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: 'Failed to update map' });
    }
  });


  /**
   * GET /v1/maps/race/:race_id
   * Get all maps for a race
   */
  fastify.get('/maps/race/:race_id', async (request, reply) => {
    const { race_id } = request.params;

    try {
      const result = await pool.query(
        'SELECT uuid, title, default_style, geojson_file, status FROM maps WHERE race_id = $1 ORDER BY edited DESC',
        [race_id]
      );

      return result.rows;

    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: 'Failed to fetch maps' });
    }
  });


  /**
   * GET /v1/maps/:uuid/validate/:token
   * Check if token is valid for a map (for public/private map access)
   */
  fastify.get('/maps/:uuid/validate/:token', async (request, reply) => {
    const { uuid, token } = request.params;

    try {
      const result = await pool.query(
        'SELECT COUNT(*) as count FROM maps WHERE uuid = $1 AND token = $2',
        [uuid, token]
      );

      const isValid = result.rows[0].count > 0;

      return { valid: isValid };

    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: 'Failed to validate token' });
    }
  });

};
