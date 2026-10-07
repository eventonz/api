#!/usr/bin/env node
/**
 * Show the raw timer pushes received, newest first.
 *   node scripts/show-pushes.js <racetec_apikey | rr_eventid> [count=20] [--full]
 * Reads racetec:pushes:{apikey} / raceresult:pushes:{rr_eventid} (written by
 * routes/v2/tracks.js on every push, live or not). Bodies are truncated to
 * 400 chars unless --full.
 */
require('dotenv').config({ quiet: true });
const redis = require('../src/config/redis');

(async () => {
  const [id, countArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const full = process.argv.includes('--full');
  if (!id) { console.log('usage: node scripts/show-pushes.js <racetec_apikey | rr_eventid> [count] [--full]'); process.exit(1); }
  const n = Number(countArg) || 20;
  const listKey = /^\d+$/.test(id) ? `raceresult:pushes:${id}` : `racetec:pushes:${id}`;
  const rows = await redis.lrange(listKey, 0, n - 1);
  const total = await redis.llen(listKey);
  console.log(`${listKey}: ${total} push(es) recorded, showing ${rows.length}\n`);
  for (const raw of rows) {
    const p = JSON.parse(raw);
    console.log(`${p.at}  ${p.platform}  ${p.bytes} B  ${p.content_type || 'no content-type'}  states=${JSON.stringify(p.states)}`);
    console.log(full ? p.body : p.body.slice(0, 400) + (p.body.length > 400 ? ' …' : ''));
    console.log();
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
