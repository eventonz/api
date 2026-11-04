# Finisher Snap

A crew photographer app (iOS, unlisted on the App Store) for taking finish-line
photos and tagging them with a bib / team number. Photos land in DO Spaces and
show in the event app on the athlete and team pages via the `finisher_photos` block.

## Pieces

| Piece | Where |
|---|---|
| Photographer app | `MOBILE-V2/finisher-snap/` (own xcodegen project, bundle `nz.co.evento.finishersnap`) |
| API | node-api `src/routes/v2/snap.js` (`/v2/snap/*`, `/v2/finisher_photos/*`) |
| Table | `v2.finisher_photos` (NEXTJS-CMS migration `053_finisher_photos.sql`) |
| Event code | `v2.events.event_json.finisherSnap.code` — set in CMS event Settings |
| Event-app block | `finisher_photos` (blocks contract v42), athlete + team pages |
| Storage | Spaces bucket `evento-nz` (fra1), key `finisher-snap/{event_id}/{bib}/{uuid}.jpg` (+ `…_thumb.jpg`), public via `https://evento-nz.fra1.cdn.digitaloceanspaces.com/` |

## Flow

1. App lists events that have a Finisher Snap code (`GET /v2/snap/events`).
2. Photographer picks one and types the event code → `POST /v2/snap/login` → snap token (7 days).
3. Takes a photo (portrait or landscape — orientation comes from the image size).
4. Picks the bib: type digits, autocomplete from `GET /v2/snap/athletes?q=`.
5. App resizes (2048 px long edge + 600 px thumb, JPEG), asks `POST /v2/snap/uploads` for two
   presigned PUT URLs, uploads straight to Spaces, then commits with `POST /v2/snap/photos`.
6. Photo is visible at once in the event app (`GET /v2/finisher_photos/{event}/{bib}`).
   Organisers delete bad ones in the CMS (soft delete: `deleted_at`).

## Endpoints

All JSON. Errors are `{ error, code? }` with a 4xx status.

### Photographer (`/v2/snap`, no app key — snap token where noted)

| Method + path | Auth | Body / query | Reply |
|---|---|---|---|
| `GET /v2/snap/events` | none | — | `{ events: [{ id, name, date, venue, image, accent }] }` — only events with a code; newest date first |
| `POST /v2/snap/login` | none | `{ event_id, code }` | `{ token, expires_at, event: {…same shape…} }`; 401 `{code:'WRONG_CODE'}`; 429 after 10 tries / 10 min per IP+event |
| `GET /v2/snap/athletes` | snap | `?q=&limit=` (limit ≤ 50, default 20) | `{ athletes: [{ bib, name, info, athlete_id, race_id, race_name }] }` — empty `q` = bib order |
| `POST /v2/snap/uploads` | snap | `{ bib }` | `{ photo_key, upload: { url, headers }, thumb_upload: { url, headers }, expires_in }` — PUT the JPEG bytes with exactly those headers |
| `POST /v2/snap/photos` | snap | `{ photo_key, bib, width, height, athlete_id?, race_id?, device? }` | `{ photo }` (shape below); 400 if the key isn't this event's or the object isn't in Spaces |
| `GET /v2/snap/photos` | snap | `?bib=` optional | `{ photos: [photo] }` — this event's latest 100 |
| `DELETE /v2/snap/photos/:id` | snap | — | `{ ok: true }` |

Snap token: `Authorization: Bearer snp_<payload>.<sig>` (HMAC-SHA256 over JWT_SECRET), payload `{ e: event_id, exp }`.

### Event app (`/v2/finisher_photos`, normal app auth)

`GET /v2/finisher_photos/:event_id/:bib` → `{ photos: [photo] }`, newest first, cached 30 s
(cache cleared on commit/delete). Never 5xx for an unknown event/bib — returns `{ photos: [] }`.

### `photo`

```json
{ "id": 12, "bib": "246", "athlete_id": "246", "url": "https://…/x.jpg", "thumb_url": "https://…/x_thumb.jpg",
  "width": 1536, "height": 2048, "orientation": "portrait", "created_at": "2026-11-06T02:13:00Z" }
```

`orientation` is `portrait` | `landscape` | `square` (derived from width/height on the server).
