#!/usr/bin/env node
/**
 * Evento Pipeline Test event on RaceResult — create it, and fire test crossings.
 *
 *   node scripts/rr-test-event.js create            # copy 405167 → new event, wipe its raw data
 *   node scripts/rr-test-event.js info <eventId>    # contests / timing points / counts
 *   node scripts/rr-test-event.js crossing <eventId> <bib> <timingPoint> [HH:MM:SS]
 *
 * Auth: RR_TEST_APIKEY from .env (never committed). Destructive calls
 * (rawdata/delete) only ever target the event id createevent just returned,
 * and only if its name is TEST_NAME. There is deliberately no deleteevent.
 */
require('dotenv').config();

const RR = 'https://events.raceresult.com';
const SOURCE_EVENT = 381218;                 // Test-Event-2026 (owned by the Evento user) — read only (copyOf)
const TEST_NAME = 'Evento Pipeline Test';

async function login() {
  const key = process.env.RR_TEST_APIKEY;
  if (!key) throw new Error('RR_TEST_APIKEY not set in .env');
  const r = await fetch(`${RR}/api/public/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `apikey=${encodeURIComponent(key)}`,
  });
  const t = (await r.text()).trim().replace(/^"|"$/g, '');
  if (!r.ok || !t) throw new Error(`login failed (${r.status})`);
  return { Authorization: `Bearer ${t}` };
}

async function call(H, path, params = {}, method = 'GET') {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null)).toString();
  const res = await fetch(`${RR}/${path}${qs ? `?${qs}` : ''}`, { method, headers: H });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}

const eventApi = (id, p) => `_${id}/api/${p}`;

async function info(H, id) {
  const list = await call(H, 'api/public/eventlist', { year: new Date().getFullYear(), addsettings: 'EventName,EventDate' });
  const ev = list.find((e) => String(e.ID) === String(id));
  const contests = await call(H, eventApi(id, 'contests/get'), { lang: 'en' });
  const tps = await call(H, eventApi(id, 'timingpoints/get'));
  const raw = await call(H, eventApi(id, 'rawdata/count'));
  const exps = await call(H, eventApi(id, 'exporters/get'));
  console.log(`event ${id}: ${ev?.EventName ?? '?'} (${ev?.EventDate ?? '?'}) participants=${ev?.Participants ?? '?'}`);
  console.log('  contests:', contests.map((c) => `${c.ID}:${c.Name}`).join(', '));
  console.log('  timing points:', (Array.isArray(tps) ? tps : []).map((t) => t.Name).join(', '));
  console.log('  raw data records:', raw, ' exporters:', (Array.isArray(exps) ? exps : []).map((e) => e.Name).join(', ') || 'none');
  return ev;
}

async function create(H) {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`creating "${TEST_NAME}" (${today}) as a copy of ${SOURCE_EVENT}…`);
  const created = await call(H, 'api/public/createevent', {
    name: TEST_NAME, date: today, country: 372, copyOf: SOURCE_EVENT, templateID: 0, mode: 0, laps: 0,
  });
  const newId = String(typeof created === 'object' ? (created.ID ?? created.id ?? created.EventID ?? JSON.stringify(created)) : created).trim();
  if (!/^\d+$/.test(newId)) throw new Error(`unexpected createevent response: ${JSON.stringify(created).slice(0, 200)}`);
  if (newId === String(SOURCE_EVENT)) throw new Error('createevent returned the source id — aborting');
  console.log('created event', newId);

  // Safety: only wipe raw data on the event we just created, verified by name.
  // The public event list lags a few seconds behind createevent — retry.
  let ev = null;
  for (let i = 0; i < 6 && ev?.EventName !== TEST_NAME; i++) {
    if (i) await new Promise((r) => setTimeout(r, 5000));
    ev = await info(H, newId);
  }
  if (ev?.EventName !== TEST_NAME) throw new Error(`event ${newId} is named "${ev?.EventName}", not "${TEST_NAME}" — not wiping`);
  console.log(`wiping raw data on ${newId} only…`);
  await call(H, eventApi(newId, 'rawdata/delete'), { filter: '' });
  await call(H, eventApi(newId, 'times/delete'), { filter: '' }).catch((e) => console.log('  times/delete:', e.message));
  console.log('  raw data now:', await call(H, eventApi(newId, 'rawdata/count')));
  console.log(`\nDONE. Link RaceResult event ${newId} to the CMS race.`);
}

/** HH:MM:SS → seconds (RaceResult raw times are decimal seconds since midnight). */
function toSeconds(hms) {
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

async function crossing(H, id, bib, timingPoint, hms) {
  const ev = await info(H, id);
  if (ev?.EventName !== TEST_NAME) throw new Error(`refusing: event ${id} is "${ev?.EventName}", not the test event`);
  const now = new Date();
  const time = hms ? toSeconds(hms) : now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
  await call(H, eventApi(id, 'rawdata/addmanual'), { timingPoint, bib, time, addT0: false });
  console.log(`added raw read: bib ${bib} @ ${timingPoint} time=${time}s → raw data now ${await call(H, eventApi(id, 'rawdata/count'))}`);
}

(async () => {
  const [cmd, a, b, c, d] = process.argv.slice(2);
  const H = await login();
  if (cmd === 'create') return create(H);
  if (cmd === 'info' && a) return info(H, a);
  if (cmd === 'crossing' && a && b && c) return crossing(H, a, Number(b), c, d);
  console.log('usage: create | info <eventId> | crossing <eventId> <bib> <timingPoint> [HH:MM:SS]');
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
