# Athletes

Paginated athlete search and batch athlete retrieval for a given race.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/athletes/:race_id` | Paginated athlete list / search |
| PATCH | `/v1/athletes/:race_id` | Fetch specific athletes by edition + athlete_id |

> The GET (all athletes) endpoint is intentionally not implemented in this API.

## Authentication

All requests require a Bearer token in the `Authorization` header.

```
Authorization: Bearer <token>
```

---

## POST `/v1/athletes/:race_id`

Returns a paginated list of athletes for a race. Pass a `searchstring` to filter results.

### Parameters

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| `race_id` | path | integer | yes | The race ID |

### Request Body

```json
{
  "pageNumber": 1,
  "searchstring": ""
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pageNumber` | integer | yes | Page number (1-based) |
| `searchstring` | string | no | Search term. Empty string returns all athletes paginated |

### Search Behaviour

Page size is fixed at **20 records**.

**Epic Series races** (IDs: 60, 76, 84, 86, 87, 88) use direct SQL:
- Empty search: ordered by bib number ascending
- With search: matches `raceno` (exact) or `name`, `info`, `extra` (case-insensitive ILIKE)

**All other races** delegate to PostgreSQL functions:
- Empty search: `emptysearch_function(race_id, pageSize, offset)`
- With search: `search_athletes(searchstring, race_id, pageSize, offset)`

TBC athletes (raceno = `'TBC'`) are always sorted to the end of results regardless of ordering.

### Response

```json
{
  "athletes": [
    {
      "id": "1",
      "name": "Toyota Specialized Imbuko",
      "number": "1",
      "disRaceNo": "1",
      "contest": 1,
      "extra": "Matthew Beers Tristan Nortje",
      "info": "Elite Men ",
      "country": "ZA",
      "profile_image": "https://...",
      "athlete_details": { ... },
      "can_follow": false
    }
  ],
  "pagination": {
    "currentPage": 1,
    "totalRecords": 706,
    "totalPages": 36
  }
}
```

### Athlete Fields

| Field | Type | Always present | Description |
|-------|------|---------------|-------------|
| `id` | string | yes | `athlete_id` if it differs from `raceno`, otherwise `raceno` |
| `name` | string | yes | Athlete or team name |
| `number` | string | yes | Bib / race number |
| `disRaceNo` | string | yes | Display race number (falls back to `number`) |
| `contest` | integer | yes | Contest/category ID |
| `info` | string | no | Category label (e.g. `"Elite Men "`) |
| `extra` | string | no | Extra info (e.g. individual names for a team bib) |
| `country` | string | no | Country code |
| `profile_image` | string | no | Profile image URL |
| `athlete_details` | object | no | Extended JSON details from `athlete_additional` table |
| `can_follow` | boolean | no | Only present and `false` when `raceno = 'TBC'` |

### Side Effects

Each POST request asynchronously increments `races.athlete_search_count` — this is fire-and-forget and does not affect response time.

---

## PATCH `/v1/athletes/:race_id`

Fetches a specific set of athletes filtered by `edition` and an array of `athlete_id` values. Used by the mobile app to hydrate a known set of athletes (e.g. a user's followed athletes).

### Parameters

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| `race_id` | path | integer | yes | The race ID |

### Request Body

```json
{
  "edition": "2026",
  "athletes": ["1", "2", "3"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `edition` | string | yes | Edition/year filter — must not be empty |
| `athletes` | array of strings | yes | `athlete_id` values to fetch (not bib numbers) |

### Response

```json
{
  "patchedathletes": [
    {
      "id": "1",
      "name": "Toyota Specialized Imbuko",
      "number": "1",
      "disRaceNo": "1",
      "contest": 1,
      "extra": "Matthew Beers Tristan Nortje",
      "info": "Elite Men ",
      "profile_image": "https://..."
    }
  ]
}
```

Same athlete field structure as POST. Returns only athletes that match the given `race_id`, `edition`, and `athlete_id` values. Returns an empty array if none match.

> **Note:** `athletes` array contains `athlete_id` values, not bib numbers (`raceno`). These are typically the same for most races but differ when an external import ID is present.

## Caching

Neither endpoint caches responses in Redis — search results are dynamic and pagination makes caching impractical. The underlying Postgres functions handle their own query planning.

## Errors

| Status | Description |
|--------|-------------|
| 400 | Missing required fields or empty `edition` |
| 401 | Missing or invalid Bearer token |
