# Mobile app (MOBILE-V2, repo `eventonz/evento-mobile-v2`)

Native SwiftUI (iOS 17+), Kotlin/Compose later. **One codebase → many apps**:
a build bakes only identity from `configs/<app>.json` — `appId, eventId (seed),
bundleId, appName, icon, baseURL (CDN root), googleMapsKey, eventoApiToken (app
API key)`. Everything else comes from the CDN at runtime.

## Boot and content (`ios/Evento/Content/ContentStore.swift`)
1. Read `{baseURL}/apps/{appId}/index.json`: `mode` (`single` boots into the
   first event, `multi` shows the block-composed event list), `events[]`,
   brand, accent, store URLs (update gate). Single-mode apps follow their
   index's first event → edition rollover is a publish, not a rebuild.
2. Per event: `{baseURL}/events/{event}/manifest.json` (ETag'd, polled every
   60 s and on foreground) → download changed files (`event.json`, `pages/*`,
   `data/*`, `courses/*`) into the cache. **Offline-first**: UI reads disk only;
   bundled seed under `configs/seed/<event>/`.
3. Pages render blocks from the shared contract (`blocks.schema.json`, v24;
   `BLOCKS.md` is the reference; `scripts/check_blocks.py` keeps schema,
   renderer and docs aligned). Fixed system pages: `home`, `athletes`, `athlete`.
   Results-link-only events (`event_json.linkOnly` / index `link`) open a URL.

## Identity and API access (`Content/LiveAthlete.swift EventoAPI`)
Base `https://eventoapi.com`; v2 events use `/v2/config/{event}`,
`/v2/athletes/{event}`, `/v2/splits/{event}`, `/v2/tracking/{event}`,
`/v2/rrpublish`, `/v2/push`, `/v2/analytics`, `/v2/app_install`.
**Today** every call sends the baked `eventoApiToken`. **Required change**
(`API-AUTH-CHANGE.md`): register the install (`POST /v2/auth/register` with the
baked key + a Keychain UUID) and send the returned 24 h **install token** on
every read; refresh when <1 h left or on `401 TOKEN_EXPIRED/TOKEN_INVALID`.
Since 6 Sep 2026 the API rejects the baked key for reads (`INSTALL_TOKEN_REQUIRED`),
so current builds get no live data until this lands.

## Live data on screen
- **Athlete page** (`AthleteBlocks`, `athlete_*` cards): `/v2/splits` document →
  summary, **Legs** (title + rows), splits table. Legs card `athlete_legs` is
  designed in BLOCKS.md but not yet wired to the v2 items (MOBILE-TODO #2).
- **Tracking map** (`AthleteTracking.swift`): `/v2/config` → `tracking.paths`
  (one per contest with a course; match by **contest id**, draw courses with
  `is_tracking`), then `/v2/tracking` every `update_freq` s → dots at
  `location %` along the course polyline, dead-reckoned client-side too.
  Dedupe shared courses by `course_id` (TODO).
- **Results (RaceResult events)** — `RRResultsBlock` via the `/v2/rrpublish`
  proxy for results-only events; the 7 results blocks for the full pipeline are
  hidden pending wiring (MOBILE-TODO #3).
- **Cheers** — `/v2/cheers`, no login.

## Follows, push, analytics
Follows are per event/edition, stored locally and mirrored to FCM topics via
`/v2/push/sync` (see push-notifications.md). `PushManager` handles permission,
token, prefs, deep-link routing, Notification Service Extension for images.
Analytics: taps (not impressions) queued on device → `/v2/analytics` batches.
Install counted once via `/v2/app_install`.

## Build & run
`cd MOBILE-V2/ios && ./build.sh <config> [run|device]` (xcodegen; never hand-edit
`Support/Evento.entitlements`). Local content: `python3 -m http.server 8787` in
`cdn-demo/` with a `*-local.json` config. Firebase files per app live in
`configs/firebase/<app>/` — **local only, never committed**.

## Outstanding (see `MOBILE-TODO.md`, `API-AUTH-CHANGE.md`)
install tokens · legs card · unhide results/search blocks onto `/v2` · course
dedupe · tolerate both time formats · Android shell.
