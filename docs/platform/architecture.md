# Architecture

## The map

```
 RaceResult (timer)                    Organiser / Evento staff             Athletes & fans
 events.raceresult.com                 browser                              iPhone (MOBILE-V2)
   │  Org API (per-org key)               │                                    │
   │  ▲ list render (pull)                 ▼                                    │ install token
   │  │ exporter HTTP push          ┌─────────────────┐   server key            │
   │  │ participant webhook         │  Next.js CMS     │────────────────┐       │
   │  │                             │  cms.evento.co.nz│                │       │
   │  │                             └────────┬─────────┘                ▼       ▼
   │  │                                      │ SQL              ┌────────────────────────┐
   │  │                                      ▼                  │ eventoapi.com (node-api)│
   │  │                             ┌─────────────────┐  SQL    │ Fastify, PM2 ×2 + track │
   │  └─────────────────────────────│  Postgres        │◀───────│ workers, 134.199.152.100│
   │        pulls                   │  pgevento (v2.*) │        └───────┬──────┬─────────┘
   │                                └─────────────────┘  SQL            │      │ LPUSH ingest_queue
   │                                         ▲                          │      ▼
   │                                         │            ┌─────────────┴───────────────┐
   └── pushes ──▶ /v2/tracks ──▶ Redis ◀─────┼────────────│ evento-worker 209.38.84.127  │
                  (Valkey, syd1)             └────────────│ ingest ×2 · notify · schedule │
                        ▲                                 │ · dashboard :3000             │
                        │ redis_splits / race:log / queues└───────────────────────────────┘
 DigitalOcean Spaces (CDN) ◀── CMS publish ── event.json, pages, courses, manifest ──▶ app polls 60 s
 Firebase Cloud Messaging ◀── worker (athlete pushes) / API (CMS sends) ──▶ devices by topic
```

## Components

| Component | Repo | Runs on | Purpose |
|---|---|---|---|
| **Next.js CMS** | `eventonz/evento-cms-next` (`NEXTJS-CMS/`) | Vercel-style Node host; local `npm run dev -p 3100` | Organisers build events (pages/blocks, maps, contests, schedule), link RaceResult, go live, send pushes. Publishes static content to Spaces. Talks to Postgres directly and to the API with a **server key**. |
| **eventoapi.com** | `eventonz/api` (`node-api/`) | Droplet 134.199.152.100, PM2 `evento-api` ×2 + `evento-track-worker` + `evento-analytics-worker`; GitHub Actions deploy on push to `main` | The app's only backend. `/v2` for the new app + CMS, `/v1` legacy for the Flutter app. Also RaceResult provisioning, ingest endpoints, install tokens. |
| **evento-worker** | `eventonz/evento-worker` (`evento-worker/`) | Droplet 209.38.84.127 (s-1vcpu-2gb), PM2 `ingest-worker` ×2, `notify-worker`, `schedule-worker`, `worker-dashboard`; deployed by `rsync` + `pm2 startOrReload` | Drains `ingest_queue` (RaceResult pushes, participant webhooks) and `notify_queue` (athlete pushes); scheduler pulls feeds while live, finalises, runs health checks. |
| **Mobile app** | `eventonz/evento-mobile-v2` (`MOBILE-V2/`) | iOS (SwiftUI, iOS 17+); Android later | Block-rendered event app; one codebase, per-app builds (`configs/*.json`). Content from the CDN, live data from `/v2`. |
| **Flutter app (legacy)** | `eventonz/evento_flutter_core_shell` (`MOBILE/`) | stores | Still on `/v1`; untouched by v2 work. |
| **Old CMS + CF API** | `CMS/`, `API/` | eventotracker.com / evento.co.nz (Lucee) | Being retired. RaceResult exporters written by the old CMS still point at `eventotracker.com/api/v4/api.cfm/raceresult/…`; re-writing them from the new CMS moves them to `/v2/tracks`. |

## Data stores

| Store | Where | Holds |
|---|---|---|
| **Postgres `pgevento`** | DO managed, syd1 | `public.*` = v1 (frozen, read-only for the CMS). `v2.*` = everything new (see data-model.md). The CMS pool sets `search_path=v2,public`. |
| **Valkey (Redis)** | DO managed, syd1 | Live splits cache, queues, per-race activity logs, alerts, tokens, rate-limit counters, worker heartbeats (see data-model.md). |
| **DO Spaces `evento-events`** | syd1 + CDN `evento-events.syd1.cdn.digitaloceanspaces.com` | Published app content: `apps/{appId}/index.json`, `events/{event}/event.json`, `pages/*.json`, `courses/{id}.geojson`, `data/*.json`, `manifest.json`. |
| **Firebase** | project per app (`configs/firebase/<app>/`, kept local) | FCM topics + device tokens; APNs key per app. |

## Who talks to whom

- **CMS → Postgres** directly for everything it owns (events, pages, races, contests, splits, legs, courses, notifications metadata).
- **CMS → RaceResult** directly with the organisation's RaceResult API key (webhooks, exporter, contests/splits loading, event list) — see live-timing-pipeline.md.
- **CMS → API** for things that live in the API's world: provisioning the results list (`/v2/raceresult/provision`, authenticated with the **org's RaceResult key**), analytics summaries, push sends, ops health (authenticated with the CMS **server key**).
- **API → RaceResult** with the org's key for list provisioning and the on-demand pull.
- **Worker → RaceResult** with the org's key for scheduled per-contest pulls; **worker → API** (`/v2/raceresult/provision/:id/status` and `/provision`, `/v2/push/run`) with the org key / a server key.
- **App → CDN** for content; **app → API** for live data with an install token (`/v2/auth/register` bootstraps it with the baked app key); **app → FCM** via Firebase SDK.
- **RaceResult → API** unauthenticated (gated by IDs in the URL): exporter pushes to `/v2/tracks/raceresult/{rr_eventid}`, participant webhooks to `/v2/rr_webhook/{race_id}`.

## Deploys

| Component | How |
|---|---|
| API | `git push origin main` → GitHub Actions → SSH to droplet → `pm2 startOrReload`. **Deploys live immediately** — check the diff, confirm with Todd before pushing. |
| Worker | `rsync -az --delete --exclude node_modules --exclude .env --exclude .git evento-worker/ root@209.38.84.127:/root/evento-worker/` then `pm2 startOrReload ecosystem.config.js --update-env && pm2 save`. `setup-droplet.sh` builds a droplet from scratch. |
| CMS | Standard Next.js deploy of `main`. Needs `DATABASE_URL`, `AUTH_SECRET`, `EVENTOAPI_ANALYTICS_KEY`, `SPACES_KEY/SECRET`, optional `RESEND_API_KEY`, `EVENTOAPI_URL` **must not** point at 127.0.0.1 in prod. |
| Mobile | `MOBILE-V2/ios/build.sh <config> [run|device]`; store builds via the `mobile-build-deploy` skill. Content changes need no build: `./publish.sh` / CMS Publish. |
| Published content | CMS **Publish event** / **Publish app**: writes immutable versioned JSON to Spaces then `manifest.json` / `index.json` (no-cache) last; the app sees it within 60 s. |
