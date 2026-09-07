# Live timing pipeline (RaceResult → app)

RaceResult is the only timing platform on the v2 pipeline today. Other timers
(Timit, Chrono, Racetec…) still use the v1 path or a results-link-only event.

## One race, end to end

```
CMS: create event from RR ID ──▶ loads contests/splits/legs ──▶ writes results LIST into RR file ──▶ installs EXPORTER
                                                                      │                                  │
CMS: Go live (now or scheduled) ──▶ v2.races.live_state/live_from/live_until                             │
                                                                      │                                  │
worker schedule-worker (tick 60 s) ──▶ pulls the list per contest every 150 s ──▶ redis_splits:{race}:athlete:{id}
                                                                                                         │
RaceResult exporter fires on every raw read ──▶ POST eventoapi.com/v2/tracks/raceresult/{rr_eventid} ──▶ ingest_queue
                                               ──▶ ingest-worker merges into redis_splits + upserts v2.rr_results + enqueues athlete push
app polls /v2/splits, /v2/tracking (install token) ◀── reads Redis while live, v2.rr_results once done
CMS: Stop live ──▶ finalising ──▶ worker: final pull, upsert v2.rr_results, delete stale rows, Redis TTL 1 h ──▶ done
```

## 1. Linking a race to RaceResult (CMS)

`createEventFromRR` / `setRaceResultEventId` (NEXTJS-CMS `lib/events.ts`,
`lib/raceresult-picker.ts`) then `setupRaceResult()` (`lib/rr-live.ts`) runs:

1. **Contests + splits + legs** — `lib/contest-loading.ts` calls the Org API
   `contests/get` and `splits/get?Contest=` per contest. `SplitType 9` = leg →
   `v2.legs` (with start/end split refs); everything else → `v2.splits`
   (`rr_splitid`, `accum_km`, `percent_course`, `is_leg=false`). "Update" keeps
   organiser edits (renames, visibility, speed type); "Replace" wipes and reloads.
2. **Results list** — CMS → `POST eventoapi.com/v2/raceresult/provision/{race_id}`
   with the **organisation's RaceResult API key** as bearer. node-api
   `services/raceresult/provision.js`: enumerates every split (incl. legs) across
   contests, generates the list body (`listTemplate.buildColumnFields`), writes it
   as list **`evento|full-results`** (`lists/new` + `lists/save`), verifies by
   rendering it, stores `rr_list_name`, `rr_splits_url` (Org render URL),
   `rr_splits_hash`, `provisioned_at` on `v2.races`. Requires `RR_ALLOW_WRITES=1`
   on the API host. No Simple API key is minted any more (Simple API = 1 call/s/IP).
3. **Push exporter** — CMS `lib/rr-exporter.ts` → Org API `exporters/save`:
   name `Evento Created Exporter`, `DestinationType HTTP`, destination
   `https://eventoapi.com/v2/tracks/raceresult/{rr_eventid}`, empty trigger =
   fires on every new raw record, `StartPaused false`. Template (one JSON struct
   per crossing, `evento_created: true`, `split_speed` **quoted**):
   `{"bib":[Bib],"rr_splitid":"[{lastsplit}.ID]","athlete_id":"[ID]","firstname":…,"contestid":[Contest],"race_time":"[format([{LastSplit}.Rounded];"hh:mm:ss")]","tod":"[format([{LastSplit}.ToD.Rounded];"hh:mm:ss")]","start":[if(…=[Start.OrderPos];1;0)],"finish":[if(…=[Finish.OrderPos];1;0)],"split_speed":"[{LastSplit}.Speed]","evento_created":true}`
   RaceResult's exporter model has **no `Active` flag**; `StartPaused` is the only
   run-state field.

Settings → race card → "In the RaceResult event file" shows both with
Create / Re-write buttons and a **splits-drift** check (`/provision/:id/status`
compares the current RR splits hash with the stored one). The list is re-written
automatically after **Load contests**, at **Go live / Schedule**, and by the
worker at **arming**. The exporter never needs re-writing for split changes
(its template resolves `{LastSplit}` at fire time).

## 2. The results list (what the worker pulls)

