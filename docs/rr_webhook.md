# RaceResult Webhook

Receive participant updates from RaceResult webhooks. Upserts athlete data when participants are added or modified in RaceResult.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/rr_webhook/:race_id` | RaceResult participant_update webhook |

## Authentication

Requires Bearer token in Authorization header.

## POST /v1/rr_webhook/:race_id

Receives participant updates from RaceResult's `participant_update` webhook. Upserts athlete records in the Evento database.

### Parameters

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| `race_id` | path | integer | yes | Evento event (race) ID |

### Request Body

RaceResult sends updates in the following format:

```json
{
  "Values": {
    "ID": "12345",
    "BIB": "42",
    "FIRSTNAME": "John",
    "LASTNAME": "Smith",
    "CONTEST.ID": "1",
    "CONTEST.NAME": "Marathon"
  }
}
```

### Request Fields (Values object)

| Field | Type | Description |
|-------|------|-------------|
| `ID` | string | RaceResult athlete ID (unique) |
| `BIB` | string/number | Bib/race number |
| `FIRSTNAME` | string | Athlete first name |
| `LASTNAME` | string | Athlete last name |
| `CONTEST.ID` | string/number | RaceResult contest/race ID |
| `CONTEST.NAME` | string | Contest/race name |

### Response (200 OK)

```json
{
  "status": "ok",
  "action": "inserted"
}
```

or

```json
{
  "status": "ok",
  "action": "updated"
}
```

### Error Responses

| Status | Description |
|--------|-------------|
| 401 | Missing or invalid Bearer token |
| 400 | Invalid request body or missing Values field |

## Behavior

### Bib Number Handling

If the event has a `raceno_bib_limit` configured and the bib number exceeds this limit, the bib is treated as dynamic/placeholder and stored as empty string. This prevents cluttering results with temporary bibs assigned during registration.

### Upsert Logic

Athletes are looked up by `race_id` + `athlete_id` (RaceResult ID). If found, the record is updated; otherwise, a new record is inserted.

Updated fields:
- `name` (full name: first + last)
- `first_name`
- `last_name`
- `raceno` (bib number, or empty if exceeds limit)
- `contest` (RaceResult contest ID)
- `info` (contest name)

### Observation Logging

Each webhook call is logged to Redis for monitoring:

- **Count**: `observe:webhook:count:{race_id}` — incremented on each call
- **Last**: `observe:webhook:last:{race_id}` — timestamp of last webhook
- **IDs**: `observe:webhook:ids` — set of race IDs that have received webhooks
- **Feed**: `observe:webhook:feed` — rolling list of last 200 webhook events

Observation keys expire after **7 days**.

## RaceResult Setup

In RaceResult software, configure the webhook:

1. Go to **Event Settings** → **Webhooks**
2. Add webhook URL: `https://eventoapi.com/v1/rr_webhook/{race_id}`
3. Set trigger: **participant_update**
4. Add Bearer token in Authorization header (from Evento)

## Notes

- Athlete lookup is by RaceResult `ID`, not bib number (bibs can change)
- If athlete already exists, only the specified fields are updated — other fields remain unchanged
- Observation logging never blocks the webhook response (fire-and-forget)
- Race name in observation log is read from Redis cache (set by timing data push acceptance flow)
