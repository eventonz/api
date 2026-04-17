# Tracks

Receive live timing data from timing systems. Processes split times, updates results tables, manages Redis tracking cache, and triggers push notifications.

## Endpoints

All endpoints are **POST** only and accept timing data in the request body.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/tracks/race/:race_id` | Direct Evento race ID lookup |
| POST | `/v1/tracks/sportsplits/:ss_raceid` | SportSplits race ID lookup |
| POST | `/v1/tracks/racetec/:racetec_apikey` | RaceTec API key lookup |
| POST | `/v1/tracks/raceresult/:rr_eventid` | RaceResult event ID lookup |

## Authentication

Requires Bearer token in Authorization header.

## POST /v1/tracks/race/:race_id

Direct timing push using Evento race ID.

### Parameters

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| `race_id` | path | integer | yes | Evento event (race) ID |

### Request Body

See [Common Request Body](#common-request-body) section below.

## POST /v1/tracks/sportsplits/:ss_raceid

Timing push via SportSplits race ID lookup. Evento resolves the race ID from `ss_race_id` field in races table.

### Parameters

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| `ss_raceid` | path | integer | yes | SportSplits race ID |

## POST /v1/tracks/racetec/:racetec_apikey

Timing push via RaceTec API key lookup. Evento resolves the race ID from `racetec_apikey` field in races table.

### Parameters

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| `racetec_apikey` | path | string | yes | RaceTec API key |

## POST /v1/tracks/raceresult/:rr_eventid

Timing push via RaceResult event ID lookup. Evento resolves the race ID from `rr_eventid` field in races table.

### Parameters

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| `rr_eventid` | path | integer | yes | RaceResult event ID |

## Common Request Body

Request body format varies by timing system. Each timing system has its own normaliser that converts the raw format to Evento's internal `trackdata` format.

### Supported Formats

- **RaceResult**: Native RR array or Evento exporter struct (see CLAUDE.md for details)
- **SportSplits**: SportSplits push format
- **RaceTec**: RaceTec split push
- **Evento**: Generic Evento tracking format

Normaliser detection is automatic based on request body structure and race configuration.

### Example: Generic Evento Format

```json
{
  "race_no": "42",
  "athlete_id": "12345",
  "first_name": "John",
  "last_name": "Smith",
  "contest_id": 1,
  "split_id": 5,
  "race_time": "01:23:45",
  "tod": "12:34:56",
  "start": "11:11:11",
  "lat": -36.8485,
  "lng": 174.7633
}
```

## Response (201 Created)

```json
{
  "message": "Record Created 42"
}
```

The message includes the last processed race number from the batch.

## Error Responses

| Status | Description |
|--------|-------------|
| 400 | Race not found, invalid contest/split, or outside reception window |
| 401 | Missing or invalid Bearer token |

### Reception Window

Events have a "live" flag and optional data reception window. If event is not live and current time is outside the reception window, timing data is rejected with:

```json
{
  "msg": "Event is not LIVE and not within data reception window"
}
```

**Exception**: Events with `live_test_mode` enabled accept data at any time (bypasses window check).

## Processing Pipeline

All four endpoint variants follow the same 6-stage pipeline:

### Stage 1: Race Config Lookup
Resolve Evento race ID and load full race config (contest/split definitions, thresholds, push settings, etc.)

### Stage 2: Normalise
Convert timing system's native format to Evento's internal `trackdata` format. Normalisers are pluggable per timing system.

### Stage 3: Process
- Match contest and split from timing data
- Build push notification message
- Calculate speed and pace
- Determine tracking/push flags
- Fetch live camera URL (if configured)

### Stage 4: Persistence
- **Results table**: Always upsert to org-specific results table (e.g. `timit`, `chrono`)
- **Redis dedup**: Check if split is genuinely new (not a duplicate) using Redis SADD

### Stage 5: Tracking Update
If split is new AND tracking enabled:
- Insert into Redis tracking cache (sorted set by split timestamp)
- Update athlete's last position, contest, split

### Stage 6: Push Notifications
If split is new AND push enabled for this split:
- Queue push notification via Redis `eventonotify` list
- Push worker picks up and sends to FCM

## Notes

- **Deduplication**: Stage 4 uses Redis SADD with key format `split_dedup:{race_id}:{race_no}:{split_id}:{contest_id}`. If the combination already exists, it's a duplicate and tracking/push steps are skipped. Results table is still updated (allows correction of times).

- **Batch processing**: If request body contains an array, all athletes are processed sequentially. Each athlete's errors are isolated — one failure doesn't abort the entire batch.

- **Live camera URLs**: If event has live cameras configured per split, the URL is included in tracking data and push notifications.

- **Speed calculation**: Speed is derived from distance and race time. If split distance is missing or race time is invalid, speed is set to 0.

- **Marker text**: Defaults to `race_no` if not provided by normaliser (used for map marker labels).

- **Process queue logging**: Raw request body is logged to `process_queue` Redis list (fire-and-forget) for debugging and replay.

## Timing System Integration

Each timing system should configure their software to push to the appropriate endpoint:

- **RaceResult**: Set up Evento exporter template in RR event file (see CLAUDE.md)
- **SportSplits**: Configure webhook to `/v1/tracks/sportsplits/{ss_raceid}`
- **RaceTec**: Configure push URL to `/v1/tracks/racetec/{apikey}`
- **Generic/custom**: Use `/v1/tracks/race/{race_id}` with Evento format

All endpoints require Bearer token authentication (provided by Evento).
