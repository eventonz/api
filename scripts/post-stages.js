#!/usr/bin/env node
/**
 * Post stage-race results or next-day starts to eventoapi.
 *
 *   node scripts/post-stages.js <event_id> <file.csv|json> --format evento|starts
 *        [--api http://127.0.0.1:3000] [--race 653]
 *
 * Key: env EVENTO_SERVER_KEY (api_keys.kind='server') or an evt_ timer token.
 *
 * CSV headers (case-insensitive; extra columns are ignored):
 *   evento : bib,stage_no,stage_name,stage_time,stage_rank,gc_time,gc_rank,cat_rank,gc_gap
 *   starts : bib,stage_no,stage_name,date,time,chute
 * A JSON file is either an array of such rows, or a full body
 * { format, results|starts, race_id } which is posted as is.
 */
const fs = require('fs');
const path = require('path');
const { parseCsv, rowsToBody } = require('./lib/stagesCsv');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

async function main() {
  // Positional args = everything that is not a --flag or a flag's value.
  const positional = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { i++; continue; }
    positional.push(argv[i]);
  }
  const [eventId, file] = positional;
  const format = arg('--format');
  const api = (arg('--api', process.env.EVENTO_API || 'http://127.0.0.1:3000')).replace(/\/$/, '');
  const race = arg('--race');
  const key = process.env.EVENTO_SERVER_KEY;
  if (!eventId || !file || !format) {
    console.error('Usage: node scripts/post-stages.js <event_id> <file.csv|json> --format evento|starts [--api URL] [--race v2_race_id]');
    process.exit(1);
  }
  if (!key) { console.error('Set EVENTO_SERVER_KEY (server API key or evt_ timer token).'); process.exit(1); }

  const text = fs.readFileSync(path.resolve(file), 'utf8');
  let body;
  if (/\.json$/i.test(file)) {
    const parsed = JSON.parse(text);
    body = Array.isArray(parsed) ? rowsToBody(parsed, format) : parsed;
  } else {
    body = rowsToBody(parseCsv(text), format);
  }
  if (race) body.race_id = Number(race);

  const url = `${api}/v2/stages/${encodeURIComponent(eventId)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const out = await res.text();
  console.log(`${res.status} ${url}`);
  console.log(out);
  if (!res.ok) process.exit(2);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
