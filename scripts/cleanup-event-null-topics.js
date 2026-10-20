#!/usr/bin/env node
/**
 * One-off (Oct 2026): remove the `event-null-*` / `event-undefined-*` / `ath-null-*`
 * subscriptions that V2 builds ≤ 100.0.6 created when a multi-event app (no
 * eventId in configs/<app>.json) was opted in on its home screen. Nothing is
 * ever sent to these topics; push/sync now drops them, so this only clears the
 * backlog (FCM + v2.device_topics) without waiting for each device to re-sync.
 *
 *   node scripts/cleanup-event-null-topics.js           # dry run: counts only
 *   node scripts/cleanup-event-null-topics.js --apply   # unsubscribe in FCM, delete rows
 *
 * Rows are deleted only for the tokens FCM accepted (per app project).
 */
require('dotenv').config({ quiet: true });
const pool = require('../src/config/database');
const fcm  = require('../src/services/fcm');

const TOPIC_RE = '^(event-(null|undefined)?(-(en|es|de|fr))?|ath-(null|undefined)?-.*)$';

(async () => {
  const apply = process.argv.includes('--apply');
  const { rows } = await pool.query(
    `SELECT t.app_id::int AS app_id, d.topic, array_agg(t.fcm_token) AS tokens, array_agg(t.id) AS ids
       FROM v2.device_topics d JOIN v2.device_tokens t ON t.id = d.device_token_id
      WHERE d.topic ~ $1
      GROUP BY 1, 2 ORDER BY 1, 2`, [TOPIC_RE]);
  if (!rows.length) { console.log('nothing to clean'); return; }
  for (const r of rows) {
    console.log(`app ${r.app_id}  ${r.topic}  ${r.tokens.length} device(s)`);
    if (!apply) continue;
    const ok = [];
    for (let i = 0; i < r.tokens.length; i += 1000) {
      const toks = r.tokens.slice(i, i + 1000), ids = r.ids.slice(i, i + 1000);
      try {
        const m = await fcm.messaging(r.app_id);
        const res = await m.unsubscribeFromTopic(toks, r.topic);
        const bad = new Set((res.errors || []).map((e) => e.index));
        // A token FCM no longer knows (uninstalled) can't be on the topic either — drop its row too.
        (res.errors || []).forEach((e) => { if (/not-registered|invalid-registration/.test(e.error?.code || '')) bad.delete(e.index); });
        ids.forEach((id, j) => { if (!bad.has(j)) ok.push(id); });
        console.log(`  FCM: ${res.successCount} ok, ${res.failureCount} failed`);
      } catch (e) {
        console.log(`  FCM error (rows kept): ${e.message}`);
      }
    }
    if (ok.length) {
      const del = await pool.query('DELETE FROM v2.device_topics WHERE topic = $1 AND device_token_id = ANY($2)', [r.topic, ok]);
      console.log(`  deleted ${del.rowCount} row(s)`);
    }
  }
  if (!apply) console.log('\ndry run — pass --apply to unsubscribe and delete');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