Rendered per contest through the Org API:
`GET https://events.raceresult.com/_{rr_eventid}/api/lists/create?listname=evento%7Cfull-results&format=JSON&contest={id}`
with `Authorization: Bearer <token from /api/public/login apikey=…>` (token cached
in Redis `rr:token:v2org:{org}` 10 min). Output: one row per athlete
`{ "bib", "id", "splits": "<JSON string>" }` where the string opens with a
sentinel `{"s":1}` and then one compact record per split the athlete has a time
**or a prediction** for:

```
{ name, label, rr_id, tod, time, gun, chip, rank, rank_gender, rank_ag, pace, speed, predicted, start, finish, leg? }
```

Legs (`leg: 1`) carry their **duration** in `tod/time/gun/chip`. Untimed splits
are not emitted (gate: `[Split.OrderPos]>0 AND (ToD<>"" OR Predicted<>"")`).

Parsing is tolerant (`parseSplitsColumn` in worker `lib/rrFeed.js` and API
`services/raceresult/provision.js`): strict `JSON.parse`, else scan out `{…}`
objects; anything without `rr_id` is dropped. Why: RaceResult sometimes mangles
the sentinel on empty contests (`{"_":1}`, `[{"s":1}_`), and **masks data of
non-activated participants with underscores** (`"Robi_son"`, `"2_:00:35"`) which
shreds the JSON. An athlete whose splits column is long but yields no records is
flagged `corrupt` and the pull **leaves that athlete's cached data untouched**.

## 3. Live state machine (`v2.races.live_state`)

| State | Set by | Worker behaviour |
|---|---|---|
| `idle` | default; CMS Schedule sets `live_from`/`live_until` | If `live_from` within 10 min → arms |
| `armed` | worker (10 min before `live_from`) | Drift check → re-provision if splits moved; proving pull; pull every 150 s |
| `live` | worker at `live_from`; **CMS Go live now** (sets `live_from=now`, `live_until=null`) | Pull every 150 s; accepts exporter pushes |
| `finalising` | **CMS Stop live** (sets `live_until=now`); worker at `live_until`+3 h; ops auto-stop at 36 h | Final pull → upsert `v2.rr_results` → delete rows not in the final pull → Redis keys TTL 1 h → `done` |
| `done` | worker | Reads fall back to `v2.rr_results`. Go live / Schedule allowed again. |
| `error` | worker after 3 consecutive pull failures | Alert; CMS "Clear error" → idle |

Ingest accepts pushes only in `armed`/`live`/`finalising` (`/v2/tracks` checks a
30 s Redis cache of race states). Tracking answers in those states and `done`.

Scheduler constants (env): `PULL_INTERVAL_S=150`, `ARM_BEFORE_MIN=10`,
`FINALISE_GRACE_H=3`, `MAX_LIVE_H=20` (warn), `AUTO_STOP_H=36` (auto-finalise).

## 4. Pull (worker `src/lib/rrFeed.js`, API `services/raceresult/v2Pull.js`)

`forEachFeedChunk(race)`: `contests/get` → for each contest render the list →
parse → callback per contest, so memory peaks at the largest contest (Brighton
21 MB whole vs 10.7 MB largest contest; Run Melbourne 27k athletes ≈ 100 MB in
7 renders, ~17 s). `pullRace` SETs `redis_splits:{race}:athlete:{id}` =
`{ bib, splits:[…] }` (TTL 72 h) for every parsed athlete — **overwrite, not
merge** — so deleting times in RaceResult empties Redis on the next pull; then
`UPDATE v2.races SET last_pull_at[, last_data_at]`. Legacy races with no
`rr_list_name` pull the old whole-feed `rr_splits_url` (Simple API).

Manual: CMS Overview **Pull now** → `POST /v2/raceresult/pull/{race_id}` (org key).

## 5. Push (exporter → `/v2/tracks` → ingest-worker)

