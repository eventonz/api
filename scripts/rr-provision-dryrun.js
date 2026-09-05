/**
 * Dry run for RaceResult list provisioning — READ ONLY.
 *
 * Logs in with the organisation's RaceResult key, enumerates every split across
 * every contest, generates the list body, and cross-checks coverage against the
 * public results config. Writes nothing to RaceResult (and the client refuses
 * writes anyway unless RR_ALLOW_WRITES=1).
 *
 * Usage: node scripts/rr-provision-dryrun.js <rr_event_id> [--print]
 */
require('dotenv').config();

const pool = require('../src/config/database');
const redis = require('../src/config/redis');
const rr = require('../src/services/raceresult/orgApi');
const { buildListData, coverageGaps } = require('../src/services/raceresult/listTemplate');

(async () => {
  const rrEventId = Number(process.argv[2]);
  const printTemplate = process.argv.includes('--print');
  if (!rrEventId) throw new Error('usage: node scripts/rr-provision-dryrun.js <rr_event_id> [--print]');

  const { rows } = await pool.query(
    `SELECT id, orgid, event_name
       FROM races
      WHERE rr_eventid = $1 AND orgid IS NOT NULL
      ORDER BY id DESC LIMIT 1`,
    [rrEventId]
  );
  if (!rows.length) throw new Error(`no race with rr_eventid ${rrEventId}`);
  const { id: raceId, orgid: orgId, event_name: eventName } = rows[0];

  console.log(`race ${raceId} · org ${orgId} · ${eventName}`);
  console.log('RR writes allowed:', rr.writesAllowed());

  const token = await rr.tokenForOrg(orgId);
  console.log('token acquired:', token ? `yes (${token.length} chars)` : 'NO');

  const contests = await rr.getContests(token, rrEventId);
  console.log('contests:', contests.length);

  const splits = await rr.getAllSplits(token, rrEventId);
  console.log('split rows across contests:', splits.length);

  const { data, names, blocks, hash } = buildListData(splits);
  console.log('distinct names / blocks:', blocks);
  console.log('names:', names.join(', '));
  console.log('splits hash:', hash);
  console.log('template bytes:', data.length);

  const publicCfg = await rr.getPublicConfig(rrEventId).catch(() => null);
  if (publicCfg) {
    const gaps = coverageGaps(names, publicCfg.splits || []);
    console.log('coverage gaps vs public config:', gaps.length ? gaps.map((g) => g.name).join(', ') : 'none');
  } else {
    console.log('coverage gaps vs public config: public config unavailable');
  }

  if (printTemplate) console.log('\n--- generated template ---\n' + data);

  await pool.end();
  await redis.quit().catch(() => {});
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
