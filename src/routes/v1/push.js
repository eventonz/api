const pool = require('../../config/database');
const fcm  = require('../../services/fcm');
const os   = require('os');
const fs   = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/**
 * DEV ONLY: FCM cannot reach iOS simulators, so when PUSH_SIMCTL="<udid>:<bundleId>"
 * is set, every successful send is mirrored into that simulator with
 * `xcrun simctl push` (same title/body/data/category the real push carries).
 */
function mirrorToSimulator(payload) {
  const cfg = process.env.PUSH_SIMCTL;
  if (!cfg) return;
  const [udid, bundle] = cfg.split(':');
  if (!udid || !bundle) return;
  const apns = {
    'Simulator Target Bundle': bundle,
    aps: { alert: { title: payload.title, body: payload.body || '' }, sound: 'default',
           category: payload.category, 'mutable-content': payload.image ? 1 : undefined },
    ...payload.data,
  };
  if (payload.image) apns.image = payload.image;
  const file = path.join(os.tmpdir(), `evento-push-${Date.now()}.apns`);
  fs.writeFileSync(file, JSON.stringify(apns));
  execFile('xcrun', ['simctl', 'push', udid, file], (err, out) => {
    console.log('[push] simctl mirror →', udid, err ? `ERROR ${err.message}` : String(out).trim());
    fs.unlink(file, () => {});
  });
}

/**
 * /v1/push — FCM registry, topic sync, send and inbox (MOBILE-V2/PUSH-PLAN.md).
 *
 * The app never manages topics itself: it POSTs its FULL intended topic set on
 * every launch/foreground/change (`/sync`); the server diffs against what this
 * device last synced (v2.follows + v2.device_topics) and fixes FCM. Subscribe/
 * unsubscribe are idempotent, so a re-sync after a missed call self-heals.
 */
