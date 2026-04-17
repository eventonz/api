# Events

Returns the event list for a given app, including header branding, promo cards, and race items.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/events/:appid` | All events (open + closed) |
| GET | `/v1/events/:appid/upcoming` | Open events with date > 2 days ago |
| GET | `/v1/events/:appid/past` | Open events with date <= 2 days ago |

## Authentication

All requests require a Bearer token in the `Authorization` header.

```
Authorization: Bearer <token>
```

## Parameters

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| `appid` | path | integer | yes | The app ID |

## Response

```json
{
  "header": {
    "color": "#000000",
    "logo": "https://..."
  },
  "searchbar": false,
  "show_upcoming": true,
  "show_past": true,
  "promo_cards": [
    {
      "id": 13,
      "title": "SIGN UP",
      "link_url": "https://...",
      "type": "image",
      "image_url": "https://..."
    }
  ],
  "items": [...]
}
```

### `promo_cards` types

| `type` | Extra fields |
|--------|-------------|
| `"image"` | `image_url` |
| `"color"` | `background`, `text_color` |

### `items` types

Items are ordered: large events first, then normal events. Within each group, ordered by `event_date ASC` (or `DESC` for past).

#### `type: "event"` — standard event

```json
{
  "id": 60,
  "type": "event",
  "config": "https://eventotracker.com/api/v4/api.cfm/config/60",
  "size": "large",
  "title": "Absa Cape Epic",
  "subtitle": "Cape Town, South Africa\n15–22 March 2026",
  "small_image": "https://...",
  "large_image": "https://...",
  "open": true,
  "tag": {
    "color": "#E5AF0D",
    "text": "March 2026",
    "blinking": false
  }
}
```

#### `type: "rr_results"` — RaceResult live results event

```json
{
  "id": 60,
  "type": "rr_results",
  "config": "https://eventotracker.com/api/v4/api.cfm/config/60",
  "size": "large",
  "title": "Event Name",
  "subtitle": "Location\nDate",
  "small_image": "https://...",
  "background_image": "https://...",
  "open": true,
  "rr_id": "12345",
  "show_medals": false,
  "theme": "#1a2b3c",
  "startlist": true,
  "live": true,
  "registration_url": "https://...",
  "registration_text": "Register"
}
```

> `startlist` and `live` are omitted when null — the mobile app falls back to RaceResult's own flags.

#### `type: "link"` — external results link

```json
{
  "id": 0,
  "type": "link",
  "link": "https://...",
  "config": "https://eventotracker.com/api/v4/api.cfm/config/60",
  "size": "small",
  "title": "Event Name",
  "subtitle": "Location\nDate",
  "small_image": "https://...",
  "open": true,
  "theme": "#1a2b3c"
}
```

### Common item fields

| Field | Type | Always present | Description |
|-------|------|---------------|-------------|
| `type` | string | yes | `"event"`, `"rr_results"`, or `"link"` |
| `size` | string | yes | `"large"` or `"small"` |
| `title` | string | yes | Event name |
| `subtitle` | string | yes | Location + date, newline-separated |
| `small_image` | string | yes | Thumbnail URL |
| `open` | boolean | yes | `false` if status is `"closed"` |
| `large_image` | string | no | Hero image URL |
| `tag` | object | no | Badge overlay — only when `large_image` is set |
| `config` | string | yes | Config endpoint URL for this race |

## Caching

Responses are cached in Redis for **2 minutes**, keyed by `appid` + filter. Each of the three paths has its own independent cache entry.

## Errors

| Status | Description |
|--------|-------------|
| 401 | Missing or invalid Bearer token |
| 404 | App not found |
