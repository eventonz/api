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
| **App › App defaults** (sidebar item, `/apps/{id}/defaults`) | per-app header image, header style (backdrop/hero) and colour applied when RaceResult has no cover/brand colour — cascade RR → app defaults → Evento green; "Apply now" fills gaps on existing events (migration 038 `v2.apps.event_defaults`) | `lib/app-defaults.ts` |
| **Settings** | name/status/tz/date/venue/accent, images, **RaceResult** link per race + "In the RaceResult event file" card (list + exporter status/create/re-write, splits drift), NorthSouth photos, **Danger zone** delete (races, athletes, contests, splits, results, follows, cheers, pages, maps, schedule, app-list entry; RR file untouched) | `lib/rr-live.ts`, `lib/rr-exporter.ts`, `lib/event-delete.ts` |
| **Resources → Health** (`/admin/health`, superadmin) | live races + hours, worker alerts (30 d), heartbeats, queues, 60 s refresh | `GET /v2/ops/health` |

## Publishing (`lib/publish.ts`)
**Publish event**: `events/{event}/event.json`, `pages/*.json`,
`data/schedule.json`, data files, `courses/{id}.geojson` (immutable, versioned
per file via `v2.file_versions`) then `manifest.json` (no-cache) last.
**Publish app**: `apps/{appId}/index.json` (no-cache): mode, events list, brand,
accent. Spaces creds `SPACES_KEY/SECRET` (local: aws profile `evento-spaces`).
CDN TTL 60 s = app poll interval. File versions are never below the current
Unix time (the 3 Oct import wrote timestamp versions; apps only refetch when a
version goes up). Short `date` props from the picker ("2026-11-01T10:00") are
completed to full ISO with the event's timezone offset on publish and in the
preview route (`lib/date-normalise.ts`) — iOS only parses full ISO-8601.
Published app indexes leave out events marked Hidden (`published: false`).

## How-to: results + live tracking for a RaceResult event (organiser checklist)
1. **Link RaceResult** — Event → Settings → RaceResult: pick the RR event
   (`v2.races.rr_raceid`). Then Athletes → **Load athletes** (startlist).
2. **Maps** — upload a GPX per distance (Maps); turn **tracking** on per map.
3. **Contests** — **Load contests** from RR, then per contest: course in **Map &
   tracking**, predictive tracking on, ≤5 **Summary** splits (the checkpoint
   strip on followed rows; each split's **Short** name is its strip label), and
   **Finisher extras**: certificate / photo URL templates (`{{RaceNo}}`,
   `{{AthleteID}}`, `{{Contest}}`), medal image, finish-line camera (YouTube
   id + timing point + camera start time, race-local) — migration 044.
4. **Athletes page** — nothing to create: every event gets the system page
   **Athletes** (slug `athletes`, an `athlete_hub` card: Following | All
   athletes, search, Follow buttons). Customise it in Pages if you want
   sponsors etc. around the hub. Don't confuse it with **Athlete** (slug
   `athlete`) — that is the *detail template* one athlete opens into, never a tab.
5. **Results page** — Pages → Add a page → **"my.raceresult.com results"**
   (`pageType rr_results`, carries the race's RR event id). Shows nothing until
   the RR event is **published on my.raceresult.com**. Results-only events use
   the Overview toggle instead (Home *is* the results page).
6. **Tracking page** — Pages → Add a page → **Tracking card**, variant `full`
   (the page is the live map; `lib/tracking-page.ts ensureTrackingPage` is the
   same recipe, auto-seeded for events created from RaceResult). Needs step 2
   (map with tracking on) and step 3 (course on the contest).
7. **Navigation (bottom bar)** — Event → **Navigation**. Home is always the
   first tab; add up to **4** more. Click **+ Add tab**, then per tab set
   **Label**, **Opens** (the page) and **Icon**. The usual RR timer bar:

   | Label | Opens | Icon |
   |---|---|---|
   | Athletes | Athletes (`athletes`) | Athletes |
   | Results | the my.raceresult.com results page | Results / flag |
   | Tracking | the tracking page | Tracking / location |

   Use ↑ ↓ to order, ✕ to remove, then **Save navigation**. **+ Add web link
   tab** makes a tab that opens a web page instead.
   An empty bar (no tabs) means the app shows no bottom bar at all.
8. **Publish event** (nav, pages and maps only reach phones on publish — apps
   pick it up within ~1 min), then on race day **Go live** (Overview → Live
   timing).

**Check on a phone:** Athletes tab lists the startlist and Follow works;
Results shows lists once RR publishes; Tracking shows the course map (dots
appear once athletes cross timing points). Blank Athletes tab = the tab points
at `athlete` instead of `athletes`; "Tracking isn't set up yet" = see the
bridge gotcha below.

**Gotcha — the old-system bridge.** `/v2/config`, `/v2/athletes`, `/v2/splits`
read through `v2.races.v1_race_id` (else a `public.races` row with the same
`rr_raceid`) when one exists (`services/v2bridge.js`). Events copied from the
old CMS keep that link, so an event set up in the new CMS (contests, courses,
`v2.athletes`) still serves the OLD race's empty config: the tracking page says
"Tracking isn't set up yet" and athlete search is empty. If the old race has no
athletes/contests, clear `v2.races.v1_race_id` so the event goes V2-native.
(Oct 2026: run-canberra-2026, embrunman.)

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
