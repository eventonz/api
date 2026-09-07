# eventoapi.com — the Node API

Fastify 5 app in `node-api/` (`src/server.js`). Routes under `src/routes/v1`
(legacy Flutter) and `src/routes/v2` (new app + CMS). Everything the new app and
the CMS call is `/v2` (`docs/eventoapi_v2_contract.md`, `check-v2-only.sh`).

## Credentials — three kinds

| Credential | Who holds it | Where accepted | How |
|---|---|---|---|
| **Install token** (JWT, 24 h) | each app install | all authed `/v2` reads | `Authorization: Bearer eyJ…`. Issued by `POST /v2/auth/register`. Claims `sub=install_id, app_id, key_id, typ:'install', iss:'eventoapi'`, signed with `JWT_SECRET`. Revocation: Redis `revoked:install:{id}`. |
| **App API key** (`api_keys.kind='app'`) | baked into each app build (`configs/*.json eventoApiToken`) | `POST /v2/auth/register` only, once the switch is on | Raw key as bearer. Since 6 Sep 2026 the switch `config:reads_require_install_token=1` (Redis) makes app keys **register-only** → reads answer `401 {"code":"INSTALL_TOKEN_REQUIRED"}`. |
| **Server API key** (`api_keys.kind='server'`) | CMS (`EVENTOAPI_ANALYTICS_KEY`, key 9), worker push runner (key 11) | all authed `/v2` endpoints, `/v2/ops/*` | Raw key as bearer; exempt from the switch. |
| **Organisation RaceResult key** | stored encrypted on `v2.organisations.rr_apikey` (cfmx_compat, seed `RR_ENCRYPTION_KEY`) | `/v2/raceresult/*` only | Bearer = the org's own RR key for the race in the URL (tenant proof). `evt_` timer tokens also accepted. |
| **None (URL-gated)** | RaceResult servers/software | `/v2/tracks/raceresult/{rr_eventid}`, `/v2/rr_webhook/{race_id}` | Race must exist; pushes dropped unless live. IP rate-limited. |

Auth hook: `src/plugins/auth.js` (token or key, sets `request.auth`), tenant
hook in `routes/v2/raceresult.js`, `timer-auth.js` for `evt_` tokens.

### Install token flow
```
app launch ── POST /v2/auth/register  {install_id, platform, app_version}   Bearer <app key>
        ◀── { token, expires_at, ttl_seconds:86400, install_id, app_id }
every read ── Bearer <token>        401 TOKEN_EXPIRED / TOKEN_INVALID → register again, retry once
```
Register is limited to 30/h per `install_id`; a token cannot register (403).

### Rate limits (`src/plugins/rateLimit.js`, Redis fixed window, fail-open)
| Scope | Limit | Env |
|---|---|---|
| Authed `/v2` reads, per install token or key | 600 / min | `READS_PER_MINUTE` |
| `/v2/auth/register`, per install_id | 30 / h | — |
| Public ingest (`/v2/tracks`, `/v2/rr_webhook`), per IP | 3000 / min | `INGEST_PER_MINUTE` |
Headers `X-RateLimit-Limit/Remaining`, `429` + `Retry-After`.

## `/v2` endpoints

### App-facing (install token or key)
| Method / path | Purpose |
|---|---|
| `POST /v2/auth/register` | app key → install token |
| `GET /v2/config/{event}` | platform config document: `tracking.{update_freq,data,map_style,paths[]}`, `athletes.url`, `athlete_details.url`. Bridged from `/v1/config/{platform race}` when a v1 race exists, else built from `v2.contests`↔`v2.courses`. |
| `GET /v2/athletes/{event}` | startlist / search (`v2.athletes`) |
| `POST /v2/splits/{event}?id=&bib=&contest=` | athlete detail document (`version2.items`: summary, Legs, splits table). Redis while live, `v2.rr_results` when done. |
| `POST /v2/tracking/{event}` `{tracks:[ids]}` | positions `{track, location %, speed, path, info, live_racetime, is_counting}`; live window only |
| `GET/POST /v2/cheers/…` | no-login cheer board |
| `POST /v2/push/register`, `/sync`, `GET /v2/push/inbox` | FCM registry and topic sync (see push-notifications.md) |
| `POST /v2/analytics` | batched app usage events |
| `POST /v2/app_install` | install counting |
| `GET /v2/rrpublish/{rrId}/…` | pass-through proxy to my.raceresult.com RRPublish for results-only events |

