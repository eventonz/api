# Push notifications (FCM)

Two senders, one registry, four languages.

## Topics — the whole model in one table

| Topic (bare) | Meaning | Subscribed when | Sent by |
|---|---|---|---|
| `app-{appId}` | app-wide news & offers | user has "App news" on | CMS Notifications, audience **app** |
| `event-{eventId}` | updates for one event | user has "Updates for this event" on | CMS Notifications, audience **event** |
| `ath-{race_id}-{athlete_id}` | one athlete's crossings | user follows the athlete and hasn't muted them | **worker** on each new crossing (split with `send_push`); CMS audience **athlete** |

Every real FCM subscription carries a **language suffix**: `event-42-en`,
`ath-649-40-fr`. Languages: `en, es, de, fr` (`LANGS` in
`node-api/src/services/fcm.js`; `langTopic()`/`stripLang()`). The app sends
**bare** topics plus its device language; the server suffixes. A send fans out
one message per language with that language's copy. **Both senders must fan
out** — the worker does so by default since 7 Sep 2026 (`PUSH_LANG_TOPICS=0`
reverts to bare topics; before that fix athlete pushes went to the bare topic
nobody was subscribed to).

## Registry and sync (API `routes/v1/push.js`, aliased at `/v2/push`)

- `POST /v2/push/register` `{app_id, platform, token(FCM), device_id, lang}` →
  upsert `v2.device_tokens`, returns `device_token_id`.
- `POST /v2/push/sync` `{app_id, platform, token, event_id, lang, topics:[bare…], follows:[…]}` —
  the app posts its **full intended set** on launch, foreground and any change.
  Server computes the suffixed set, diffs against `v2.device_topics` +
  `v2.follows` **scoped to this event** (`app-*`, `event-{this}`, `ath-*` recorded
  under this event), subscribes/unsubscribes via FCM (idempotent, self-healing),
  and records follows in `v2.follows` (`race_id, athlete_id, bib_number,
  contest_id, event_id, topic, notify`). `v2.follows` is audit/count/fallback —
  FCM topics are the delivery truth. Muting an athlete must unsubscribe (iOS
  shows topic pushes without waking the app).
- `GET /v2/push/inbox` — `v2.notifications` rows with `show_in_inbox` for the app's bell.
- `GET /v2/push/followers?race_id&athlete_id` — counts.

Firebase Admin credentials: `config/firebase-service-account.json` (gitignored)
or `FIREBASE_SERVICE_ACCOUNT_B64`. Both the API droplet and the worker droplet
hold the file. **APNs key must be "Sandbox & Production"** in both Firebase slots
or debug builds get "Invalid APNs credential".

## Sender 1 — athlete crossings (worker)

`ingest-worker` (`handlers/v2tracks.js`): when a crossing is **new** for an
athlete and the configured split has `send_push` (CMS Contests → tick), it
LPUSHes onto `notify_queue`:

```
{ race_id, event_id, app_id, athlete_id, bib, name, kind: started|split|finished,
  split, time, place, title:{en,es,de,fr}, body:{en,…}, tod, timezone, queued_at }
```
Copy is composed at enqueue time by `lib/pushStrings.athleteCopy(kind, {name,
split, time, place})` per language ("Jane Smith finished in 1:57:20, 4th
overall (Provisional)"), so the queue is self-describing and a CMS per-split
custom template can replace it later (`v2.splits.push_type` reserved, unused).

`notify-worker` (`handlers/push.js`): skips if queued >5 min ago (replays),
if nobody follows the athlete (`v2.follows` count, cached 60 s), or if the same
`race/athlete/kind/split` was already sent (Redis `push:sent:…` 6 h). Then for
each language: `fcm.sendToTopic('ath-{race}-{athlete}-{lang}', {title, body,
data:{route:'athlete', event, race_id, athlete, bib, split, kind}, category:'ATHLETE'})`
and records `v2.notifications` (`sender:'system'`, `show_in_inbox:false`).
`PUSH_DRY_RUN=1` logs instead of sending (now `0` on the droplet). Outcomes are
in the race activity log as `notify` lines.

## Sender 2 — CMS composed pushes (API)

CMS Event → **Notifications**: audience app / event / athlete, title + body per
language (✨ AI copy via OpenRouter), optional image (Notification Service
Extension shows banners), deep link (event, page slug, URL, athlete), send now
or **schedule** (`send_after`, entered in event timezone → UTC). CMS →
`POST /v2/push/send` (server key) → stored in `v2.notifications`
(`status sent|scheduled`, `i18n`); the runner `POST /v2/push/run` (called by the
worker's scheduler every tick with `EVENTOAPI_PUSH_KEY`) sends due scheduled
rows; `DELETE /v2/push/{id}` cancels. Every send fans out per language topic.

## App side (MOBILE-V2 `ios/Evento/Push/`)

`PushManager` registers the FCM token, keeps local prefs (app news, per-event
updates, followed-athletes master switch, per-athlete mute), builds the intended
bare topic list (`app-{appId}`, `event-{id}`, `ath-{race}-{athlete}` for each
followed, unmuted athlete) and calls `/v2/push/sync` with `lang`. Notification
taps route to event / page / URL / athlete (cold start included; use the
completion-handler delegate methods). `NotificationsScreen(scope: .app|.event)`
holds the toggles; bell = inbox. See `MOBILE-V2/PUSH-HANDOFF.md` and
`PUSH-PLAN.md` for the full design and gotchas.

## Data
`v2.device_tokens (app_id, platform, fcm_token, device_id, lang, last_seen_at)`,
`v2.device_topics (device_token_id, topic)`, `v2.follows`, `v2.notifications
(app_id, event_id, audience, topic, title, body, image, data, status, send_after,
sent_at, fcm_message_id, error, sender, show_in_inbox, i18n)`.
