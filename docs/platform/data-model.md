# Data model

## Postgres `pgevento`, schema `v2`
| Table | Purpose / key columns |
|---|---|
| `organisations` | tenant; `rr_apikey` (cfmx-encrypted RaceResult key), `v1_org_id`, `timer_platform` |
| `organisation_users`, `users`, `user_sessions`, `password_reset_tokens`, `member_scopes`, `event_collaborators` | CMS auth and roles (`role`, `isSuperadmin`) |
| `apps` | `mode single|multi`, `brand`, `accent`, `events jsonb[]` (`id,name,meta,image,published,link`), store URLs, `home_blocks` |
| `events` | `id` = slug; `event_json` (name, dateLabel, venue, date, timeZone, accent, hero, nav, `hideNav`, `linkOnly`, northsouth) |
| `pages` | `slug`, `page_type`, `page_json` (blocks) |
| `races` | one per RaceResult event: `rr_raceid`, `organisation_id`, `event_id`, `event_date`, `time_zone`, `status`, `v1_race_id` (bridge), `entrants_last_loaded`; **list**: `rr_list_name`, `rr_splits_url`, `rr_splits_hash`, `provisioned_at`; **live**: `live_state idle|armed|live|finalising|done|error`, `live_from`, `live_until`, `last_pull_at`, `last_data_at` |
| `contests` | `contest_id` (RR), `name`, `distance_km`, `course_id` → courses, `is_tracking`, `await_at_split`, `elevation_y_scale`, `summary_split_ids` |
| `splits` | per contest timing point: `rr_splitid`, `name`, `rr_splitname`, `sort_order`, `split_type`, `is_leg=false`, `visible`, `distance_m`, `accum_km`, `percent_course`, `default_speed`, `send_push`, `push_type` (unused) |
| `legs` | RR SplitType 9: `rr_legid`, `label`, `start_split_id`, `end_split_id`, `icon`, `speed_type`, `distance_m`, `visible` |
| `courses` | `geojson jsonb`, `distance_km`, `climb_m`, `is_tracking`, GPX download flag; published as `courses/{id}.geojson` |
| `athletes` | startlist: `raceno` (bib), `athlete_id` (RR ID), names, `contest`, `info` (line 1 contest, line 2 club), `can_follow`, search tsvector |
| `rr_results` | **the** results table (all RR races): `race_id, race_no, split_id, rr_splitid, athlete_id, split_tod, split_gun, split_chip, *_rank, splitpace, splitpredicted*, splitspeed, updated`; UNIQUE `(race_id, athlete_id, split_id)` |
| `device_tokens`, `device_topics`, `follows`, `notifications` | push (see push-notifications.md) |
| `cheers` | no-login cheer board |
| `schedule_days`, `schedule_items`, `locations` | schedule |
| `media`, `data_files`, `file_versions`, `publishes`, `preview_tokens` | media library, publish versions/history |
| `app_installs` (public) | install counting |
| `api_keys` (public) | `key_hash` (sha256), `app_id`, `kind app|server`, `active`, `last_used_at` |
| `timer_api_tokens` (public) | `evt_` tokens for timers (hash, org_id, app_id) |

`public.*` is the v1 world (races, events=contests, organisations, per-timer
results tables) — read-only for the CMS; the API still serves `/v1` from it.

## Redis (Valkey) keys
| Key | Type / TTL | Written by | Read by |
|---|---|---|---|
| `redis_splits:{race_id}:athlete:{athlete_id}` | JSON `{bib, splits[]}`, 72 h (1 h after finalise) | worker pull (overwrite), ingest merge (`pushed_at`) | `/v2/splits`, `/v2/tracking` |
| `ingest_queue`, `notify_queue` | lists | API tracks/webhook routes; ingest-worker | ingest-worker; notify-worker |
| `failed:{process|webhook|push}:{race_id}` | list, 7 d | worker on handler error | dashboard requeue/clear |
| `race:log:{race_id}` | list ≤50 000, 7 d | worker + API (`raceLog`) | CMS activity log via API |
| `ops:alerts` | list ≤500, 30 d | worker `lib/ops.js` | Health page |
| `ops:alert:sent:{key}` | flag, 24 h | worker | dedupe |
| `ops:pushes_ignored:{race}:{10-min bucket}` | counter, 25 min | API tracks | worker alert |
| `ops:restarts:schedule:{hour}` | counter, 2 h | scheduler startup | worker alert |
| `worker:alive:{host}:{pid}` | JSON, 15 s heartbeat | every worker process | dashboard, Health, ops |
| `worker:stats:*`, `worker:recent` | counters / list | workers | dashboard |
| `schedule:lock`, `schedule:pullfails:{race}` | lock / counter | scheduler | scheduler |
| `rr:token:v2org:{org}` (worker), `rr:token:{v1org}` (API) | RR bearer token, 10 min | Org API login | pulls, provisioning |
| `v2:tracks:rr_event:{rr_eventid}` | race list cache, 30 s | API tracks | API tracks |
| `apikey:{sha256}` | key row JSON / 'invalid', 5 min | auth hook | auth hook |
| `revoked:install:{install_id}` | flag, 30 d | ops / manual | auth hook |
| `install:{app}:{install_id}` | hash, 90 d | register | — |
| `config:reads_require_install_token` | "1"/"0" | ops (manual) | auth hook (30 s cache) |
| `rl:{name}:{id}:{bucket}` | counters | rate limiter | rate limiter |
| `push:sent:{race}:{athlete}:{kind}:{split}` | flag, 6 h | notify-worker | dedupe |
| `v2:tracks:last_data:{race}` | throttle, 30 s | ingest-worker | — |

## Spaces (CDN) layout
`apps/{appId}/index.json` · `events/{event}/manifest.json` · `events/{event}/event.json` ·
`events/{event}/pages/{slug}.json` · `events/{event}/data/*.json` ·
`events/{event}/courses/{course_id}.geojson`.
