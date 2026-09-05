/**
 * READ ONLY probe: which [Split.*] properties does RaceResult expose?
 *
 * The existing API|AthleteSplitsJSON list on event 154651 uses
 *   Concatenate('...' & [Split.ID] & ... ; ','; [Split.Time]>0)
 * i.e. a generic iterator over every split the athlete has, regardless of name.
 * If that iterator exposes the same properties the splits feed needs, the feed
 * needs no generated per-event list at all.
 *
 * data/list accepts arbitrary field expressions and writes nothing, so each
 * candidate can be tried in isolation.
 *
 * Usage: node scripts/rr-probe-split-iterator.js <rr_event_id> <org_id>
 */
require('dotenv').config();

const pool = require('../src/config/database');
const redis = require('../src/config/redis');
const rr = require('../src/services/raceresult/orgApi');

const PROPS = [
  'ID', 'Name', 'Label', 'Time', 'ToD', 'Gun', 'Chip', 'Distance', 'OrderPos',
  'Overall', 'Gender', 'AgeGroup', 'Pace', 'Speed', 'Predicted', 'Predicted.ToD',
  'Contest', 'TimingPoint', 'RaceTime', 'NonsenseControl',
];

async function tryField(token, rrEventId, expression) {
  const url =
    `https://events.raceresult.com/_${rrEventId}/api/data/list` +
    `?lang=en&fields=${encodeURIComponent(JSON.stringify(['Bib', expression]))}` +
    `&filter=&sort=Bib&listformat=JSON&limitFrom=0&limitTo=3`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.text();
  if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${body.slice(0, 120)}` };
  try {
    return { ok: true, sample: JSON.parse(body).slice(0, 2) };
  } catch {
    return { ok: false, error: `unparseable: ${body.slice(0, 120)}` };
  }
}

(async () => {
  const rrEventId = Number(process.argv[2]);
  const orgId = Number(process.argv[3]);
  if (!rrEventId || !orgId) {
    throw new Error('usage: node scripts/rr-probe-split-iterator.js <rr_event_id> <org_id>');
  }

  const token = await rr.tokenForOrg(orgId);
  console.log(`probing event ${rrEventId}\n`);

  // Baseline: does the iterator work at all here, and how many splits per athlete?
  const base = await tryField(token, rrEventId, 'Concatenate([Split.Name]; "|"; [Split.Time]>0)');
  console.log('iterator baseline:', JSON.stringify(base).slice(0, 400), '\n');

  for (const prop of PROPS) {
    const expr = `Concatenate([Split.${prop}]; "|"; 1)`;
    const r = await tryField(token, rrEventId, expr);
    const shown = r.ok ? JSON.stringify(r.sample).slice(0, 160) : r.error;
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} Split.${prop.padEnd(14)} ${shown}`);
  }

  await pool.end();
  await redis.quit().catch(() => {});
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
