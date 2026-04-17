const crypto = require('crypto');
const pool   = require('../../config/database');
const timerAuth = require('../../plugins/timer-auth');

// AWS SDK v3 for DigitalOcean Spaces
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const INTERNAL_SECRET = 'evento_internal_2024';
const CMS_LOAD_URL    = 'https://evento.co.nz/cfc/athletes/loading_athletes_org.cfc';
const BLANK_THUMB     = 'https://evento-nz.fra1.cdn.digitaloceanspaces.com/thumbs/blankthumb.png';
const RR_ENCRYPTION_KEY = process.env.RR_ENCRYPTION_KEY || 'evento_rr_2024';

// DigitalOcean Spaces client (S3-compatible)
const s3Client = new S3Client({
  endpoint: 'https://fra1.digitaloceanspaces.com',
  region: 'fra1',
  credentials: {
    accessKeyId: process.env.DO_SPACES_KEY,
    secretAccessKey: process.env.DO_SPACES_SECRET,
  },
});

/**
 * Timer Events API Routes
 * POST   /v1/timer/events              - Create a new Evento event from RaceResult event ID
 * PATCH  /v1/timer/events/:rr_event_id - Update fields on an existing event
 * DELETE /v1/timer/events/:rr_event_id - Delete an event
 */
async function timerEventsRoutes(app) {
  // Apply timer auth to all routes in this module
  app.addHook('onRequest', timerAuth);

  // ==========================================================================
  // POST /v1/timer/events - Create new event
  // ==========================================================================
  app.post('/', async (request, reply) => {
    const { timerToken } = request;
    const body = request.body || {};

    // --- Validate inputs ---
    if (!body.rr_event_id || !String(body.rr_event_id).trim()) {
      return reply.code(422).send(errorResponse(422, 'Missing required field: rr_event_id'));
    }

    const rrEventId = String(body.rr_event_id).trim();
    if (!/^\d+$/.test(rrEventId)) {
      return reply.code(422).send(errorResponse(422, 'rr_event_id must be a numeric value.'));
    }

    const mode = body.mode?.trim() || 'rr_results';
    if (!['rr_results', 'results', 'tracking', 'notifications'].includes(mode)) {
      return reply.code(422).send(errorResponse(422, `Invalid mode '${mode}'. Allowed: rr_results, results, tracking, notifications`));
    }

    const resultsLink = body.results_link?.trim() || '';
    if (mode === 'results' && !resultsLink) {
      return reply.code(422).send(errorResponse(422, "results_link is required when mode is 'results'."));
    }

    // Theme colors — 6-digit hex, no #
    const themeDark  = body.theme_dark?.trim()?.toUpperCase()  || '99004E';
    const themeLight = body.theme_light?.trim()?.toUpperCase() || '0784FF';

    if (!/^[0-9A-F]{6}$/.test(themeDark)) {
      return reply.code(422).send(errorResponse(422, 'Invalid theme_dark. Use a 6-digit hex color without # (e.g. FF5733)'));
    }
    if (!/^[0-9A-F]{6}$/.test(themeLight)) {
      return reply.code(422).send(errorResponse(422, 'Invalid theme_light. Use a 6-digit hex color without # (e.g. 0066FF)'));
    }

    const backgroundImage  = body.background_image?.trim()  || '';
    const registrationUrl  = body.registration_url?.trim()  || '';
    const registrationText = body.registration_text?.trim() || '';

    // Tri-state booleans: null=auto, true/false=force
    const startlistProvided = body.startlist != null;
    const liveProvided      = body.live != null;
    const startlistForce    = startlistProvided ? !!body.startlist : null;
    const liveForce         = liveProvided      ? !!body.live      : null;

    try {
      // --- Duplicate check ---
      const dupCheck = await pool.query(
        'SELECT id FROM races WHERE rr_eventid = $1 AND orgid = $2',
        [parseInt(rrEventId), timerToken.org_id]
      );

      if (dupCheck.rows.length > 0) {
        return reply.code(409).send({
          status: 'error',
          code: 409,
          message: `An event with rr_event_id ${rrEventId} already exists for this organisation.`,
          existing_race_id: dupCheck.rows[0].id
        });
      }

      // --- Get org RR API key + timer info ---
      const orgResult = await pool.query(
        'SELECT rr_apikey, timer_id, timer_value FROM organisations WHERE id = $1 AND rr_apikey IS NOT NULL AND rr_apikey != $2',
        [timerToken.org_id, '']
      );

      if (orgResult.rows.length === 0) {
        return reply.code(403).send(errorResponse(403, 'No RaceResult API key configured for this organisation. Set it up in the CMS under Organisation Settings.'));
      }

      const orgRow = orgResult.rows[0];
      const rrApiKey = decrypt(orgRow.rr_apikey, RR_ENCRYPTION_KEY);
      const timerId  = orgRow.timer_id;
      const timerVal = orgRow.timer_value;

      // --- Get RaceResult Bearer Token ---
      const rrLoginResp = await fetch('https://events.raceresult.com/api/public/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `apikey=${encodeURIComponent(rrApiKey)}`
      });

      if (!rrLoginResp.ok) {
        return reply.code(502).send(errorResponse(502, `RaceResult authentication failed. Verify the API key is correct (HTTP ${rrLoginResp.status}).`));
      }

      let rrToken;
      try {
        const rrLoginJson = await rrLoginResp.json();
        rrToken = rrLoginJson.Token || '';
      } catch {
        rrToken = await rrLoginResp.text();
      }

      if (!rrToken || !rrToken.trim()) {
        return reply.code(502).send(errorResponse(502, 'RaceResult login succeeded but returned no token.'));
      }

      // --- Fetch event details from RaceResult ---
      const rrRequest = '["Settings:EventName,EventDate,EventDate2,EventLocation,EventZip,EventCountry,Eventtimezone,EventLogo"]';
      const rrEventResp = await fetch(`https://events.raceresult.com/_${rrEventId}/api/multirequest`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${rrToken}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: rrRequest
      });

      if (!rrEventResp.ok) {
        return reply.code(502).send(errorResponse(502, `Could not fetch event details from RaceResult (HTTP ${rrEventResp.status}). Check that rr_event_id ${rrEventId} is correct.`));
      }

      let rrEventData;
      try {
        rrEventData = await rrEventResp.json();
      } catch {
        return reply.code(502).send(errorResponse(502, 'Invalid response format from RaceResult API.'));
      }

      const settings = rrEventData.Settings;
      if (!settings || !settings.EventName) {
        return reply.code(502).send(errorResponse(502, `RaceResult event ${rrEventId} not found or settings are unavailable.`));
      }

      const eventName     = settings.EventName;
      const eventDate     = new Date(settings.EventDate);
      const eventLocation = settings.EventLocation || '';
      const eventTimezone = settings.Eventtimezone || 'UTC';
      const displayDate   = eventDate.toLocaleDateString('en-NZ', { day: '2-digit', month: 'short', year: 'numeric' }).replace(',', '');
      const eventYear     = eventDate.getFullYear();

      // --- Fetch and upload event logo ---
      let thumbnailUrl = BLANK_THUMB;

      if (settings.EventLogo && settings.EventLogo.trim()) {
        try {
          const rrLogoFilename = settings.EventLogo.trim();
          const logoResp = await fetch(
            `https://events.raceresult.com/_${rrEventId}/api/pictures/thumbnail?name=${encodeURIComponent(rrLogoFilename)}&maxWidth=360&maxHeight=180`,
            {
              headers: { 'Authorization': `Bearer ${rrToken}` },
              timeout: 15000
            }
          );

          if (logoResp.ok) {
            const contentType = logoResp.headers.get('content-type') || '';
            let fileBuffer = Buffer.from(await logoResp.arrayBuffer());
            let imgExt = 'png';

            // Check if response is JSON with base64 data
            if (contentType.includes('application/json')) {
              const jsonLogo = await logoResp.json();
              if (jsonLogo.data || jsonLogo.Data) {
                const b64Data = jsonLogo.data || jsonLogo.Data;
                fileBuffer = Buffer.from(b64Data, 'base64');
                imgExt = jsonLogo.type || 'png';
              } else if (jsonLogo.base64) {
                fileBuffer = Buffer.from(jsonLogo.base64, 'base64');
              }
            } else {
              // Raw binary
              const ext = contentType.split('/')[1];
              if (ext && ext !== 'octet-stream') imgExt = ext;
            }

            const logoFileName = `${crypto.randomUUID()}.${imgExt}`;
            await s3Client.send(new PutObjectCommand({
              Bucket: 'evento-nz',
              Key: `rrlogos/${logoFileName}`,
              Body: fileBuffer,
              ContentType: contentType || `image/${imgExt}`,
              ACL: 'public-read'
            }));

            thumbnailUrl = `https://evento-nz.fra1.cdn.digitaloceanspaces.com/rrlogos/${logoFileName}`;
          }
        } catch (err) {
          // Logo fetch/upload failed — fall back to blank thumb
          app.log.warn('Logo upload failed:', err.message);
        }
      }

      // --- Resolve results table (org-specific mapping) ---
      const orgResultTableMap = {
        16: 'timit',
        20: 'chrono',
        12: 'popupraces',
        24: 'solemotive',
        22: 'secondwind'
      };
      const resultTable = orgResultTableMap[timerToken.org_id] || 'timit';
      const eventStatus = ['rr_results', 'results'].includes(mode) ? 'open' : 'hidden';

      // --- Insert race ---
      const insertResult = await pool.query(`
        INSERT INTO races (
          event_name, orgid, timer_id, event_date, appid,
          display_date, display_location, thumbnail, mode, status,
          israceresult, time_zone, home_page, entrants_last_loaded,
          athlete_text, results_table, timer, edition,
          results_link, is_rr_org_api,
          theme_dark, theme_light,
          large_image, registration_url, registration_text,
          rr_eventid
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          TRUE, $11, 'https://evento-nz.fra1.cdn.digitaloceanspaces.com/home_images/splash_image.png', 1,
          'Athlete', $12, $13, $14,
          $15, TRUE,
          $16, $17,
          $18, $19, $20,
          $21
        )
        RETURNING id
      `, [
        eventName, timerToken.org_id, timerId, eventDate, timerToken.app_id,
        displayDate, eventLocation, thumbnailUrl, mode, eventStatus,
        eventTimezone, resultTable, timerVal, String(eventYear),
        resultsLink || null,
        themeDark, themeLight,
        backgroundImage || null, registrationUrl || null, registrationText || null,
        parseInt(rrEventId)
      ]);

      const raceId = insertResult.rows[0].id;

      // --- app_race_join ---
      await pool.query(
        'INSERT INTO app_race_join (app_id, race_id) VALUES ($1, $2)',
        [timerToken.app_id, raceId]
      );

      // --- Tri-state overrides ---
      if (startlistProvided) {
        await pool.query('UPDATE races SET startlist = $1 WHERE id = $2', [startlistForce, raceId]);
      }
      if (liveProvided) {
        await pool.query('UPDATE races SET live = $1 WHERE id = $2', [liveForce, raceId]);
      }

      // --- Athlete loading (tracking/notifications only) ---
      let athleteLoading = 'not_required';
      if (['tracking', 'notifications'].includes(mode)) {
        athleteLoading = 'triggered';
        try {
          const loadUrl = `${CMS_LOAD_URL}?method=remoteLoadForRace&raceID=${raceId}&orgID=${timerToken.org_id}&secret=${INTERNAL_SECRET}`;
          const loadResp = await fetch(loadUrl, { method: 'POST', timeout: 8000 });
          if (!loadResp.ok) athleteLoading = 'trigger_failed';
        } catch {
          athleteLoading = 'trigger_failed';
        }
      }

      // --- Success response ---
      return reply.code(200).send({
        status: 'success',
        data: {
          race_id: raceId,
          event_name: eventName,
          event_date: eventDate.toISOString().split('T')[0],
          display_date: displayDate,
          location: eventLocation,
          timezone: eventTimezone,
          mode,
          rr_event_id: rrEventId,
          theme_dark: themeDark,
          theme_light: themeLight,
          athlete_loading: athleteLoading
        }
      });

    } catch (err) {
      app.log.error('POST /timer/events error:', err);
      return reply.code(500).send({
        status: 'error',
        code: 500,
        message: err.message,
        detail: err.stack?.split('\n')[0] || ''
      });
    }
  });

  // ==========================================================================
  // PATCH /v1/timer/events/:rr_event_id - Update event
  // ==========================================================================
  app.patch('/:rr_event_id', async (request, reply) => {
    const { timerToken } = request;
    const { rr_event_id } = request.params;
    const body = request.body || {};

    if (!rr_event_id || !/^\d+$/.test(rr_event_id)) {
      return reply.code(422).send(errorResponse(422, 'Missing or invalid rr_event_id in URL.'));
    }

    try {
      // --- Find the race ---
      const raceResult = await pool.query(
        'SELECT id FROM races WHERE rr_eventid = $1 AND orgid = $2',
        [parseInt(rr_event_id), timerToken.org_id]
      );

      if (raceResult.rows.length === 0) {
        return reply.code(404).send(errorResponse(404, `No event found with rr_event_id ${rr_event_id} for this organisation.`));
      }

      const raceId = raceResult.rows[0].id;

      // --- Build SET clauses for provided fields ---
      const updates = [];
      const params  = [];
      let paramIndex = 1;

      if (body.theme_dark) {
        const v = body.theme_dark.trim().toUpperCase();
        if (!/^[0-9A-F]{6}$/.test(v)) {
          return reply.code(422).send(errorResponse(422, 'Invalid theme_dark. Use 6-digit hex without # (e.g. CC3300)'));
        }
        updates.push(`theme_dark = $${paramIndex++}`);
        params.push(v);
      }

      if (body.theme_light) {
        const v = body.theme_light.trim().toUpperCase();
        if (!/^[0-9A-F]{6}$/.test(v)) {
          return reply.code(422).send(errorResponse(422, 'Invalid theme_light. Use 6-digit hex without # (e.g. 0066FF)'));
        }
        updates.push(`theme_light = $${paramIndex++}`);
        params.push(v);
      }

      if ('background_image' in body) {
        updates.push(`large_image = $${paramIndex++}`);
        params.push(body.background_image?.trim() || null);
      }

      if ('registration_url' in body) {
        updates.push(`registration_url = $${paramIndex++}`);
        params.push(body.registration_url?.trim() || null);
      }

      if ('registration_text' in body) {
        updates.push(`registration_text = $${paramIndex++}`);
        params.push(body.registration_text?.trim() || null);
      }

      if ('results_link' in body) {
        updates.push(`results_link = $${paramIndex++}`);
        params.push(body.results_link?.trim() || null);
      }

      if (body.status) {
        const v = body.status.trim().toLowerCase();
        if (!['open', 'hidden'].includes(v)) {
          return reply.code(422).send(errorResponse(422, 'Invalid status. Allowed: open, hidden'));
        }
        updates.push(`status = $${paramIndex++}`);
        params.push(v);
      }

      if ('startlist' in body) {
        updates.push(`startlist = $${paramIndex++}`);
        params.push(body.startlist == null || body.startlist === '' ? null : !!body.startlist);
      }

      if ('live' in body) {
        updates.push(`live = $${paramIndex++}`);
        params.push(body.live == null || body.live === '' ? null : !!body.live);
      }

      if (updates.length === 0) {
        return reply.code(422).send(errorResponse(422, 'No updatable fields provided. Send at least one of: theme_dark, theme_light, background_image, registration_url, registration_text, results_link, status, startlist, live'));
      }

      params.push(raceId);
      await pool.query(
        `UPDATE races SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
        params
      );

      return reply.code(200).send({
        status: 'success',
        data: {
          race_id: raceId,
          rr_event_id: rr_event_id,
          fields_updated: updates.length
        }
      });

    } catch (err) {
      app.log.error('PATCH /timer/events error:', err);
      return reply.code(500).send({
        status: 'error',
        code: 500,
        message: err.message
      });
    }
  });

  // ==========================================================================
  // DELETE /v1/timer/events/:rr_event_id - Delete event
  // ==========================================================================
  app.delete('/:rr_event_id', async (request, reply) => {
    const { timerToken } = request;
    const { rr_event_id } = request.params;

    if (!rr_event_id || !/^\d+$/.test(rr_event_id)) {
      return reply.code(422).send(errorResponse(422, 'Missing or invalid rr_event_id in URL.'));
    }

    try {
      // --- Find the race ---
      const raceResult = await pool.query(
        'SELECT id FROM races WHERE rr_eventid = $1 AND orgid = $2',
        [parseInt(rr_event_id), timerToken.org_id]
      );

      if (raceResult.rows.length === 0) {
        return reply.code(404).send(errorResponse(404, `No event found with rr_event_id ${rr_event_id} for this organisation.`));
      }

      const raceId = raceResult.rows[0].id;

      // --- Delete (app_race_join first, then race) ---
      await pool.query('DELETE FROM app_race_join WHERE race_id = $1', [raceId]);
      await pool.query('DELETE FROM races WHERE id = $1', [raceId]);

      return reply.code(200).send({
        status: 'success',
        data: {
          race_id: raceId,
          rr_event_id: rr_event_id,
          deleted: true
        }
      });

    } catch (err) {
      app.log.error('DELETE /timer/events error:', err);
      return reply.code(500).send({
        status: 'error',
        code: 500,
        message: err.message
      });
    }
  });
}

// =============================================================================
// Helpers
// =============================================================================

function errorResponse(code, message, extra = {}) {
  return {
    status: 'error',
    code,
    message,
    ...extra
  };
}

/**
 * Decrypt ColdFusion CFMX_COMPAT encrypted string
 * @param {string} encryptedHex - Hex-encoded encrypted string
 * @param {string} key - Encryption key
 * @returns {string} Decrypted plaintext
 */
function decrypt(encryptedHex, key) {
  // ColdFusion CFMX_COMPAT uses DES-EDE3 with MD5-hashed key
  const keyHash = crypto.createHash('md5').update(key, 'utf8').digest();
  const keyBuffer = Buffer.concat([keyHash, keyHash.slice(0, 8)]); // 24 bytes for 3DES

  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv('des-ede3', keyBuffer, Buffer.alloc(0));
  decipher.setAutoPadding(true);

  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  return decrypted.toString('utf8');
}

module.exports = timerEventsRoutes;