async function pushRoutes(app) {
  const toInt = (v) => (v == null || v === '' ? null : Number(v));
  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  async function upsertDevice({ app_id, platform, token, device_id, lang }) {
    const { rows } = await pool.query(
      `INSERT INTO v2.device_tokens (app_id, platform, fcm_token, device_id, lang)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (fcm_token) DO UPDATE
         SET app_id = EXCLUDED.app_id, platform = EXCLUDED.platform,
             device_id = COALESCE(EXCLUDED.device_id, v2.device_tokens.device_id),
             lang = EXCLUDED.lang, last_seen_at = NOW()
       RETURNING id`,
      [app_id, platform, token, device_id || null, fcm.normLang(lang)]
    );
    return rows[0].id;
  }

  // ── register ────────────────────────────────────────────────────────────
  app.post('/register', {
    schema: { body: { type: 'object', required: ['app_id', 'platform', 'token'],
      properties: { app_id: { type: 'integer' }, platform: { type: 'string', enum: ['ios', 'android'] },
                    token: { type: 'string', minLength: 20 }, device_id: { type: 'string' }, lang: { type: 'string' } } } },
  }, async (request) => {
    const id = await upsertDevice(request.body);
    return { ok: true, device_token_id: id };
  });

  // ── sync: full intended topic set for this device ───────────────────────
  app.post('/sync', {
    schema: { body: { type: 'object', required: ['app_id', 'platform', 'token', 'topics'],
      properties: {
        app_id: { type: 'integer' }, platform: { type: 'string', enum: ['ios', 'android'] },
        token: { type: 'string', minLength: 20 }, device_id: { type: 'string' }, event_id: { type: 'string' },
        lang: { type: 'string' },
        topics: { type: 'array', items: { type: 'string' }, maxItems: 2000 },
        follows: { type: 'array', items: { type: 'object' } },
      } } },
  }, async (request, reply) => {
    const { token, event_id, topics, follows = [] } = request.body;
    const lang = fcm.normLang(request.body.lang);
    // The app sends BARE topics + its language; every subscription carries the
    // language suffix so a send can fan out per language. A language change
    // simply re-syncs: the old `-xx` topics fall inside the scope below and go.
    const wanted = [...new Set(topics.filter(fcm.validTopic).map((t) => fcm.langTopic(fcm.stripLang(t), lang)))];
    if (wanted.length !== topics.length) request.log.warn({ topics }, 'push/sync: invalid or duplicate topic(s) dropped');

    const deviceId = await upsertDevice(request.body);

    // Scope the diff to THIS event: app-* topics, event-{this}, and athlete
    // topics recorded under this event — so syncing event A never unsubscribes
    // the device from event B's athletes (the app only sends the open event's follows).
    const { rows: have } = await pool.query(
      `SELECT topic FROM v2.device_topics WHERE device_token_id = $1
         AND (topic LIKE 'app-%' OR topic ~ $2)
       UNION SELECT topic FROM v2.follows WHERE device_token_id = $1 AND notify
         AND topic LIKE 'ath-%' AND event_id IS NOT DISTINCT FROM $3`,
      [deviceId, `^event-${escapeRe(event_id || '')}(-(en|es|de|fr))?$`, event_id || null]   // bare = pre-language row
    );
    const current = have.map((r) => r.topic);
    const toAdd = wanted.filter((t) => !current.includes(t));
    const toRemove = current.filter((t) => !wanted.includes(t));

    const errors = [];
    for (const t of toAdd) { try { await fcm.subscribe([token], t); } catch (e) { errors.push(`${t}: ${e.message}`); } }
    for (const t of toRemove) { try { await fcm.unsubscribe([token], t); } catch (e) { errors.push(`${t}: ${e.message}`); } }
    if (errors.length) request.log.error({ errors }, 'push/sync: FCM topic errors');

    // Mirror: follows rows (athlete topics) + device_topics (the rest).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (toRemove.length) {
        await client.query('DELETE FROM v2.device_topics WHERE device_token_id = $1 AND topic = ANY($2)', [deviceId, toRemove]);
        await client.query('DELETE FROM v2.follows WHERE device_token_id = $1 AND topic = ANY($2)', [deviceId, toRemove]);
      }
      for (const t of wanted) {
        if (t.startsWith('ath-')) {
          const bare = fcm.stripLang(t);
          const f = follows.find((x) => x && `ath-${x.race_id}-${x.athlete_id || x.bib}` === bare) || {};
          await client.query(
            `INSERT INTO v2.follows (device_token_id, race_id, event_id, athlete_id, bib_number, contest_id, topic, notify)
             VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
             ON CONFLICT (device_token_id, topic) DO UPDATE SET notify = TRUE, updated_at = NOW()`,
            [deviceId, /^\d+$/.test(String(f.race_id ?? '')) ? Number(f.race_id) : null, event_id || null,
             f.athlete_id || null, f.bib || null, f.contest || null, t]
          );
        } else {
          await client.query(
            'INSERT INTO v2.device_topics (device_token_id, topic) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [deviceId, t]
          );
        }
      }
      // Muted follows (notify=false) are kept for counts but carry no topic.
      for (const f of follows) {
        if (!f || f.notify !== false) continue;
        await client.query(
          `INSERT INTO v2.follows (device_token_id, race_id, event_id, athlete_id, bib_number, contest_id, topic, notify)
           VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)
           ON CONFLICT (device_token_id, topic) DO UPDATE SET notify = FALSE, updated_at = NOW()`,
          [deviceId, /^\d+$/.test(String(f.race_id ?? '')) ? Number(f.race_id) : null, event_id || null,
           f.athlete_id || null, f.bib || null, f.contest || null, `muted:ath-${f.race_id}-${f.athlete_id || f.bib}`]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    return reply.send({ ok: true, subscribed: toAdd, unsubscribed: toRemove, errors });
  });

  // ── send (CMS / system) ─────────────────────────────────────────────────
  app.post('/send', {
    schema: { body: { type: 'object', required: ['title', 'audience'],
      properties: {
        audience: { type: 'string', enum: ['app', 'event', 'athlete', 'tokens'] },
        app_id: { type: 'integer' }, event_id: { type: 'string' },
        race_id: { type: 'string' }, athlete_id: { type: 'string' },
        tokens: { type: 'array', items: { type: 'string' } },
        // Plain string (English) or a {en,es,de,fr} map — en required.
        title: { anyOf: [{ type: 'string', maxLength: 200 }, { type: 'object', additionalProperties: { type: 'string', maxLength: 200 } }] },
        body:  { anyOf: [{ type: 'string', maxLength: 1000 }, { type: 'object', additionalProperties: { type: 'string', maxLength: 1000 } }] },
        image: { type: 'string' }, url: { type: 'string' }, data: { type: 'object' },
        sender: { type: 'string' }, show_in_inbox: { type: 'boolean' },
        // ISO 8601 instant; >30s in the future stores the row as 'scheduled'
        // for the minute runner (/run) instead of dispatching now.
        send_after: { type: 'string' },
      } } },
  }, async (request, reply) => {
    const b = request.body;
    const i18n = normaliseCopy(b.title, b.body);
    if (!i18n) return reply.code(400).send({ error: 'title (English) required' });
    const title = i18n.title.en, body = i18n.body ? i18n.body.en : null;
    let topic = null, category = 'EVENT';
    if (b.audience === 'app') {
      if (!b.app_id) return reply.code(400).send({ error: 'app_id required' });
      topic = `app-${b.app_id}`;
    } else if (b.audience === 'event') {
      if (!b.event_id) return reply.code(400).send({ error: 'event_id required' });
      topic = `event-${b.event_id}`;
    } else if (b.audience === 'athlete') {
      if (!b.race_id || !b.athlete_id) return reply.code(400).send({ error: 'race_id and athlete_id required' });
      topic = `ath-${b.race_id}-${b.athlete_id}`;
      category = 'ATHLETE';
    } else if (!Array.isArray(b.tokens) || !b.tokens.length) {
      return reply.code(400).send({ error: 'tokens required' });
    }
    if (topic && !fcm.validTopic(topic)) return reply.code(400).send({ error: `invalid topic ${topic}` });

    const data = { ...(b.data || {}) };
    if (b.url) { data.route = 'url'; data.url = b.url; }     // opens in the app's Safari sheet
    if (!data.route) data.route = b.audience === 'athlete' ? 'athlete' : 'event';
    if (b.event_id && !data.event) data.event = b.event_id;
    if (b.athlete_id && !data.athlete) data.athlete = b.athlete_id;

    // Scheduled: store and let the minute runner (/run) dispatch it.
    const sendAfter = b.send_after ? new Date(b.send_after) : null;
    if (sendAfter && Number.isNaN(sendAfter.getTime())) return reply.code(400).send({ error: 'send_after must be ISO 8601' });
    const scheduled = sendAfter && sendAfter.getTime() > Date.now() + 30_000;

    const { rows } = await pool.query(
      `INSERT INTO v2.notifications (app_id, event_id, audience, topic, title, body, image, data, sender, show_in_inbox, status, send_after, i18n)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [toInt(b.app_id), b.event_id || null, b.audience, topic, title, body, b.image || null,
       JSON.stringify({ ...data, tokens: undefined }), b.sender || 'api', b.show_in_inbox !== false,
       scheduled ? 'scheduled' : 'queued', sendAfter, JSON.stringify(i18n)]
    );
    const id = rows[0].id;
    if (scheduled) return { ok: true, id, topic, scheduled: true, send_after: sendAfter.toISOString() };

    const result = await dispatch({ id, topic, title, body, i18n, image: b.image, data, category, tokens: b.tokens }, request.log);
    if (!result.ok) return reply.code(502).send(result);
    return result;
  });

  /**
   * title/body as sent (string or language map) → {title:{en,…}, body?:{en,…}}
   * with every language trimmed and English guaranteed. null if no English title.
   */
  function normaliseCopy(title, body) {
    const toMap = (v) => {
      const m = {};
      if (typeof v === 'string') { if (v.trim()) m.en = v.trim(); }
      else if (v && typeof v === 'object') for (const l of fcm.LANGS) if (typeof v[l] === 'string' && v[l].trim()) m[l] = v[l].trim();
      return m;
    };
    const t = toMap(title), bm = toMap(body);
    if (!t.en) return null;
    return { title: t, body: Object.keys(bm).length ? bm : undefined };
  }

  /** Languages a message is actually translated into (en + any with a title or body). */
  function copyLangs(i18n) {
    const set = new Set(['en']);
    for (const l of fcm.LANGS) if ((i18n.title && i18n.title[l]) || (i18n.body && i18n.body[l])) set.add(l);
    return fcm.LANGS.filter((l) => set.has(l));
  }

  /**
   * Send one stored notification (row already inserted). Updates status.
   * Shared by /send (immediate) and /run (scheduled).
   *
   * Topic sends go out once per language (`{topic}-{lang}`): translated
   * languages get their copy, the rest get English. Token sends group the
   * tokens by the device's stored language.
   */
  async function dispatch(n, log) {
    const data = { ...(n.data || {}), notification_id: String(n.id) };
    const i18n = n.i18n && n.i18n.title ? n.i18n : { title: { en: n.title }, body: n.body ? { en: n.body } : undefined };
    const copyFor = (lang) => ({
      title: fcm.resolveText(i18n.title, lang), body: fcm.resolveText(i18n.body, lang) || undefined,
      image: n.image, data, category: n.category,
    });
    try {
      let result;
      if (n.topic) {
        const ids = {};
        for (const lang of fcm.LANGS) ids[lang] = await fcm.sendToTopic(fcm.langTopic(n.topic, lang), copyFor(lang));
        result = { message_id: ids.en, message_ids: ids, languages: copyLangs(i18n) };
      } else {
        const tokens = n.tokens || [];
        const { rows } = await pool.query('SELECT fcm_token, lang FROM v2.device_tokens WHERE fcm_token = ANY($1)', [tokens]);
        const langOf = new Map(rows.map((r) => [r.fcm_token, r.lang]));
        const groups = {};
        for (const t of tokens) (groups[fcm.normLang(langOf.get(t))] ||= []).push(t);
        result = { successCount: 0, failureCount: 0, invalid: [], errors: [] };
        for (const [lang, toks] of Object.entries(groups)) {
          const r = await fcm.sendToTokens(toks, copyFor(lang));
          result.successCount += r.successCount; result.failureCount += r.failureCount;
          result.invalid.push(...r.invalid); result.errors.push(...r.errors);
        }
        if (result.invalid.length) await pool.query('DELETE FROM v2.device_tokens WHERE fcm_token = ANY($1)', [result.invalid]);
      }
      await pool.query(
        `UPDATE v2.notifications SET status = 'sent', sent_at = NOW(), fcm_message_id = $2, error = NULL WHERE id = $1`,
        [n.id, result.message_id || null]
      );
      mirrorToSimulator(copyFor(process.env.PUSH_SIMCTL_LANG || 'en'));
      return { ok: true, id: n.id, topic: n.topic, ...result };
    } catch (err) {
      log.error({ err, id: n.id }, 'push dispatch failed');
      await pool.query(`UPDATE v2.notifications SET status = 'failed', error = $2 WHERE id = $1`, [n.id, err.message]);
      return { ok: false, id: n.id, topic: n.topic, error: err.message };
    }
  }

  // ── cancel a scheduled send (CMS) ───────────────────────────────────────
  app.delete('/:id', async (request, reply) => {
    const { rowCount } = await pool.query(
      `UPDATE v2.notifications SET status = 'cancelled' WHERE id = $1 AND status = 'scheduled'`, [request.params.id]
    );
    if (!rowCount) return reply.code(404).send({ error: 'No scheduled notification with that id' });
    return { ok: true };
  });

  // ── runner: dispatch everything due (EasyCron, every minute) ────────────
  // Claims rows atomically (status → 'sending') so overlapping runs never
  // double-send; anything still 'sending' after 10 min is retried.
  app.post('/run', async (request) => {
    const { rows } = await pool.query(
      `UPDATE v2.notifications SET status = 'sending'
       WHERE id IN (
         SELECT id FROM v2.notifications
         WHERE (status = 'scheduled' AND send_after <= NOW())
            OR (status = 'sending' AND send_after <= NOW() - interval '10 minutes')
         ORDER BY send_after LIMIT 50 FOR UPDATE SKIP LOCKED)
       RETURNING id, topic, title, body, image, data, audience, i18n`
    );
    const results = [];
    for (const r of rows) {
      results.push(await dispatch({ ...r, category: r.audience === 'athlete' ? 'ATHLETE' : 'EVENT' }, request.log));
    }
    return { ok: true, due: rows.length, sent: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length };
  });

  // ── inbox (app) ─────────────────────────────────────────────────────────
  app.get('/inbox', {
    schema: { querystring: { type: 'object', properties: {
      app_id: { type: 'integer' }, event_id: { type: 'string' }, days: { type: 'integer', default: 14 },
      lang: { type: 'string' } } } },
  }, async (request) => {
    const { app_id, event_id, days } = request.query;
    const lang = fcm.normLang(request.query.lang);
    const where = ['status = $1', 'show_in_inbox', `sent_at >= NOW() - ($2 || ' days')::interval`];
    const params = ['sent', String(Math.min(Math.max(days || 14, 1), 90))];
    // An event inbox also shows app-wide sends; an app inbox shows everything.
    if (event_id) { params.push(event_id); where.push(`(event_id = $${params.length} OR event_id IS NULL)`); }
    if (app_id)   { params.push(app_id);   where.push(`(app_id = $${params.length} OR app_id IS NULL)`); }
    const { rows } = await pool.query(
      `SELECT id::int AS id, title, body, image, sent_at, event_id, data, i18n FROM v2.notifications
       WHERE ${where.join(' AND ')} ORDER BY sent_at DESC LIMIT 100`, params
    );
    // Resolve to the device's language; title/body columns are the English copy.
    return rows.map(({ i18n, ...r }) => ({
      ...r,
      title: (i18n && fcm.resolveText(i18n.title, lang)) || r.title,
      body: (i18n && fcm.resolveText(i18n.body, lang)) || r.body,
    }));
  });

  // ── followers count (CMS) ───────────────────────────────────────────────
  app.get('/followers', async (request) => {
    const { event_id, race_id, athlete_id } = request.query;
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM v2.follows f
       WHERE f.notify AND f.topic ~ $1`,
      [`^${escapeRe(`ath-${race_id}-${athlete_id}`)}-(en|es|de|fr)$`]
    );
    return { event_id, race_id, athlete_id, followers: rows[0].n };
  });
}

module.exports = pushRoutes;
