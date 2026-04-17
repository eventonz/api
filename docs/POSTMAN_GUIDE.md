# Postman Collection Guide

## Import Instructions

1. Open Postman
2. Click **Import** button (top left)
3. Drag and drop `Evento_Node_API.postman_collection.json`
4. The collection will appear in your sidebar with all endpoints ready to use

## Pre-configured Settings

✅ **Authorization Token**: Already configured at collection level
```
Token: 61e66bc8567dc8dfdc11dc623c3a5659a9463959a2d375938be525d2747243a3
```

✅ **Base URL**: Set as variable `{{base_url}}` = `http://localhost:3000`

## Available Test App IDs

Use these in the `:appid` or `:app_id` path parameters:

| ID | App Name |
|----|----------|
| 2  | Epic Series |
| 4  | Round the Bays |
| 5  | Motatapu |
| 6  | Noosa Tri |
| 7  | Runaway |
| 8  | Coast to Coast |
| 10 | Challenge Wanaka |
| 11 | Ultra-Trail Australia |
| 12 | Tarawera |
| 13 | IRONMAN Oceania |

## Quick Start Tests

### 1. Health Check (No Auth)
- Endpoint: `GET /health`
- No authentication needed
- Should return: `{"status": "ok"}`

### 2. Get App Version
- Endpoint: `GET /v1/app_version/2`
- Returns iOS/Android versions for Epic Series

### 3. Get Events
- Endpoint: `GET /v1/events/2`
- Returns all events for Epic Series app

### 4. Get Upcoming Events
- Endpoint: `GET /v1/events/2/upcoming`
- Filters to only upcoming events

## Folder Structure

```
📁 Evento Node API
├─ Health Check (no auth)
├─ 📁 Events
│  ├─ Get All Events
│  ├─ Get Upcoming Events
│  └─ Get Past Events
├─ 📁 App Version
│  ├─ Get App Version
│  └─ Update App Version
├─ 📁 App Install
│  └─ Track Install
├─ 📁 Config
│  └─ Get Race Config
├─ 📁 Athletes
│  ├─ Search Athletes
│  └─ Get Athlete Details
├─ 📁 Follow
│  ├─ Get Followed Athletes
│  ├─ Follow Athlete
│  └─ Unfollow Athlete
├─ 📁 Tracks
│  ├─ Get Latest Tracks
│  └─ Get Tracks Since Timestamp
├─ 📁 Notifications
│  ├─ Register Device
│  └─ Update Preferences
├─ 📁 RaceResult Webhook
│  ├─ Receive RR Data (Ugo's Format)
│  └─ Receive RR Data (Evento Format)
└─ 📁 Timer Events
   ├─ Get Timer Events
   └─ Push Timer Data
```

## Variables

The collection includes these variables:

- `{{base_url}}` - Base API URL (default: `http://localhost:3000`)
- `{{timer_token}}` - Separate token for timer endpoints (needs to be set)

### Changing Environment

To test against production:

1. Click **Environments** in Postman
2. Create new environment
3. Add variable: `base_url` = `https://eventoapi.com`
4. Select this environment

## Authorization

Most endpoints inherit auth from the collection level (Bearer token already set).

**Exceptions:**
- `/health` - No auth required
- `/v1/rr_webhook/*` - No auth (webhook receiver)
- `/v1/timer/*` - Uses separate `{{timer_token}}` variable

## Path Parameters

Path parameters (like `:appid`, `:race_id`) are shown in the URL with default test values. You can:

1. Edit them directly in the URL bar
2. Or use the **Params** tab below the URL
3. Hover over them to see descriptions

## Sample Responses

All requests include descriptions and will show:
- ✅ 200 responses with actual data
- ❌ 404 if resource not found
- ❌ 401 if auth token invalid

## Tips

💡 Use **Collections Runner** to test all endpoints at once  
💡 **Save responses** as examples for documentation  
💡 Use **Variables** for commonly changed IDs  
💡 Enable **Auto-follow redirects** in Settings
