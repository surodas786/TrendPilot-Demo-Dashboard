# TrendPilot Paper staging runbook

Paper only: orders fill in the paper simulator. **No exchange credentials exist in this build**, and the web app, worker and feed refuse to start unless `LIVE_ORDER_TRANSPORT=disabled`. Private MEXC adapter validation is Step 11.

## 1. What runs

| Service | Image / command | Purpose |
| --- | --- | --- |
| `db` | `postgres:16-alpine` | Staging database `trendpilot_staging` (volume `staging_pgdata`, no host port) |
| `migrate` | `npm run db:migrate` (one-shot) | Applies `packages/db/migrations` before the app starts |
| `web` | `npm run start -w @trendpilot/web` | Next.js production server on :3000 (container), health `GET /v1/health` |
| `worker` | `npm run worker` | Durable jobs: signal routing, paper fills, exits, funding, retention; heartbeat to Operations |
| `feed` | `npm run market:feed` | Public MEXC prices, closed candles, settled funding; heartbeat to Operations |
| `caddy` | `caddy:2-alpine` + `docker/staging/Caddyfile` | HTTPS on `${STAGING_HTTPS_PORT:-443}`; ACME certificate for a public `STAGING_DOMAIN` |

One image (`Dockerfile`) serves web, worker, feed and the operator commands. Files: `Dockerfile`, `.dockerignore`, `docker-compose.staging.yml`, `docker/staging/Caddyfile`, `.env.staging.example`.

## 2. Inputs required for a real staging target (not in the repository)

| Input | Why | Where |
| --- | --- | --- |
| A host with Docker Engine 24+ and Compose v2, inbound 80/443 open | Runs the stack; ACME HTTP-01 needs port 80 reachable or DNS-01 configured | Infrastructure owner |
| `STAGING_DOMAIN` with a DNS A/AAAA record to that host | TradingView only posts to a public HTTPS URL with a trusted certificate (port 443) | DNS owner |
| `POSTGRES_PASSWORD` | Database credential | Secret store → `.env.staging` |
| `DATA_ENCRYPTION_KEY` (32 bytes base64) | Seals MFA secrets at rest; the web app refuses to start without it in production | Secret store → `.env.staging` |
| First administrator email | `ops:bootstrap-admin` | Release owner |
| Off-host backup location and schedule | Backups in §6 land on the host; copy them off-host | Infrastructure owner |
| Approval to deploy and to expose the webhook | Release gate | Project owner |
| (Optional) SMTP or an email provider | This build captures mail in `email_outbox`; operators relay invite/reset links with `ops:mail` | Release owner |

## 3. Deploy

```sh
git clone <repo> && cd TrendPilot-Demo-Dashboard && git checkout <release-commit>
cp .env.staging.example .env.staging          # fill in §2; never commit .env.staging
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # DATA_ENCRYPTION_KEY
C="docker compose -f docker-compose.staging.yml --env-file .env.staging"
$C build
$C up -d                                         # db → migrate → web, worker, feed → caddy
$C ps                                            # web healthy; migrate exited 0
curl -s https://$STAGING_DOMAIN/v1/health        # {"status":"ok","web":"up","database":"up","mode":"PAPER","liveOrderTransport":"disabled"}
```

Local rehearsal (no domain): `STAGING_DOMAIN=localhost`, `STAGING_HTTPS_PORT=8443`, `APP_BASE_URL=https://localhost:8443`. Caddy then uses its internal CA (not trusted by TradingView), so use `curl -k` / `NODE_TLS_REJECT_UNAUTHORIZED=0` for the smoke test only.

## 4. First administrator and configuration

```sh
$C exec -T web npm run --silent ops:bootstrap-admin -- --email ops@example.com --name "Staging Operator"
# prints a single-use invite link → open it, set the password, then enable MFA in My Security
```
- Refuses when an administrator already exists. Further investors: *Users → Invite*; relay the link with `$C exec -T web npm run --silent ops:mail -- --to <email> --template INVITE`.
- *TradingView Webhook & Routes → Create webhook* shows the webhook URL once (then *Rotate token*). Add routes; paste the alert messages into TradingView alerts ("Once Per Bar Close").
- *Trading Pairs & Defaults* (publish BTCUSDT), *Strategy Packages* (publish a version), investors' *Trade Settings* (Paper blocks).
- The smoke test (§5) performs exactly this setup through the API when it is missing.

