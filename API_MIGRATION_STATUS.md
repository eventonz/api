# API Migration Status: ColdFusion → Node.js

Comparison of endpoints between the legacy CF API (`/api/v4/`) and the new Node.js API (`/v1/`).

## ✅ Migrated Endpoints (In Node.js)

| Endpoint | CF Module | Node Route | Status |
|----------|-----------|------------|--------|
| App install/update | `app_install.cfm` | `app_install.js` | ✅ Complete |
| App version check | `app_version.cfm` | `app_version.js` | ✅ Complete |
| Athletes search/list | `athletes.cfm` | `athletes.js` | ✅ Complete |
| Race configuration | `config.cfm` | `config.js` | ✅ Complete |
| Event list | `events_v2.cfm` | `events.js` | ✅ Complete |
| Follow athletes | `follow.cfm` | `follow.js` | ✅ Complete |
| Event list (apps) | `menu.cfm` | `list.js` | ✅ Complete |
| Push notifications | `notifications.cfm` | `notifications.js` | ✅ Complete |
| RaceResult webhook | `rr_webhook.cfm` | `rr_webhook.js` | ✅ Complete |
| Schedule items | (part of pages) | `schedule.js` | ✅ Complete |
| Timer event creation | `timer_events.cfm` | `timer_events.js` | ✅ Complete |
| Live tracking | `tracks.cfm` | `tracks.js` | ✅ Complete |
| URL redirect | `redirect.cfm` | `redirect.js` | ✅ Complete |
| Carousel ads | (part of pages) | `carousel.js` | ✅ Complete |

## ❌ Missing Endpoints (Not Yet in Node.js)

### High Priority - Core Features

| Endpoint | CF Module | Purpose | Used By |
|----------|-----------|---------|---------|
| **Splits/Results** | `splits.cfm` | Get athlete split times & results | Mobile app, results display |
| **Pages** | `pages.cfm` | Race page content (info, sponsors, etc) | Mobile app pages |
| **Maps** | `maps.cfm` | Race course maps & GeoJSON | Mobile app tracking |
| **Social feeds** | `social.cfm` | Curator social media feeds | Mobile app feed page |
| **Adverts** | `adverts.cfm` | In-app advertising | Mobile app monetization |
| **Shortcuts** | `shortcuts.cfm` | Quick action buttons | Mobile app home screen |
| **Race settings** | `settings.cfm` | Race configuration | CMS |
| **Mini player** | `miniplayer.cfm` | Live video player config | Mobile app video |

### Medium Priority - Timer Integrations

| Endpoint | CF Module | Purpose |
|----------|-----------|---------|
| **RaceResult data converter** | `convert_data/raceresult.cfm` | Process RaceResult push data |
| **SportSplits converter** | `convert_data/sportsplits.cfm` | Process SportSplits data |
| **RaceTec converter** | `convert_data/racetec.cfm` | Process RaceTec API data |
| **TimingSport converter** | `convert_data/timingsport.cfm` | Process TimingSport data |
| **Update startlist** | `updatestartlist.cfm` | Load athlete entries from timer |
| **Update splits** | `updatesplits.cfm` | Manual split data upload |
| **Get results** | `getresults.cfm` | Fetch results from timer platforms |

### Medium Priority - CMS Features

| Endpoint | CF Module | Purpose |
|----------|-----------|---------|
| **Map builder** | `mapbuilder.cfm` | Create/edit race course maps |
| **File upload** | `fileupload.cfm` | Image/file uploads (profiles, etc) |
| **Profile snap** | `profilesnap.cfm` | Athlete profile images |
| **Race object** | `raceobj.cfm` | Complete race data object |
| **MapKit token** | `mapkit_token.cfm` | Apple MapKit JWT token generation |
| **Clear cache** | `clearcache.cfm` | Redis cache management |
| **Device registration** | `device.cfm` | Device/notification token management |

### Medium Priority - AI Assistant

| Endpoint | CF Module | Purpose |
|----------|-----------|---------|
| **Assistant chat** | `assistant.cfm` | Race Day Assistant chat API |
| **Assistant knowledge** | `assistant_knowledge.cfm` | Upload knowledge base (PDFs) |
| **Assistant embed** | `assistant_knowledge_embed.cfm` | Vector embeddings for RAG |
| **Assistant mapping** | `assistant_map.cfm` | Map events to assistants |
| **Assistant reports** | `assistant_report.cfm` | Chat analytics/reports |

### Low Priority - Tracking Scripts

