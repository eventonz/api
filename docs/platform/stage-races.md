# Stage races

Multi-day events where a **team** (Epic Series: two riders, one bib) is the timed
unit. Per day the app needs the team's **stage time and rank**, the **GC**
(general classification: cumulative time, rank, category rank, gap to the
leader), and the **next-day start** (date, time and start chute). None of that
is a split crossing, so it does not go through `redis_splits`; it has its own
tables, Redis key and endpoints, built on the same pipeline shape as live
timing: **eventoapi queues → evento-worker converts and writes → eventoapi
reads**.

Added 26 Oct 2026 for Epic Series (first app: Race Ranger / MTB Epic Series).
CMS side: migration 049 (`v2.stage_results`, `v2.stage_starts`,
`v2.athletes.extras`, `v2.contests.stage_columns`).

```
timer / organiser CSV ──POST /v2/stages/{event}──▶ eventoapi ──LPUSH ingest_queue──▶ evento-worker
                                                                                      │ writes
                                                    v2.stage_results / v2.stage_starts (truth)
                                                    redis_stages:{race_id}:bib:{bib}   (read key)
app ◀──GET /v2/stages/{event}?bib=──── eventoapi ◀── Redis, else Postgres (and writes the key back)
```

## Tables (schema `v2`)

| Table | Key | Columns |
|---|---|---|
| `stage_results` | `(race_id, raceno, stage_no)` | `stage_name, stage_time, stage_rank, gc_time, gc_rank, cat_rank, gc_gap, source, updated_at` |
| `stage_starts` | `(race_id, raceno, stage_no)` | `stage_name, start_date, start_time, chute, updated_at` |

`race_id` is `v2.races.id`; `raceno` is the **team bib** as stored on
`v2.athletes.raceno` (no leading zeros). Riders live in
`v2.athletes.athlete_details[]` (`name, country, athletenumber "9001-1",
status`), team meta in `v2.athletes.extras` (jsonb, free-form).

## Ingest — `POST /v2/stages/{event_id}`

Public route group (IP rate-limited with `/v2/tracks`), but **credentialled**:
`Authorization: Bearer` must be a **server API key** (`api_keys.kind='server'`)
or an **`evt_` timer token**. App keys and install tokens get `403`.

Body:

```json
{
  "format": "evento" | "raceresult_list" | "starts",
  "results": [ ... ],      // evento / raceresult_list
  "starts":  [ ... ],      // starts
  "race_id": 653           // optional: which v2.races row of the event (default: the first)
}
```

| `format` | Row shape | Worker writes |
|---|---|---|
| `evento` | `{bib, stage_no, stage_name?, stage_time?, stage_rank?, gc_time?, gc_rank?, cat_rank?, gc_gap?}` — already canonical | `stage_results` |
| `raceresult_list` | a RaceResult list export row per team (`Bib`, stage/GC columns as named in the RR file; the worker maps them, see `v2.contests.stage_columns`) | `stage_results` |
| `starts` | `{bib, stage_no, stage_name?, date, time?, chute?}` | `stage_starts` |

The route validates the shape, resolves the event's races (`v2.races.event_id`),
and queues one job:

```json
{ "race_id": 653, "datetime": "2026-10-27T15:02:11.511Z", "endpoint": "v2/stages",
  "payload": { "format": "evento", "results": [ ... ] } }
```

Reply `202 {"status":"queued","race_id":653}`. `400` bad body, `404` unknown
event or a `race_id` that is not part of it, `401/403` credential.

Re-posting is safe: the worker upserts on the primary key, so a corrected
day's results simply overwrite.

## Redis read key

`redis_stages:{v2_race_id}:bib:{raceno}` — JSON, TTL **72 h**
(`STAGES_TTL_SECS` in `src/services/stages.js`, the same value as the worker's
`SPLITS_TTL_SECS` for `redis_splits`). Written by the worker after each job and
by the API on a cache miss.

```json
{
  "stages": [
    { "no": 1, "name": "Prologue", "time": "00:32:10", "rank": 4, "gc_time": "00:32:10", "gc_rank": 4, "cat_rank": 1, "gap": "+00:01:02" },
    { "no": 2, "name": "Stage 2",  "time": null, "rank": null, "gc_time": null, "gc_rank": null, "cat_rank": null, "gap": null }
  ],
  "next_start": { "stage_no": 2, "name": "Stage 2", "date": "2026-10-27", "time": "07:00", "chute": "B" },
  "updated": "2026-10-26T15:40:00.000Z"
}
```

Rules (all in `services/stages.js`, unit-tested in `tests/stages.test.js`):
- `stages` is sorted by `stage_no`. A stage that only has a start row (not
  ridden yet) is listed with every time/rank `null` so the app can grey it.
- `next_start` is the **lowest `stage_no` in `stage_starts` with no result
  row**, or `null` once every published start has a result.
- `updated` is the newest `updated_at` across the rows.

## Read — `GET /v2/stages/{event_id}?bib=`

Authed group (install token or key, 600/min). `bib` is normalised like the
startlist search (trimmed, leading zeros stripped: `09001` → `9001`).

1. `MGET` the key for every race of the event; the first hit is returned
   (`X-Cache: HIT`).
2. Otherwise build from Postgres, write the key back (`X-Cache: MISS`).
3. `404 {"error":"No stage data for this bib"}` when neither table has a row.

Response = the Redis document plus `race_id` and `bib`:

```json
{ "race_id": 653, "bib": "9001", "stages": [ ... ], "next_start": { ... } | null, "updated": "..." }
```

Riders and team meta come from the startlist endpoints, not from here:
`POST /v2/athletes/{event}` rows carry `members[] {name, bib, country, status}`
and `extras`; `PATCH /v2/athletes/{event}` (follow-stub revalidation) now
returns `members, country, entry_type, extras` too, so a followed team keeps
its riders.

## CLI — `scripts/post-stages.js`

```bash
EVENTO_SERVER_KEY=… node scripts/post-stages.js evento-pipeline-test-2 day1.csv --format evento --api http://127.0.0.1:3000 --race 653
EVENTO_SERVER_KEY=… node scripts/post-stages.js evento-pipeline-test-2 day2-starts.csv --format starts
```

- `--format evento|starts`; `--api` defaults to `EVENTO_API` or
  `http://127.0.0.1:3000`; `--race` sets `race_id`.
- CSV headers are matched case-insensitively with aliases (`Bib/raceno/team`,
  `Stage/stage_no`, `Rank`, `GC`, `gap`, `chute/start_group/wave`, …); extra
  columns are ignored, rows without a bib or stage are dropped. Canonical
  headers: `bib,stage_no,stage_name,stage_time,stage_rank,gc_time,gc_rank,cat_rank,gc_gap`
  and `bib,stage_no,stage_name,date,time,chute`.
- A `.json` file may be an array of rows (converted like CSV) or a complete
  body, which is posted as is.

## Checking a post landed

```bash
redis-cli … LRANGE ingest_queue 0 5          # job envelope, endpoint "v2/stages"
redis-cli … GET redis_stages:653:bib:9001    # after the worker ran
psql … -c "select * from v2.stage_results where race_id=653 order by raceno, stage_no"
```

Test data: `v2.races.id` 653 (`evento-pipeline-test-2`), teams 9001–9004.