## 5. Smoke test through the HTTPS webhook

```sh
SMOKE_BASE_URL=https://$STAGING_DOMAIN \
SMOKE_ADMIN_EMAIL=ops@example.com SMOKE_ADMIN_PASSWORD='…' [SMOKE_ADMIN_TOTP_SECRET='…'] \
SMOKE_INVESTOR_PASSWORD='…' \
SMOKE_OPS_MAIL_CMD="docker compose -f docker-compose.staging.yml --env-file .env.staging exec -T web npm run --silent ops:mail --" \
npm run staging:smoke
```
It creates two smoke investors (`smoke-a@…`, `smoke-b@…`, different sizes and exits), waits for a healthy public feed and the next 5m bar close, sends one `BULLISH_FLIP` through the HTTPS webhook at the live public price, re-sends it (duplicate), checks both positions with attached stops, cross-investor 404s, closes both, checks exits, ledger reconciliation and Operations. Exit code 0 = all checks passed. It rotates the webhook token on every run (re-paste the URL into TradingView afterwards, or run it before configuring TradingView).

## 6. Health, operations and drills

Screens (admin): **Operations** (`/admin/operations`) — alerts, database, worker, market feed, job queue, recent job failures, feed events. **Market Data Feed** (`/admin/market-data`) — per-contract feed state, freshness, source, contract-spec differences.
API: `GET /v1/health` (public, no data), `GET /v1/admin/operations`, `GET /v1/admin/market-feeds`.

**Feed disconnect drill**
```sh
$C stop feed
$C run --rm -e MEXC_PUBLIC_BASE_URL=http://10.255.255.1 feed npm run market:feed -- --once   # unreachable endpoint → BTCUSDT DOWN
# Operations: "BTCUSDT feed DOWN: …" and, after 90 s, "Market feed is not reporting"; entries are blocked (FEED_STALE)
$C start feed                                     # reconnect → RECOVERED + UNVERIFIED_INTERVAL events, state HEALTHY
```

**Failed job drill** (operator SQL; a deliberately malformed job)
```sh
$C exec -T db psql -U trendpilot -d trendpilot_staging -c "INSERT INTO jobs (kind, dedupe_key, payload, run_after, max_attempts) VALUES ('market.tick', 'drill-failed-job-'||now(), '{\"instrumentId\":\"not-a-uuid\",\"quote\":{}}', now(), 1)"
# within seconds the worker marks it DEAD → Operations: "1 job(s) failed permanently (DEAD)" with its error
$C exec -T db psql -U trendpilot -d trendpilot_staging -c "DELETE FROM jobs WHERE dedupe_key LIKE 'drill-failed-job-%'"   # clean up
```

## 7. Backup and restore

Backup (consistent online dump, custom format):
```sh
mkdir -p backups
$C exec -T db pg_dump -U trendpilot -d trendpilot_staging -Fc --no-owner > backups/trendpilot_staging_$(date -u +%Y%m%dT%H%M%SZ).dump
```
Copy `backups/` off-host. Schedule at least daily; keep the paper ledger and fills (they are never pruned).

Restore drill into a **separate** database (never over staging):
```sh
scripts/backup-restore-drill.sh trendpilot_restore_drill
```
It dumps staging, restores into `trendpilot_restore_drill` on the separate development PostgreSQL instance (`docker-compose.yml`), and verifies row counts and checksums of users, paper accounts, positions, exits, fills, funding and every ledger entry, the ledger sum, signal events and the migration journal, plus that every restored balance equals its ledger buckets. Exit code 0 = verified.

Real recovery (staging lost): stop `web`, `worker`, `feed`; recreate the database; `pg_restore -U trendpilot -d trendpilot_staging --no-owner --exit-on-error < <dump>`; `$C up -d` (migrate is a no-op when the dump is current); check Operations and a dashboard's ledger check.

## 8. Upgrade, rollback, teardown
- Upgrade: back up (§7) → `git checkout <new>` → `$C build && $C up -d` (migrations run first; web waits for them).
- Rollback: `git checkout <previous>` → restore the pre-upgrade dump (§7) → `$C up -d`. Migrations are forward-only.
- Teardown: `$C down` (keeps volumes); `$C down -v` deletes the staging database and certificates.
