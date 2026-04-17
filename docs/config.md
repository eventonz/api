# Config

Returns the full event configuration for the mobile app, including menu structure, theme, tracking paths, contests, and app settings.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/config/:race_id` | Full event configuration |
| GET | `/v1/config/:race_id/check` | Fast config change polling |

## Authentication

Requires Bearer token in Authorization header.

## GET /v1/config/:race_id

Returns complete event configuration. Supports conditional caching via optional `hash` query parameter.

### Parameters

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| `race_id` | path | integer | yes | Event ID |
| `hash` | query | string | no | Client's current config hash (for 304 response) |

### Response (200 OK)

Returns full config JSON with SHA-256 hash in `_hash` field.

```json
{
  "_hash": "a3f8c9e...",
  "athletes": {
    "url": "https://eventotracker.com/api/v4/api.cfm/athletes/123",
    "follow": "https://eventotracker.com/api/v4/api.cfm/follow",
    "show_athletes": true,
    "last_updated": 1712345678,
    "text": "Athletes",
    "avatar": "mixed",
    "label": "Participants",
    "edition": "2026",
    "progress_rings": true
  },
  "athlete_details": {
    "version": 2,
    "url": "https://eventotracker.com/api/v4/api.cfm/splits/race/123/?bib=#{number}&id=#{id}&contest=#{contest}",
    "contest_display": {
      "1": {
        "type": "tabbed_table",
        "wide": false,
        "show_pace": true,
        "show_ranks": true,
        "show_elevation": false,
        "elevation_type": "altitude",
        "linked_map": null
      }
    }
  },
  "home": {
    "image": "https://...",
    "shortcuts": {
      "small": [
        {
          "icon": "mappin",
          "title": "Course Map",
          "subtitle": "View the route",
          "action": "openPage",
          "pageid": 456
        }
      ],
      "large": [
        {
          "image": "https://...",
          "action": "openURL",
          "url": "https://..."
        }
      ]
    }
  },
  "theme": {
    "accent": {
      "dark": "#99004E",
      "light": "#0784FF"
    }
  },
  "menu": {
    "created": "12/20/2024",
    "items": [
      {
        "id": 1,
        "title": "Results",
        "icon": "chart.bar",
        "type": "results",
        "supplier": "sportsplits",
        "sportsplits_raceid": 789,
        "opens_athlete_detail": true
      }
    ]
  },
  "adverts": [
    {
      "id": "uuid-123",
      "type": "Banner",
      "frequency": 5,
      "image": "https://...",
      "open_url": "https://..."
    }
  ],
  "miniplayer": [
    {
      "id": "uuid-456",
      "is_live_stream": true,
      "yt_url": "https://youtube.com/...",
      "title": "Live Stream"
    }
  ],
  "results": {
    "show_results": true,
    "config": {
      "icon": "chart.bar",
      "id": 1,
      "type": "results",
      "supplier": "sportsplits",
      "sportsplits_raceid": 789,
      "title": "Results",
      "opens_athlete_detail": true
    }
  },
  "tracking": {
    "update_freq": 10,
    "data": "https://eventotracker.com/api/v4/api.cfm/tracking",
    "map_style": "road",
    "paths": [
      {
        "geojson": "https://...",
        "name": "p_1",
        "contest": 1,
        "contest_name": "Marathon",
        "updated": 1712345678,
        "elevation_y_scale": 2.5
      }
    ]
  },
  "contests": [
    {
      "id": 1,
      "name": "Marathon",
      "distance": 42195,
      "color": "#0784FF"
    }
  ],
  "settings": {
    "notifications": [
      { "text": "Event Updates", "id": "event", "checkbox": false }
    ]
  },
  "app_version": {
    "ios_version": "1.2.3",
    "android_version": "1.2.3",
    "ios_store_url": "https://apps.apple.com/...",
    "android_store_url": "https://play.google.com/..."
  }
}
```

### Response (304 Not Modified)

When `hash` query parameter matches current config hash. No body returned.

### Menu Item Types

| Type | Description | Fields |
|------|-------------|--------|
| `link` | External web/PDF link | `open_external`, `link_type`, `link.url` |
| `assistant` | AI assistant (v1) | `sourceId`, `prefixprompt` |
| `assistantv2` | AI assistant (v2) | `assistant_id`, `assistant_base_url` |
| `results` | Results page | `supplier`, `sportsplits_raceid`, `opens_athlete_detail` |
| `eventomap` | Interactive map | `sourceId` |
| `carousel` | Image carousel | `carousel.url` |
| `pages` | List of sub-pages | `pages.url` |
| `schedule` | Event schedule | `schedule.url` |
| `storyslider` | Story/news slider | `storyslider.url` |
| `leaderboard` | Series leaderboard | `ss_raceid`, `open_on`, `list_events` |
| `feed` | Activity feed | `feed.url` |
| `divider` | Menu separator | (no id/icon) |

## GET /v1/config/:race_id/check

Fast polling endpoint for checking if config has changed. Checks hash key first (no JSON parsing). If hash matches, returns 304. If changed, returns full config in single response.

### Parameters

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| `race_id` | path | integer | yes | Event ID |
| `hash` | query | string | **yes** | Client's current config hash |

### Response (304 Not Modified)

Config unchanged. No body.

### Response (200 OK)

Config has changed. Returns full config JSON (same format as `/v1/config/:race_id`).

### Response (302 Redirect)

Cache cold. Redirects to `/v1/config/:race_id` to build config.

## Caching

- Full config cached in Redis for **60 seconds**
- Separate hash key cached for fast polling
- Client should poll `/check` endpoint every 30-60 seconds
- `_hash` field is SHA-256 of the config JSON (excluding the `_hash` field itself)

## Notes

- API version (v3/v4) determined from `apps.api_version` (defaults to 3)
- Contests and `athlete_details.contest_display` only included for API v4+
- Adverts are randomized per type (Banner then Splash)
- Tracking paths only included if event has configured maps
- `athlete_details.url` uses template variables: `#{number}`, `#{id}`, `#{contest}`
