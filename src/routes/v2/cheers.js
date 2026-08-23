const pool = require('../../config/database');

/**
 * Supporter cheers on an athlete page (blocks v24 `athlete_cheers`).
 *
 *   GET  /v2/cheers/:event_id/:athlete_id            → { total, reactions: {emoji: n}, mine: [emoji], cheers: [...] }
 *   POST /v2/cheers/:event_id/:athlete_id            { device, kind: 'reaction'|'sticker', emoji?, text?, name?, at_label?, at_pct? }
 *   POST /v2/cheers/:event_id/:athlete_id/:id/report { device }
 *
 * No login: the device id is the identity. Reactions toggle (one per emoji per
 * device); stickers are one per device per athlete per day. Stickers are
 * PRESET phrases (the block's list) — the only typed field is a first name,
 * letters only, blocklist-checked. Two reports from distinct devices hide a
 * cheer; organisers moderate in the CMS.
 */
const REACTIONS = ['🔥', '💪', '👏', '❤️', '🚀', '🎉'];
const NAME_RE = /^[\p{L}][\p{L}'’\- ]{0,11}$/u;
const BLOCK = /\b(fuck|shit|cunt|bitch|dick|cock|wank|slut|whore|nigg|fag|twat|arse|ass|prick|bastard|scheiss|fick|merde|putain|con|cazzo|stronz)/i;
const STICKER_RE = /^[\p{L}\p{N}\p{P}\p{Emoji}\p{Emoji_Presentation}‍️ !]{2,40}$/u;

const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function shape(row) {
  return {
    id: String(row.id), kind: row.kind, emoji: row.emoji, text: row.text, name: row.name,
    at_label: row.at_label, at_pct: row.at_pct == null ? null : Number(row.at_pct),
    created_at: row.created_at,
  };
}

async function cheersRoutes(app) {
  const params = { type: 'object', properties: { event_id: { type: 'string' }, athlete_id: { type: 'string' } }, required: ['event_id', 'athlete_id'] };

  app.get('/:event_id/:athlete_id', {
    schema: { params, querystring: { type: 'object', properties: { device: { type: 'string' } } } },
  }, async (request) => {
    const { event_id, athlete_id } = request.params;
    const device = clean(request.query?.device, 80);
    const { rows } = await pool.query(
      `SELECT * FROM v2.cheers WHERE event_id = $1 AND athlete_id = $2 AND NOT hidden
       ORDER BY created_at DESC LIMIT 300`,
      [event_id, athlete_id]
    );
    const reactions = {};
    const mine = [];
    const cheers = [];
    for (const r of rows) {
      if (r.kind === 'reaction') {
        reactions[r.emoji] = (reactions[r.emoji] || 0) + 1;
        if (device && r.device_id === device) mine.push(r.emoji);
      } else {
        cheers.push(shape(r));
      }
    }
    const total = rows.length;
    return { total, reactions, mine, cheers: cheers.slice(0, 100) };
  });

  app.post('/:event_id/:athlete_id', {
    schema: {
      params,
      body: { type: 'object', properties: {
        device: { type: 'string' }, kind: { type: 'string', enum: ['reaction', 'sticker'] },
        emoji: { type: 'string' }, text: { type: 'string' }, name: { type: 'string' },
        at_label: { type: 'string' }, at_pct: { type: 'number' },
      }, required: ['device', 'kind'] },
    },
  }, async (request, reply) => {
    const { event_id, athlete_id } = request.params;
    const b = request.body;
    const device = clean(b.device, 80);
    if (!device) return reply.code(422).send({ error: 'device required' });
    const atLabel = clean(b.at_label, 40) || null;
    const atPct = Number.isFinite(b.at_pct) ? Math.max(0, Math.min(100, b.at_pct)) : null;

    if (b.kind === 'reaction') {
      const emoji = clean(b.emoji, 8);
      if (!REACTIONS.includes(emoji)) return reply.code(422).send({ error: 'unknown reaction' });
      // Toggle: existing → remove, else add.
      const del = await pool.query(
        `DELETE FROM v2.cheers WHERE event_id = $1 AND athlete_id = $2 AND device_id = $3 AND kind = 'reaction' AND emoji = $4 RETURNING id`,
        [event_id, athlete_id, device, emoji]
      );
      if (del.rowCount) return { ok: true, action: 'removed' };
      await pool.query(
        `INSERT INTO v2.cheers (event_id, athlete_id, device_id, kind, emoji, at_label, at_pct) VALUES ($1, $2, $3, 'reaction', $4, $5, $6)`,
        [event_id, athlete_id, device, emoji, atLabel, atPct]
      );
      return { ok: true, action: 'added' };
    }

    // sticker
    const text = clean(b.text, 40);
    const name = clean(b.name, 12);
    if (!STICKER_RE.test(text) || BLOCK.test(text)) return reply.code(422).send({ error: 'Pick a sticker from the list.' });
    if (name && (!NAME_RE.test(name) || BLOCK.test(name))) return reply.code(422).send({ error: 'First name only — letters, up to 12.' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO v2.cheers (event_id, athlete_id, device_id, kind, text, name, at_label, at_pct)
         VALUES ($1, $2, $3, 'sticker', $4, $5, $6, $7) RETURNING *`,
        [event_id, athlete_id, device, text, name || null, atLabel, atPct]
      );
      return { ok: true, action: 'added', cheer: shape(rows[0]) };
    } catch (err) {
      if (err.code === '23505') return reply.code(429).send({ error: 'One sticker per athlete per day — you\'ve signed this card today.' });
      throw err;
    }
  });

  app.post('/:event_id/:athlete_id/:id/report', {
    schema: {
      params: { type: 'object', properties: { event_id: { type: 'string' }, athlete_id: { type: 'string' }, id: { type: 'string' } }, required: ['event_id', 'athlete_id', 'id'] },
      body: { type: 'object', properties: { device: { type: 'string' } }, required: ['device'] },
    },
  }, async (request) => {
    const { event_id, athlete_id, id } = request.params;
    const device = clean(request.body.device, 80);
    await pool.query(
      `UPDATE v2.cheers
       SET reports = CASE WHEN $4 = ANY(reports) THEN reports ELSE array_append(reports, $4) END,
           hidden = hidden OR cardinality(CASE WHEN $4 = ANY(reports) THEN reports ELSE array_append(reports, $4) END) >= 2
       WHERE id = $1 AND event_id = $2 AND athlete_id = $3`,
      [Number(id), event_id, athlete_id, device]
    );
    return { ok: true };
  });
}

module.exports = cheersRoutes;
