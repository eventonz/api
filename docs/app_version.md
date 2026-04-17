# App Version

Manage app version information for force-update checks.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/app_version/:app_id` | Get current app versions and store URLs |
| POST | `/v1/app_version/:app_id` | Update app versions |

## Authentication

Requires Bearer token in Authorization header.

## GET /v1/app_version/:app_id

Get the current iOS and Android version strings and store URLs for an app.

### Parameters

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| `app_id` | path | integer | yes | Evento app ID |

### Response (200 OK)

```json
{
  "ios_version": "1.2.3",
  "android_version": "1.2.4",
  "ios_store_url": "https://apps.apple.com/app/id123456789",
  "android_store_url": "https://play.google.com/store/apps/details?id=com.evento.app"
}
```

### Response (404 Not Found)

App not found.

## POST /v1/app_version/:app_id

Update app version strings and optionally store URLs. Only provided fields are updated.

### Parameters

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| `app_id` | path | integer | yes | Evento app ID |

### Request Body

```json
{
  "version": "1.3.0",
  "android_version": "1.3.1",
  "ios_store_url": "https://apps.apple.com/app/id123456789",
  "android_store_url": "https://play.google.com/store/apps/details?id=com.evento.app"
}
```

### Request Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | string | **yes** | iOS app version (e.g. `1.2.3`) |
| `android_version` | string | **yes** | Android app version (e.g. `1.2.3`) |
| `ios_store_url` | string | no | iOS App Store URL (only updated if provided) |
| `android_store_url` | string | no | Android Play Store URL (only updated if provided) |

### Response (200 OK)

```json
{
  "success": true,
  "message": "App version updated successfully"
}
```

## Notes

- Version strings use semantic versioning format: `MAJOR.MINOR.PATCH`
- Mobile apps compare their current version against these values to trigger force-update prompts
- Store URLs are optional and only updated when explicitly provided in POST request
- Version information is also included in the `/v1/config/:race_id` response for convenience
