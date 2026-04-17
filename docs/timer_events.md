# Timer Events

Create, update, and delete Evento events from RaceResult event IDs. This API is designed for timing companies to programmatically manage events in the Evento platform.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/timer/events` | Create a new Evento event from a RaceResult event ID |
| PATCH | `/v1/timer/events/:rr_event_id` | Update fields on an existing event |
| DELETE | `/v1/timer/events/:rr_event_id` | Delete an event |

## Authentication

All requests require a **Timer API Bearer token** in the `Authorization` header. These tokens start with `evt_` and are issued by Evento admin.

```
Authorization: Bearer evt_...
```

Token format is validated and must begin with `evt_`.

## POST /v1/timer/events

Create a new Evento event from a RaceResult event ID. Fetches event details, logo, and optionally triggers athlete loading.

### Request Body

```json
{
  "rr_event_id": "123456",
  "mode": "rr_results",
  "theme_dark": "99004E",
  "theme_light": "0784FF",
  "background_image": "https://...",
  "startlist": true,
  "live": true,
  "registration_url": "https://...",
  "registration_text": "Register Now",
  "results_link": "https://..."
}
```

### Request Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `rr_event_id` | string/number | **yes** | RaceResult event ID (numeric) |
| `mode` | string | no | Event mode: `rr_results` (default), `results`, `tracking`, `notifications` |
| `theme_dark` | string | no | 6-digit hex color without `#` (default: `99004E`) |
| `theme_light` | string | no | 6-digit hex color without `#` (default: `0784FF`) |
| `background_image` | string | no | URL for header/hero image (rr_results mode) |
| `startlist` | boolean/null | no | Force startlist on/off (omit for auto from RaceResult) |
| `live` | boolean/null | no | Force live results on/off (omit for auto) |
| `registration_url` | string | no | URL for registration button |
| `registration_text` | string | no | Button label (defaults to "Register" in app) |
| `results_link` | string | no* | **Required when `mode=results`** |

#### Mode Options

- **`rr_results`** (default) — RaceResult live results event
- **`results`** — External results link (requires `results_link`)
- **`tracking`** — Live tracking event (triggers athlete loading)
- **`notifications`** — Notifications-only event (triggers athlete loading)

### Response (200 OK)

```json
{
  "status": "success",
  "data": {
    "race_id": 123,
    "event_name": "Auckland Marathon",
    "event_date": "2026-10-25",
    "display_date": "25 Oct 2026",
    "location": "Auckland, New Zealand",
    "timezone": "Pacific/Auckland",
    "mode": "rr_results",
    "rr_event_id": "123456",
    "theme_dark": "99004E",
    "theme_light": "0784FF",
    "athlete_loading": "triggered"
  }
}
```

### Error Responses

| Status | Description |
|--------|-------------|
| 401 | Missing, invalid, or inactive token |
| 403 | No RaceResult API key configured for organisation |
| 409 | Event with this `rr_event_id` already exists |
| 422 | Validation error (missing/invalid fields) |
| 502 | RaceResult API error (auth failed, event not found, etc.) |

#### Example 409 Conflict

```json
{
  "status": "error",
  "code": 409,
  "message": "An event with rr_event_id 123456 already exists for this organisation.",
  "existing_race_id": 99
}
```

## PATCH /v1/timer/events/:rr_event_id

Update fields on an existing event. Only fields present in the request body are changed — omitted fields are left as-is.

### Request Body

Any subset of:

```json
{
  "theme_dark": "CC3300",
  "theme_light": "0066FF",
  "background_image": "https://...",
  "registration_url": "https://...",
  "registration_text": "Sign Up",
  "results_link": "https://...",
  "status": "open",
  "startlist": false,
  "live": null
}
```

### Updatable Fields

| Field | Type | Description |
|-------|------|-------------|
| `theme_dark` | string | 6-digit hex color without `#` |
| `theme_light` | string | 6-digit hex color without `#` |
| `background_image` | string | URL or empty string to clear |
| `registration_url` | string | URL or empty string to clear |
| `registration_text` | string | Button label or empty to clear |
| `results_link` | string | External results URL |
| `status` | string | `open` or `hidden` |
| `startlist` | boolean/null | `true`/`false` to force, `null` for auto |
| `live` | boolean/null | `true`/`false` to force, `null` for auto |

### Response (200 OK)

```json
{
  "status": "success",
  "data": {
    "race_id": 123,
    "rr_event_id": "123456",
    "fields_updated": 3
  }
}
```

### Error Responses

| Status | Description |
|--------|-------------|
| 401 | Missing, invalid, or inactive token |
| 404 | Event not found for this organisation |
| 422 | Validation error or no fields provided |

## DELETE /v1/timer/events/:rr_event_id

Delete an event and its app associations.

### Response (200 OK)

```json
{
  "status": "success",
  "data": {
    "race_id": 123,
    "rr_event_id": "123456",
    "deleted": true
  }
}
```

### Error Responses

| Status | Description |
|--------|-------------|
| 401 | Missing, invalid, or inactive token |
| 404 | Event not found for this organisation |
| 422 | Invalid `rr_event_id` format |

## Notes

- **Logo fetching**: Automatically downloads the event logo from RaceResult and uploads to DigitalOcean Spaces. Falls back to blank thumbnail on failure.
- **Athlete loading**: For `tracking` and `notifications` modes, triggers CMS athlete loading automatically. Status is returned in `athlete_loading` field (`triggered`, `trigger_failed`, or `not_required`).
- **Organisation scope**: Tokens are scoped to an organisation. Events can only be created/modified/deleted for the token's organisation.
- **App assignment**: Events are automatically assigned to the app associated with the token.
- **Results table mapping**: Automatically selects the correct results table based on organisation ID (legacy mapping from ColdFusion system).

## Environment Variables

The following environment variables must be set:

```bash
# DigitalOcean Spaces (S3-compatible)
DO_SPACES_KEY=<access_key_id>
DO_SPACES_SECRET=<secret_access_key>

# RaceResult API key encryption (must match ColdFusion value)
RR_ENCRYPTION_KEY=evento_rr_2024
```