### CMS / worker (server key)
| Method / path | Purpose |
|---|---|
| `POST /v2/push/send`, `/run`, `DELETE /v2/push/{id}`, `GET /v2/push/followers` | CMS composed pushes, scheduled runner |
| `GET /v2/analytics/summary?app_id=&event_id=&days=` | usage rollups for the CMS overview |
| `GET /v2/ops/health` | live races, alerts, worker heartbeats, queue depths (Health page) |

### RaceResult provisioning (org RR key or `evt_` token)
| Method / path | Purpose |
|---|---|
| `POST /v2/raceresult/provision/{race_id}[?dry=1]` | write/verify the results list in the RR file |
| `GET /v2/raceresult/provision/{race_id}/status` | `{changed, stored, current}` splits-hash drift |
| `POST /v2/raceresult/pull/{race_id}` | one per-contest pull into Redis now |
| `GET /v2/raceresult/log/{race_id}?limit=` | race activity log (≤5000) |

### Public ingest
| Method / path | Purpose |
|---|---|
| `POST /v2/tracks/raceresult/{rr_eventid}` | exporter crossings → `ingest_queue` (202). Any content type; empty JSON values repaired. |
| `POST /v2/rr_webhook/{race_id}` | participant webhook → `ingest_queue` (202) |

### Timer self-service (`evt_` tokens)
`/v2/timer/events` — timers create/link their own events (POST /v2/timer/events).

## `/v1` (legacy, Flutter)
`/v1/config/{race}`, `/v1/athletes/{race}`, `/v1/splits/race/{race}`, `/v1/tracking`,
`/v1/tracks/*` (Ugo/Evento pushes → `worker_queue` → `evento-track-worker`),
`/v1/raceresult/pull/{race}` (Simple API whole-feed pull), `/v1/push/*`,
`/v1/analytics/*`, `/v1/rrpublish/*`. Several are aliased under `/v2` with the
same handlers (push, analytics, app_install, rrpublish).

## Response shapes worth knowing
- **Tracking track**: `{ "track":"40", "location":71.1, "speed":9.5, "path":"p_2", "info":"Last Timing Split, 15K @ 22:34 ", "marker_text":"", "live_racetime":"1:34:35", "is_counting":false }`. `path` = `p_{contest}` (legacy); app matches courses by contest id.
- **Config path**: `{ "geojson": "https://evento-events.syd1.cdn.digitaloceanspaces.com/events/{event}/courses/{course_id}.geojson", "name":"p_2", "contest":"2", "contest_name":"Half Marathon", "course_id":6, "is_tracking":false, "updated":1787182529 }`. Contests sharing a course repeat the URL; dedupe by `course_id`.
- **Splits document**: `{ "version2": { "items": [ {type:"summary",…}, {type:"title",data:{label:"Legs"}}, {type:"splits",splits:[{style:"header",data:["Leg","Time","Speed/Pace"]},{data:["First 5K","29:43","5:56"]}]}, {type:"title",…}, {type:"tabbedtable",…} ] } }`.

## Env (API droplet `/root/node-api/.env`)
`PORT, NODE_ENV, JWT_SECRET, PG_*, REDIS_*, RR_ENCRYPTION_KEY, RR_ALLOW_WRITES=1,
DO_SPACES_KEY/SECRET, OPENAI_API_KEY, OPENROUTER_*`, optional `READS_PER_MINUTE`,
`INGEST_PER_MINUTE`, `INSTALL_TOKEN_TTL_S`, `READS_REQUIRE_INSTALL_TOKEN` (env
fallback; Redis `config:reads_require_install_token` wins). Local dev:
`RR_TEST_APIKEY` (test event only, never commit).

## Migrations
`database/migrations/*.sql`, applied by hand with psql (no runner): 006
rr_provisioning, 007 rr_split_token, 008 v2_rr_results, 009 drop v2.results,
010 api_keys.kind.