These are race-specific data transformation scripts (legacy):

| Script Type | Files | Purpose |
|-------------|-------|---------|
| Split scripts | `split_scripts/` (multiple) | Transform split data per race |
| Tracking scripts | `tracking_scripts/` (8 files) | Calculate athlete positions |
| Track scripts | `tracks_scripts/racetec.cfm` | Platform-specific tracking |

### Low Priority - Specialized/Legacy

| Endpoint | CF Module | Purpose | Notes |
|----------|-----------|---------|-------|
| `therace.cfm` | Timer integration | The Race timing platform | Rarely used |
| `racetec.cfm` | Timer integration | RaceTec direct integration | Rarely used |
| `racemap.cfm` | Race map generation | Legacy map system | Replaced by maps.cfm |
| `results.cfm` | Results display | Legacy results view | Replaced by splits |
| `send_athlete_push.cfm` | Athlete notifications | Manual push sender | Low usage |
| `test.cfm` | Testing/debug | Debug endpoint | Dev only |
| `tracking.cfm` | Tracking config | Legacy tracking setup | Rarely used |
| `athletessql.cfm` | SQL athlete search | Direct DB query | Performance concern |

## Migration Priority Ranking

### Phase 1: Essential for Mobile App (Current)
- ✅ Athletes search
- ✅ Events list
- ✅ Tracking (live positions)
- ✅ Follow
- ✅ Notifications
- ✅ Config

### Phase 2: Core Features (Next)
1. **Splits/Results** - Critical for results display
2. **Pages** - Needed for content pages
3. **Maps** - Course maps and tracking visualization
4. **Social** - Feed integration
5. **Shortcuts** - Home screen actions

### Phase 3: Timer Integrations
1. **RaceResult converter** - Primary timing platform
2. **SportSplits converter** - Secondary platform
3. **RaceTec converter** - Used by some events
4. **Update startlist** - Athlete loading

### Phase 4: CMS Features
1. **Map builder** - CMS map editing
2. **File upload** - Image uploads
3. **Settings** - Race configuration
4. **Device management** - Push token handling

### Phase 5: AI Assistant
1. **Assistant chat API**
2. **Knowledge upload**
3. **Vector embeddings**

### Phase 6: Legacy/Specialized
- Race-specific transformers
- Debug/testing endpoints
- Deprecated features

## Statistics

- **Total CF endpoints**: 45+
- **Migrated to Node**: 14
- **Migration progress**: ~31%
- **High priority missing**: 8
- **Medium priority missing**: 17
- **Low priority**: 20+

## Implementation Notes

### Why Some Endpoints Are Missing

1. **Complexity**: Some CF endpoints are 1000+ lines with complex business logic
2. **Race-specific**: Many scripts are customized per race/platform
3. **Low usage**: Some features rarely used (can deprioritize)
4. **Legacy**: Some replaced by newer approaches

### Next Steps

**Immediate** (needed for full app parity):
1. Implement `/splits` endpoint (results display)
2. Implement `/pages` endpoint (content management)
3. Implement `/maps` endpoint (course visualization)

**Short-term**:
1. RaceResult data converter (primary timing platform)
2. Social feed integration
3. Shortcuts API

**Long-term**:
1. CMS-specific features (map builder, uploads)
2. AI Assistant endpoints
3. Race-specific transformers (as needed)

## Testing Strategy

For each migrated endpoint:
1. Compare response format between CF and Node
2. Verify all query parameters work
3. Load test with production traffic
4. Monitor error rates
5. Gradual rollout per endpoint

## Rollout Plan

- **Current**: Node API handles ~30% of endpoints
- **Q2 2026**: Add splits, pages, maps (reach 50%)
- **Q3 2026**: Timer converters + CMS features (reach 70%)
- **Q4 2026**: AI Assistant + remaining features (reach 90%)
- **Deprecation**: Keep CF API running alongside Node until 100% migrated

---

## Quick Reference: What Works Now

**Mobile app can use Node API for**:
- ✅ App version checks
- ✅ Event lists
- ✅ Athlete search
- ✅ Live tracking
- ✅ Following athletes
- ✅ Push notifications
- ✅ Basic config

**Mobile app still needs CF API for**:
- ❌ Split times & results
- ❌ Page content
- ❌ Course maps
- ❌ Social feeds
- ❌ Adverts

**CMS still needs CF API for**:
- ❌ Map builder
- ❌ File uploads
- ❌ Timer data loading
- ❌ Most admin functions
