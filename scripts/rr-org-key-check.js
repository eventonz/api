#!/usr/bin/env node
/**
 * Diagnose an organisation's RaceResult API key access (19 Nov 2026).
 *   node scripts/rr-org-key-check.js <org name pattern>     e.g. timit, chrono
 * Logs in with each stored key (v2 org, old v1 org) via /api/token/get, lists how
 * many RR events the key can see, then hits contests/get for every linked race.
 * 403 "no access to event" = the key lacks access on RaceResult's side — that is
 * the timer's to fix, never ours. Reads only; needs node-api/.env.
 */
const NA = require('path').resolve(__dirname, '..') + '/';
require('dotenv').config({ path: NA + '.env' });
const pool = require(NA + 'src/config/database');
const { cfmxDecryptHex } = require(NA + 'src/services/raceresult/cfmx');
const SEED = process.env.RR_ENCRYPTION_KEY || 'evento_rr_2024';
const dec = (s) => { s = String(s||'').trim(); return /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0 ? cfmxDecryptHex(s, SEED) : s; };
const H = { 'Content-Type': 'application/x-www-form-urlencoded' };
(async () => {
  const pat = process.argv[2];
  const { rows: orgs } = await pool.query(`SELECT o.id, o.name, o.v1_org_id, o.rr_apikey v2k, v1.rr_apikey v1k FROM v2.organisations o LEFT JOIN public.organisations v1 ON v1.id=o.v1_org_id WHERE o.name ILIKE $1`, ['%' + pat + '%']);
  for (const o of orgs) {
    console.log(`\n### org ${o.id} ${o.name} (v1 org ${o.v1_org_id})`);
    const { rows: races } = await pool.query(`SELECT id, name, rr_raceid, live_state, event_date, (SELECT count(*) FROM v2.athletes a WHERE a.race_id=r.id) athletes FROM v2.races r WHERE organisation_id=$1 AND rr_raceid IS NOT NULL ORDER BY event_date DESC NULLS LAST`, [o.id]);
    for (const [label, enc] of [['v2 org key', o.v2k], ['v1 org key', o.v1k]]) {
      if (!enc) { console.log(label, '— none stored'); continue; }
      const k = dec(enc);
      const r = await fetch('https://events.raceresult.com/api/token/get', { method: 'POST', headers: H, body: 'apikey=' + encodeURIComponent(k) });
      const body = await r.text(); let tok = ''; try { tok = JSON.parse(body).access_token || ''; } catch {}
      if (!tok) { console.log(label, 'token/get HTTP', r.status, body.slice(0, 60)); continue; }
      const el = await fetch('https://events.raceresult.com/api/public/eventlist', { headers: { Authorization: 'Bearer ' + tok } });
      const evs = await el.json().catch(() => null);
      console.log(`${label}: login OK (JWT) · eventlist ${Array.isArray(evs) ? evs.length + ' events, users ' + [...new Set(evs.map(e => e.UserName))].join(',') : 'HTTP ' + el.status}`);
      if (label === 'v1 org key' && o.v2k && dec(o.v2k) === k) { console.log('  (same key as v2)'); continue; }
      for (const race of races) {
        const c = await fetch(`https://events.raceresult.com/_${race.rr_raceid}/api/contests/get?lang=en`, { headers: { Authorization: 'Bearer ' + tok } });
        console.log(`  race ${String(race.id).padEnd(5)} RR ${race.rr_raceid} ${race.name.slice(0, 44).padEnd(44)} ${String(race.event_date||'').slice(0,10)} athletes ${String(race.athletes).padEnd(5)} → ${c.status}${c.status !== 200 ? ' ' + (await c.text()).slice(0, 40) : ''}`);
      }
    }
  }
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