`node-api src/routes/v2/tracks.js`: accepts **any Content-Type** (RaceResult
posts `text/plain`), repairs `"key":,` empty values (an unquoted empty RR
expression), resolves `{rr_eventid}` → live v2 races (Redis-cached 30 s),
LPUSHes `{ race_id, datetime, endpoint:'v2/tracks/raceresult', payload }` onto
`ingest_queue`, returns 202. Non-live → 202 "Race not accepting data" + counter
`ops:pushes_ignored:{race}:{10-min bucket}` (feeds the "exporter while not live"
alert). Both the Evento struct and Ugo's native array are normalised
(`normalisers/raceresult.js`).

`evento-worker src/handlers/v2tracks.js` per crossing: `toRecord` (maps to the
compact record; `start`/`finish` from config position), `mergeIntoRedis`
(WATCH/MULTI read-modify-write; replace same `rr_id` else append; sets
`pushed_at`), `upsertResultRow` into `v2.rr_results`, and if the configured split
has `send_push` and the crossing is new → LPUSH `notify_queue` (see
push-notifications.md). `touchLastData` throttled 30 s.

Pull and push formats differ in time strings today (`27:09` vs `00:27:09`) —
normalising in the worker is queued.

## 6. Results table `v2.rr_results`

One table for every RaceResult race (decision 30 Aug 2026), same columns as the
old per-timer tables: `race_id, race_no (bib), split_id, rr_splitid, athlete_id,
split_tod, split_gun, split_chip, overall_rank, gender_rank, agegroup_rank,
splitpace, splitpredictedtod, splitpredictedracetime, splitspeed, updated`,
UNIQUE `(race_id, athlete_id, split_id)`. Written live by pushes and at finalise
by the worker; finalise also **deletes** rows absent from the final pull. Legs
are rows too (`rr_splitid` = leg id, duration in `split_tod`).

## 7. Reads (what the app gets)

- `POST /v2/splits/{event}?id={athlete_id}` — live: `buildFromV2Redis`
  (`services/splits/v2rr.js`) from `redis_splits`; done: `buildFromV2Config`
  joins `v2.rr_results` to configured splits by `rr_splitid`. Response is the
  `version2.items` document: `summary`, `title "Legs"` + `splits` rows
  `[label, time, pace|speed]` when legs exist, `title` + `tabbedtable` for splits.
- `POST /v2/tracking/{event}` `{tracks:[athlete_id…]}` — v2-native path
  (`services/tracking.js buildTrackingV2`): last crossed configured split →
  `percent_course` (accum_km / contest distance), dead-reckoned forward at the
  split speed (never behind the last mat), `path: "p_{contest}"` (legacy;
  app matches by contest). Only while `armed/live/finalising/done`.
- `GET /v2/config/{event}` — for v2-native events built from `v2.contests` ↔
  `v2.courses`: `tracking.paths[]` one per contest with a course (`geojson` CDN
  URL, `contest`, `contest_name`, `course_id`, `is_tracking`), `athletes.url`,
  `athlete_details.url`.

## 8. Participant webhooks

CMS Athletes → RR webhooks panel writes `Evento Participant Update` / `Evento New
Participant` webhooks in the RR file pointing at
`https://eventoapi.com/v2/rr_webhook/{race_id}`. API enqueues; worker
`handlers/rrWebhook.js` upserts `v2.athletes` (identity = RR `ID`, else bib).

## 9. Activity log and alerts

Every stage logs to Redis `race:log:{race_id}` (newest first, 50 000 cap, 7 days):
kinds `state · pull · list · finalise · push · webhook · notify · error`. CMS:
Overview card shows the latest line, `/events/{event}/log` is the full page with
kind filters (API `GET /v2/raceresult/log/{race_id}`). Worker `lib/ops.js` raises
admin alerts (see operations.md).

## 10. Testing without a timing box

RaceResult test event **421131 "Evento Pipeline Test"** (Evento account) copied
from Evento-owned 381218: 3 contests, timing points START/5K…/FINISH, 100
participants, 3 legs (IDs 23–25). `node-api/scripts/rr-test-event.js`
(key `RR_TEST_APIKEY` in `.env`) creates/inspects it. **Manual raw reads via
`rawdata/addmanual` are NOT processed by RaceResult** (Result -255) — use
RaceResult's **RaceSim** in the desktop software, which also fires the exporter.
Non-activated participants render masked; activate some for clean feeds.
