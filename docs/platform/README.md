# Evento platform — developer documentation

How the pieces fit: the **Next.js CMS**, **eventoapi.com** (the Node API), the
**evento-worker** droplet, the **mobile app** (MOBILE-V2, native iOS today), and
**RaceResult** on the timing side. Written September 2026 as the live-timing
pipeline was completed end to end.

| Doc | Read it to understand |
|---|---|
| [architecture.md](architecture.md) | The map: components, hosts, repos, data stores, how a change gets deployed |
| [live-timing-pipeline.md](live-timing-pipeline.md) | RaceResult → list + exporter → pulls and pushes → Redis → results table → app. States, Redis keys, gotchas |
| [eventoapi.md](eventoapi.md) | Every `/v2` endpoint, the three kinds of credential, install tokens, rate limits, response shapes |
| [push-notifications.md](push-notifications.md) | FCM topics and language suffixes, follows, athlete crossing pushes, scheduled CMS pushes, inbox |
| [cms.md](cms.md) | What each CMS screen does and which table/endpoint it touches; publishing to the CDN |
| [mobile-app.md](mobile-app.md) | How the app boots, syncs content, identifies itself, fetches live data, and what it still owes (install tokens, legs card, …) |
| [data-model.md](data-model.md) | v2 schema tables, Redis key catalogue, `api_keys.kind`, `races.live_state` |
| [operations.md](operations.md) | Droplets, PM2, deploys, env vars per component, Health page and alerts, runbooks, local dev |

**Conventions used here.** `{event_id}` is the CMS slug (`evento-pipeline-test`);
`{race_id}` is `v2.races.id` (649); `{rr_eventid}` is RaceResult's event number
(421131); `{athlete_id}` is RaceResult's participant ID, never the bib.
Times shown in docs are UTC unless stated.
