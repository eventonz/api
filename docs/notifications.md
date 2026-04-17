# Notifications

Returns sent notifications for a given race from the last 14 days.

## Endpoint

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/notifications/:race_id` | Notifications for a race |

## Authentication

All requests require a Bearer token in the `Authorization` header.

```
Authorization: Bearer <token>
```

## Parameters

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| `race_id` | path | integer | yes | The race ID |

## Response

```json
{
  "race_id": 60,
  "notifications": [
    {
      "id": 2667,
      "title": "ELITE MEN close to the finish 🔥",
      "content": "Watch live now!",
      "urlopen": "https://www.youtube.com/watch?v=CbxLWnqEWjk"
    }
  ]
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `race_id` | integer | The race ID from the request |
| `notifications` | array | List of notifications, ordered by send time ascending |
| `notifications[].id` | integer | Notification ID |
| `notifications[].title` | string | Notification title |
| `notifications[].content` | string | Notification body text |
| `notifications[].urlopen` | string \| null | URL to open when tapped, or `null` |

## Filtering

Only returns notifications where:
- `status = 'Sent'`
- `sendafter` is within the last **14 days**
- `sendafter` is not in the future

## Caching

Responses are cached in Redis for **60 seconds** per `race_id`.

## Errors

| Status | Description |
|--------|-------------|
| 401 | Missing or invalid Bearer token |
