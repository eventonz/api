# Evento Node API — Documentation

Base URL: `https://eventoapi.com`

## Authentication

All `/v1/*` endpoints require a Bearer token:
```
Authorization: Bearer <token>
```

Tokens are generated with:
```bash
node scripts/generate-key.js "App Name" [--app-id <id>]
```

## Endpoints

| Resource | Doc |
|----------|-----|
| Events | [events.md](./events.md) |
| Config | [config.md](./config.md) |
| Athletes | [athletes.md](./athletes.md) |
| Follow | [follow.md](./follow.md) |
| Tracks | [tracks.md](./tracks.md) |
| Notifications | [notifications.md](./notifications.md) |
| RaceResult Webhook | [rr_webhook.md](./rr_webhook.md) |
| App Install | [app_install.md](./app_install.md) |
| App Version | [app_version.md](./app_version.md) |
| Timer Events | [timer_events.md](./timer_events.md) |
