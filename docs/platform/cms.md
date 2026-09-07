# Next.js CMS (`NEXTJS-CMS/`, repo `eventonz/evento-cms-next`)

Next 15 app router, server components + server actions, Postgres via `lib/db.ts`
(`search_path=v2,public`), Auth.js sessions (`v2.users`, org roles in
`v2.organisation_users`, `isSuperadmin`). Local: `npm run dev -- -p 3100`.

## Hierarchy
**Organisation** (timer or organiser; holds the RaceResult API key) → **App**
(`v2.apps`: brand, accent, `mode single|multi`, `events[]` list entries with
`id, name, meta, image, published, link`) → **Event** (`v2.events.event_json`:
name, dateLabel, venue, date, timeZone, accent, hero, `linkOnly`, `hideNav`,
nav) → **Pages** (`v2.pages.page_json`, blocks) · **Races** (`v2.races`, one per
RaceResult event) → contests / splits / legs · **Courses** (`v2.courses`,
geojson) · **Schedule** · **Media** · **Notifications**.

## Screens and what they touch

| Screen | Does | Data / calls |
|---|---|---|
| **Apps → app page** | event list (every row opens; entries without a CMS record get one on first open), New event: manual, **from RaceResult ID** (pulls name/date/tz/logo, loads contests+splits+legs, writes list + exporter) or year picker | `v2.apps.events`, `createEventFromRR`, `setupRaceResultForEvent` |
| **Event → Overview** | stats, **Results link only** toggle (event becomes a card that opens a URL; sidebar collapses), **Live timing** card per RR race: state pill, Go live now (confirm), Schedule (go-live + optional auto-stop, event tz), Stop live (confirm), Pull now, Clear error, last log line + **Activity log →** | `v2.races.live_state/live_from/live_until`, `/v2/raceresult/pull`, `/v2/raceresult/log` |
| **Event → Activity log** (`/events/{id}/log`) | full per-race log, kind filters, race tabs, 30 s refresh, show more (≤5000) | `GET /v2/raceresult/log/{race}` |
| **Pages / Navigation / Media** | block builder (contract v24, 66 blocks, 11 hidden awaiting API wiring), nav, media library | `v2.pages`, `v2.media`, Spaces |
| **Maps** | upload GPX → course (distance, climb), tracking toggle, GPX download toggle | `v2.courses` (geojson jsonb) |
| **Contests** | one tab per contest: **Load contests** (update/replace) from RR — splits + legs, rename/visibility/discipline/default speed, summary splits, `send_push` per split; **Map & tracking** card: course dropdown (several contests may share one), predictive tracking on/off, await-at-split, elevation scale. Loading re-writes the results list if RR splits drifted | `v2.contests`, `v2.splits`, `v2.legs`; Org API; `/v2/raceresult/provision` |
| **Schedule** | days/items, org locations, .ics | `v2.schedule_days/items`, `v2.locations` |
| **Athletes** | Load athletes (RR Org API startlist), teams, RR participant **webhooks**, **Live timing** panel (same controls + exporter create/re-write) | `v2.athletes`; Org API `webhooks/*`, `exporters/*` |
| **Notifications** | compose/send/schedule pushes, AI copy, history | `/v2/push/*` (server key) |
| **Settings** | name/status/tz/date/venue/accent, images, **RaceResult** link per race + "In the RaceResult event file" card (list + exporter status/create/re-write, splits drift), NorthSouth photos, **Danger zone** delete (races, athletes, contests, splits, results, follows, cheers, pages, maps, schedule, app-list entry; RR file untouched) | `lib/rr-live.ts`, `lib/rr-exporter.ts`, `lib/event-delete.ts` |
| **Resources → Health** (`/admin/health`, superadmin) | live races + hours, worker alerts (30 d), heartbeats, queues, 60 s refresh | `GET /v2/ops/health` |

## Publishing (`lib/publish.ts`)
**Publish event**: `events/{event}/event.json`, `pages/*.json`,
`data/schedule.json`, data files, `courses/{id}.geojson` (immutable, versioned
per file via `v2.file_versions`) then `manifest.json` (no-cache) last.
**Publish app**: `apps/{appId}/index.json` (no-cache): mode, events list, brand,
accent. Spaces creds `SPACES_KEY/SECRET` (local: aws profile `evento-spaces`).
CDN TTL 60 s = app poll interval.

## RaceResult from the CMS (all with the org's RR key, `lib/raceresult.ts rrLogin`)
event list (`api/public/eventlist`), contests/splits (`contests/get`,
`splits/get`), startlist (`data/list`), webhooks (`webhooks/get|save|delete`),
exporter (`exporters/get|save`), logo (`pictures/thumbnail`). The results list
is the one thing done **via the API** (`/v2/raceresult/provision`, bearer = the
same org key) because the template generator lives there.

## Env
`DATABASE_URL, AUTH_SECRET, AUTH_TRUST_HOST, NEXT_PUBLIC_MAPBOX_TOKEN,
EVENTOAPI_ANALYTICS_KEY` (server key 9), `EVENTOAPI_URL` (local only:
`http://127.0.0.1:3000`; **remove in prod**), `SPACES_KEY/SECRET`,
`OPENROUTER_API_KEY/MODEL`, `RESEND_API_KEY`, `MAIL_FROM`.
