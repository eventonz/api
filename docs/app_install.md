# App Install

Track app installs for analytics and version monitoring.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/app_install` | Record an app install |

## Authentication

Requires Bearer token in Authorization header.

## POST /v1/app_install

Record a new app installation. Called by the mobile app on first launch.

### Request Body

```json
{
  "app_id": 1,
  "platform": "ios",
  "install_version": "1.2.3",
  "device_id": "ABC123-DEF456-GHI789",
  "installed_at": "2026-04-08T10:30:00Z"
}
```

### Request Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `app_id` | integer | **yes** | Evento app ID |
| `platform` | string | **yes** | Platform: `ios` or `android` |
| `install_version` | string | **yes** | App version at install (e.g. `1.2.3`) |
| `device_id` | string | **yes** | Unique device identifier |
| `installed_at` | string | **yes** | ISO 8601 timestamp of install |

### Response (201 Created)

```json
{
  "response": "success"
}
```

### Error Responses

| Status | Description |
|--------|-------------|
| 401 | Missing or invalid Bearer token |
| 400 | Invalid request body or missing required fields |

## Notes

- Records are inserted without duplicate checking — same device can have multiple install records if app is reinstalled
- Used for:
  - Install analytics and platform distribution
  - Version adoption tracking
  - Device count estimation
- `installed_at` should be the device's local time at install, converted to ISO 8601 format
