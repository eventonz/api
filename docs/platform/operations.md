# Operations

## Hosts
| Host | What | Access |
|---|---|---|
| **API droplet** 134.199.152.100 (2 vCPU/2 GB, syd1) | `/root/node-api`, PM2 `evento-api` ×2, `evento-track-worker`, `evento-analytics-worker`; `.env` there | `ssh root@…`; deploy via GitHub Actions on push to `main` |
| **Worker droplet** 209.38.84.127 (`evento-worker`, s-1vcpu-2gb, syd1) | `/root/evento-worker`, PM2 `ingest-worker` ×2, `notify-worker`, `schedule-worker` (900 M cap), `worker-dashboard` :3000 (password `WEB_PASSWORD` in `.env`); logs `/var/log/evento-worker/*.log` | `ssh root@…`; deploy = rsync + `pm2 startOrReload` |
| Managed Postgres + Valkey | DO syd1, trusted sources = both droplets | creds in each `.env` |
| Spaces `evento-events` | syd1 + CDN | `SPACES_KEY/SECRET` (CMS), `DO_SPACES_*` (API) |
| Firebase | per-app projects | service account JSON on both droplets (gitignored) |

## Env vars by component
**API**: `PORT, NODE_ENV, JWT_SECRET, PG_HOST/PORT/DATABASE/USER/PASSWORD/SSL, REDIS_HOST/PORT/PASSWORD/TLS, RR_ENCRYPTION_KEY, RR_ALLOW_WRITES=1, DO_SPACES_KEY/SECRET, OPENAI_API_KEY, OPENROUTER_API_KEY/MODEL`; optional `READS_PER_MINUTE, INGEST_PER_MINUTE, INSTALL_TOKEN_TTL_S, READS_REQUIRE_INSTALL_TOKEN`.
**Worker**: same PG/REDIS/JWT/RR/DO_SPACES + `PUSH_DRY_RUN=0, PUSH_LANG_TOPICS (unset=per-language), PG_POOL_MAX=5, WEB_PORT=3000, WEB_PASSWORD, EVENTOAPI_URL, EVENTOAPI_PUSH_KEY (server key), ADMIN_ALERT_EMAILS, RESEND_API_KEY, MAIL_FROM, CMS_URL, MAX_LIVE_H=20, AUTO_STOP_H=36, ALERT_REPEAT_H=24, PULL_INTERVAL_S, ARM_BEFORE_MIN, ATHLETE_RELOAD_MIN, FINALISE_GRACE_H, SCHEDULE_MAX_MEM`.
**CMS**: see cms.md.

## Monitoring
- **CMS → Resources → Health** (superadmin): races live + hours, alerts, heartbeats, queues.
- **Worker dashboard** `http://209.38.84.127:3000`: queues, recent jobs, failed lists (requeue/clear), Schedule card, push runner.
- **Per-race activity log**: CMS Overview → Activity log.
- **Alerts** (worker `lib/ops.js`, each once per 24 h; Redis `ops:alerts` + email via Resend to `ADMIN_ALERT_EMAILS`, default todd@ and rochelle@evento.co.nz — **set `RESEND_API_KEY` on the worker to enable email**):

| Alert | Trigger | What to do |
|---|---|---|
| race-long-live | live/armed >20 h, no stop time | Press Stop live if the event is over |
| race-auto-stopped | >36 h: worker finalised it itself | Nothing; Go live again if it was intentional |
| race-error | 3 failed pulls | Check RR access/list; Clear error; Go live |
| exporter-not-live | ≥5 pushes ignored in 10 min | Someone forgot **Go live** — press it |
| worker-missing | no ingest/notify heartbeat | `pm2 status` on the worker droplet |
| worker-restarts | scheduler restarted >5×/h | memory cap / crash: `pm2 describe schedule-worker`, `schedule-error.log` |

## Runbooks
- **Deploy API**: review diff → confirm → `git push origin main` → `gh run watch` → `curl https://eventoapi.com/health`.
- **Deploy worker**: `rsync … && ssh root@209.38.84.127 'cd /root/evento-worker && pm2 startOrReload ecosystem.config.js --update-env && pm2 save'`.
- **Toggle install-token enforcement**: Redis `SET config:reads_require_install_token 0|1` (30 s cache).
- **Create a server API key**: insert into `api_keys (name, kind='server', key_hash=sha256(plain), active)`; hand the plaintext to the CMS/worker env.
- **Revoke an install**: Redis `SET revoked:install:{install_id} … EX 2592000`.
- **Provisioning says "writes disabled"**: `RR_ALLOW_WRITES=1` missing on the API host.
- **Pull says "unreadable splits column"**: RaceResult masking non-activated participants — activate them; cached data is preserved meanwhile.
- **Exporter posts rejected**: check race is live; the API accepts any content type and repairs empty values; body still invalid → see `error` lines in the race log.
- **Big event memory**: per-contest pulls keep the worker under ~400 MB; scheduler cap is 900 M (`SCHEDULE_MAX_MEM`). Never go back to 512 MB droplets.
- **Migrations**: `psql -f database/migrations/NNN.sql` by hand; record in the file header.

## Local development
- API: `npm start` in `node-api/` (port 3000, `.env` with prod PG/Redis + `RR_ALLOW_WRITES=1`, `RR_TEST_APIKEY`).
- CMS: `npm run dev -- -p 3100` in `NEXTJS-CMS/` with `EVENTOAPI_URL=http://127.0.0.1:3000`.
- Worker: `node src/schedule.js` etc. with a copy of the droplet `.env`; tests `npx jest` in each repo.
- Test RaceResult event 421131 (see live-timing-pipeline.md §10). Never point tests at customer events.
