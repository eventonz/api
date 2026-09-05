/**
 * V2 pull — refresh one v2 race's splits cache from its provisioned feed.
 *
 * Reads the feed URL provisioning stored on v2.races (rr_splits_url), fetches
 * and parses the column-form feed (see provision.parseFeedBody), and writes
 * one Redis key per athlete:
 *
 *   redis_splits:{v2_race_id}:athlete:{athlete_id} = {"bib":…, "splits":[…]}
 *
 * The stored splits are the compact records the list emits (name, label,
 * rr_id, tod, time, gun, chip, rank…, leg/start/finish flags) with the
 * sentinel already dropped. Only splits with a time or a prediction exist in
 * the feed — the read side renders configured-but-uncrossed splits from the
 * contest config, not from here.
 *
 * NOTE: v2 race ids share the redis_splits keyspace with v1 public.races ids
 * (chosen deliberately — one namespace). While both pipelines are live, a v2
 * race id must not collide with a live v1 Redis-pulled race id; the scheduler
 * guards this at arm time.
 */

const pool  = require('../../config/database');
const redis = require('../../config/redis');
const { parseFeedBody } = require('./provision');

const SPLITS_TTL_SECS = 72 * 3600; // matches the v1 pull
const PIPELINE_CHUNK  = 1000;

async function pullV2Race(v2RaceId) {
  const { rows } = await pool.query(
    'SELECT id, rr_splits_url FROM v2.races WHERE id = $1',
    [v2RaceId]
  );
  if (!rows.length) throw new Error(`v2 race ${v2RaceId} not found`);
  const feedUrl = (rows[0].rr_splits_url || '').trim();
  if (!feedUrl) throw new Error(`v2 race ${v2RaceId} has no provisioned feed (rr_splits_url empty — run provision first)`);

  const t0 = Date.now();
  const res = await fetch(feedUrl, { signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error(`Feed HTTP ${res.status}`);
  const body = await res.text();
  const tFetch = Date.now() - t0;

  const athletes = parseFeedBody(body);
  const records = athletes.reduce((n, a) => n + a.splits.length, 0);

  let pipeline = redis.pipeline();
  let inChunk = 0;
  for (const a of athletes) {
    pipeline.set(
      `redis_splits:${v2RaceId}:athlete:${a.id}`,
      JSON.stringify({ bib: a.bib, splits: a.splits }),
      'EX', SPLITS_TTL_SECS
    );
    if (++inChunk >= PIPELINE_CHUNK) {
      await pipeline.exec();
      pipeline = redis.pipeline();
      inChunk = 0;
    }
  }
  if (inChunk > 0) await pipeline.exec();

  await pool.query(
    `UPDATE v2.races SET last_pull_at = NOW()
        ${records > 0 ? ', last_data_at = NOW()' : ''}
      WHERE id = $1`,
    [v2RaceId]
  );

  return {
    raceId: v2RaceId,
    athletes: athletes.length,
    records,
    bytes: body.length,
    ms: { fetch: tFetch, total: Date.now() - t0 },
  };
}

module.exports = { pullV2Race };
