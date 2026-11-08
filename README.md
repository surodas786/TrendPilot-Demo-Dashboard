# TrendPilot

TrendPilot evaluates shared TradingView signals against each investor's private settings and trades through that investor's own exchange connection or an isolated paper account. The implementation baseline is [`docs/TrendPilot_SRS.md`](docs/TrendPilot_SRS.md); product context is in [`docs/TrendPilot_Auto_Trading_Platform_Requirements.md`](docs/TrendPilot_Auto_Trading_Platform_Requirements.md).

**Status: M1 (domain and access).**

Built:
- Admin setup: invitations, password resets, MFA, session revocation and suspension.
- Trading pairs, validated against local MEXC contract fixtures.
- Immutable strategy versions with pair mappings.
- Investor Trade Settings with an order preview.
- My Account security.
- An append-only audit log.

**M2 slice 1 (TradingView intake, durable jobs, per-investor routing): done.** See [M2 slice 1](#m2-slice-1--tradingview-intake-and-routing).

**Live order submission is disabled and no live adapter exists.** EMA, market data and paper execution are later M2 slices.

## Repository layout

| Path | What it is |
| --- | --- |
| `apps/web` | Next.js 16 (App Router): UI and `/v1/*` HTTP API |
| `apps/worker` | Separate TypeScript worker: claims durable jobs (ARC-01) and routes accepted signals to per-investor outcomes; live-transport guard |
| `scripts/replay-tradingview.ts` | Sends the exact SRS TradingView payload to the local webhook (`npm run replay`) |
| `packages/domain` | Framework-free rules: order-block, strategy and auth schemas (zod), weekdays (date-fns-tz), decimals and EXE-01 preview math (decimal.js) |
| `packages/db` | Drizzle schema, checked-in SQL migrations and DB triggers, owner-scoped repositories, TOTP and secret sealing, local MEXC contract fixtures, seed |
| `apps/demo` | The original MagicPatterns demo, unchanged — visual reference only, not imported |
| `docs/` | SRS and product requirements |

## Run locally

Prerequisites: Node 22+ and Docker (or any PostgreSQL 16 reachable through `DATABASE_URL`).

```sh
docker compose up -d --wait db      # Postgres 16 on localhost:5433 (dbs: trendpilot, trendpilot_test, trendpilot_e2e)
cp .env.example .env                # PowerShell: Copy-Item .env.example .env
npm install
npm run db:migrate
npm run db:seed
npm run dev                         # http://localhost:3000
npm run worker                      # optional, in another terminal
```

| Where | URL |
| --- | --- |
| App | http://localhost:3000 |
| Development mailbox (captured invite/reset emails) | http://localhost:3000/dev/mail |

Seeded fixture users. Their password is `SEED_PASSWORD` in `.env` (`TrendPilot-dev-only-1` in the template), for development only.

| Role | Email | Name |
| --- | --- | --- |
| Admin | `admin@trendpilot.local` | Platform Administrator |
| Investor A | `investor.a@trendpilot.local` | Nadia Rahman |
| Investor B | `investor.b@trendpilot.local` | Omar Siddiqui |

The seed also publishes:
- **One approved MEXC Futures contract**, BTCUSDT perpetual.
- **One strategy version**: 15m Supertrend, ATR 10, factor 3, EMA Off, KEEP_OPEN, approved for BTCUSDT (SRS §13).

No order blocks are seeded. All contract metadata and preview prices come from `packages/db/src/mexcFixtures.ts`. The UI labels them **"Local MEXC contract fixture — not verified against the live exchange"** and **"Fixture data"**.

`.env` settings added in M1:
- `APP_BASE_URL` builds invite and reset links; it is never taken from request headers.
- `DEV_MAILBOX=enabled` turns on `/dev/mail` (never in production).
- `DATA_ENCRYPTION_KEY` encrypts MFA secrets at rest. It is optional in development, where an insecure built-in key is used with a warning, and required in production.

## Reproduce the admin and investor flows

With `npm run dev` running:

1. **Admin setup.** Sign in as `admin@trendpilot.local`.
   - **Users:** enter a name and email and select *Send invitation*.
   - **Trading Pairs & Defaults:**
     - Type `ETHUSDT` and select *Validate* (try `NOTAREALUSDT` to see a rejection).
     - Adjust the suggested stop, take profit and trailing values, then select *Publish pair*.
   - **Strategy Packages:**
     - Create a package, then select *New version*.
     - Pick 5m or 15m, the ATR length and factor, EMA 200 on or off, the directions and the opposite-signal policy.
     - Tick the approved pairs, then *Save draft* → *Publish v1*.
     - Published versions show a lock and can no longer be edited.
2. **Accept the invite.**
   - Open http://localhost:3000/dev/mail and click the invite link.
   - Set a password of 12+ characters with a letter and a number.
   - Opening the same link again shows "invalid, expired or already used".
3. **Investor setup.**
   - Sign in as the new investor (or Investor A/B).
   - **My Account → Security:**
     - *Set up two-step sign-in*: add the key to an authenticator app and enter the code.
     - Sign out and back in; you will be asked for a code.
     - Sessions can be ended individually or with *Sign out other sessions*.
   - **Trade Settings → Add Token:**
     - Choose a pair. Only strategies approved for that pair are offered.
     - Set direction, order cost (USDT), leverage and margin mode.
     - Set the stop (percent or price, mark or last basis), take profit, trailing (activation, distance, basis), trading days, multiple entries and risk limits.
     - Select *Preview order* for sizing, margin, fees, stop, targets and loss-to-stop from fixture prices.
     - Save, or *Save & Activate*. Use *Pause* / *Resume* per pair.
4. **Pinning.**
   - As admin, publish v2 of the same package.
   - The investor's row still shows `v1 (pinned)`, and the editor explains that v2 is available.
   - The block moves only if the investor selects v2 and saves.
5. **Stale tab.** Open Trade Settings in two tabs and edit the same block in both. The second save is refused with "This block was changed in another window" instead of overwriting.
6. **Admin controls.**
   - Users → *Send reset*: the link appears in `/dev/mail`, expires in 30 minutes and works once.
   - *Sign out everywhere*.
   - *Suspend*: the investor's open page drops to sign-in, and they cannot sign in until reactivated.
   - **Audit Log** shows actor, time, action and result for every step above, with a filter and details.
7. **Forgot password:** *Forgot your password?* on the sign-in page, then use the link in `/dev/mail`.

## Tests

```sh
npm test                                              # unit + API integration (real Postgres: trendpilot_test) + worker
npx playwright install chromium && npm run test:e2e   # production build on :3100 against trendpilot_e2e
npm run typecheck
npm run lint
```

| Suite | Files |
| --- | --- |
| Domain unit (weekdays, order-block schema, risk ceilings, strategy schema, EXE-01 preview math, live guard) | `packages/domain/test/*` |
| DB unit (TOTP RFC 6238 vectors, replay, AES-GCM sealing, contract fixtures) | `packages/db/test/security.test.ts` |
| API: two-investor isolation (A↔B direct ID requests), sign-in, sessions, roles | `apps/web/test/api/isolation.test.ts`, `auth.test.ts` |
| API: invites, resets, MFA, session revocation, suspension, account audit | `apps/web/test/api/accountAccess.test.ts` |
| API: every admin route denied to investors; pairs; drafts, publish, immutability (API + DB trigger), pinning, compatibility; preview isolation; pause/resume across sign-in; audit pagination | `apps/web/test/api/adminCatalog.test.ts` |
| API: settings validation, seven weekdays, concurrency, live disabled; seed contents | `settings.test.ts`, `seed.test.ts` |
| E2E: two investors on one contract | `apps/web/e2e/1-trade-settings.spec.ts` |
| E2E: admin invitation → pair + version publishing → invite acceptance → MFA → settings + preview → admin-action and cross-investor denial → pinning → pause/resume across sign-in → stale tab → audit → suspension | `apps/web/e2e/2-admin-to-investor.spec.ts` |

## M1 acceptance status (SRS §14)

M1 exit condition: *"Isolation, onboarding and configuration tests pass."* Every test below passes. The rows marked **Open** cover requirements that have not been built.

| Check | Status | Notes |
| --- | --- | --- |
| Local setup, migrations, fixture seed (1 admin, 2 investors) | ✅ | 4 migrations, including DB triggers |
| Authentication: sign-in/out, sessions, expiry | ✅ | Opaque cookie token; only its SHA-256 hash is stored |
| IAM-01 invites and resets: expiring, single-use, hashed | ✅ | Invite 72 h, reset 30 min. Resend supersedes. Tokens travel in the URL fragment |
| IAM-01 MFA | ✅ | TOTP, AES-GCM sealed secret, ±1 step, replay-protected, pending-session stage |
| IAM-01 session revocation | ✅ | Own sessions (one or all others), admin sign-out-everywhere, automatic on reset and suspension |
| IAM-01 suspension | ✅ | Revokes sessions and links; blocks sign-in and resume |
| IAM-02 ownership on every settings read/write/preview | ✅ | Unowned ID gives the same 404 as a missing one; denials audited |
| Investors cannot use admin actions | ✅ | 17 admin routes return 403 for investors and 401 without a session |
| UI-02 My Account fixed to the signed-in investor | ✅ | No account switcher |
| UI-03 / CFG-03 Trade Settings controls | ✅ | Pair, compatible strategy, direction, cost, leverage, margin, stop type and basis, TP fixed/split/off, trailing, 7 weekdays, adds, risk caps, pause/resume |
| EXE-01 order preview with fixture data | ✅ | Ask for long, bid for short; rounded down to the step; never sized up; loss-to-stop includes fees |
| Server validation and stale-tab protection | ✅ | Shared zod schemas; If-Match revisions (409/428) on every configuration write |
| CFG-02 strategy versions: 5m/15m, Supertrend, EMA 200, opposite policy | ✅ | Drafts → publish; one draft per package |
| Published versions immutable; settings stay pinned | ✅ | API 409 `IMMUTABLE` plus a DB trigger; moving to a new version is an explicit investor edit |
| UI-05 pairs: type ticker → validate → publish with suggested exits | ✅ | Validated against **local fixtures only** |
| OPS-04 audit: actor, time, action | ✅ | Append-only (DB trigger), cursor-paginated viewer |
| AT-11 live transport cannot be enabled | ✅ | Web and worker refuse to start; LIVE mode returns 422 |
| AT-02 "No account selector; invite/reset expire and work once" | ✅ | |
| AT-02 "Connection changes cannot strand a position; one verified exchange account per investor" | **Open** | CFG-01 exchange connections not built |
| UI-05 TradingView Webhook and Signal Routes screen | **Open** | Route storage and ingestion are M2 |
| UI-05 Operations (feed/connection health, blocked entries, reconciliation) | **Open** | Only the audit log exists; health data arrives with M2/M3 workers |
| UI-01 Dashboard, UI-04 My Trades, Holdings | **Open** | Navigation shows "Soon"; no trade data exists before M2 |
| IAM-02 admin operational-access permission for private records | **Open** | No admin screen exposes investor settings, so no such permission exists yet |
| Hardening | **Open** | RLS or least-privilege DB role; shared rate limiter (currently in-memory); job/outbox tables (ARC-01) |
| Docs | **Open** | Capability matrix, deployment and recovery notes |

### Decisions in this milestone

- **Suspended investors cannot sign in.** This is the conservative reading of IAM-01. Protection on open positions is unaffected once execution exists, and reactivation restores access.
- **MFA is optional.** It is available to admins and investors but not yet enforced for admins. Enforcing it is a one-line policy change once agreed.
- **Pair disabling** blocks new settings and resume for that pair. It never alters saved blocks.
- **Strategy choices for a new block:** the investor sees the latest published version of each package approved for the pair. A saved block keeps its pinned version listed until the investor moves it.

## How ownership and access are enforced

- Identity comes only from the session cookie. Sessions expire and can be revoked. An MFA-pending session can only call `POST /v1/auth/mfa`.
- `orderBlocksFor(db, ownerId)` is the only path to order blocks. Every statement filters on `id AND owner_id`.
- Admin routes call `requireAdmin` and investor routes call `requireInvestor`.
- Request schemas are strict, so owner, timezone, status and revision are never accepted from the client.
- Configuration writes need `If-Match: "<revision>"`.
- The database enforces append-only audit records and immutable published versions with triggers.

## Earlier decisions (still in force)

The SRS governs where it and the PRD differ: no simulated live mode, `Asia/Dhaka` fixed per block, and the block direction must be permitted by the version.

MagicPatterns behaviours that conflicted with the docs were changed, not ported:
- No header account switcher.
- An empty weekday set is allowed.
- Weekdays are stored as `SUN…SAT` codes.
- No simultaneous long and short positions.
- No Trading Account field.
- Decimal strings are used for money and quantities.

Changes from the original plan:
- **Upgrades for security advisories:** Next 16, zod 4, drizzle-orm 0.45 and vitest 5.
- **Database port:** Docker Postgres listens on 5433.
- **E2E server:** E2E runs against a production build.

## M2 slice 1 — TradingView intake and routing

This slice implements SIG-01 to SIG-05 and the ARC-01 durable job queue.

- **Intake.** `POST /v1/webhooks/tradingview/{ingressToken}` accepts the exact SRS bullish and bearish messages.
- **Persistence.** The accepted event and its dispatch job are stored in **one transaction**, and 202 is returned only after commit.
- **Routing.** The worker resolves the route to its contract and strategy lineage, evaluates each matching Paper order block independently, and records **one private outcome per investor**.

### What "Ready for evaluation" means

`READY_FOR_EVALUATION` means the block passed this slice's checks:
- account active;
- Paper mode;
- not paused;
- interval matches the pinned version;
- direction permitted;
- weekday allowed;
- signal still fresh after queueing.

It is **not an approved entry and not a fill**. EMA, market data, position state, risk and sizing come in later slices. Skips carry a reason code: `PAUSED`, `DIRECTION_DISABLED`, `DAY_DISABLED`, `SIGNAL_STALE`, `STRATEGY_MISMATCH`, `ACCOUNT_SUSPENDED`, `LIVE_DISABLED` or `NO_MANAGED_POSITION`.

### Webhook responses (SIG-05)

| HTTP | When |
| --- | --- |
| 202 `{"status":"accepted","eventId":…}` | New event committed with its dispatch job (information-only routes: event only) |
| 200 `{"status":"duplicate","eventId":…}` | Same ingress namespace, route, bar open and action as an accepted event. No new job, even if it now looks stale |
| 400 `MALFORMED` | Not JSON; missing or extra fields; unresolved `{{placeholder}}`; bad interval, timestamp or price |
| 404 `INVALID_INGRESS` | Unknown token. Never stored or logged |
| 413 | Body over 8 KB |
| 422 | `ROUTE_NOT_FOUND`, `ROUTE_AMBIGUOUS`, `MISALIGNED_BAR`, `PRE_CLOSE`, `FUTURE_TIMESTAMP`, `SIGNAL_STALE`, `OUT_OF_ORDER`, `CONFLICTING_SAME_BAR` |
| 503 `PERSISTENCE_UNAVAILABLE` | The database could not commit. Nothing is acknowledged, so TradingView can retry |

Rejections are recorded for operations without the token.

**Ordering:** within one chart stream (exchange, ticker, interval), an older directional flip after a newer accepted one is `OUT_OF_ORDER`. The first accepted flip for a bar wins; the opposite flip for that bar is `CONFLICTING_SAME_BAR`.

### Replay locally

The seed creates the webhook (token = `DEV_INGRESS_TOKEN` in `.env`; only its hash is stored) and two routes: `MEXC:BTCUSDT.P` 15m `BULLISH_FLIP` and `BEARISH_FLIP`, both mapped to BTCUSDT and the fixture strategy package.

1. **Set up two investors on the same contract.** Sign in as Investor A and Investor B and add a BTC/USDT block for each. Use *Save & Activate* for A; leave B's block paused (plain *Save*).
2. **Run with a controlled clock** in three terminals. The clock makes the alert fresh and repeatable; with real time, a 15m bar is only fresh for 120 s after it closes.
   ```sh
   # Terminal 1: web app
   SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run dev
   # Terminal 2: send the exact SRS payload twice
   SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run replay -- --repeat 2
   # Terminal 3: route it (or `npm run worker` to keep polling)
   SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run worker:once
   ```
   In PowerShell, set the clock first: `$env:SIGNAL_TEST_CLOCK='2026-11-08T09:30:03Z'`, then run each command.
3. **Check the expected output.**
   - Replay prints the payload with `bar_open_utc` `2026-11-08T09:15:00Z` and `alert_fired_utc` `2026-11-08T09:30:01Z`, then:
     ```
     #1 POST http://localhost:3000/v1/webhooks/tradingview/tvw_dev_…(redacted)
     → 202 {"status":"accepted","eventId":"<id>","disposition":"DISPATCH",…}
     #2 POST http://localhost:3000/v1/webhooks/tradingview/tvw_dev_…(redacted)
     → 200 {"status":"duplicate","eventId":"<same id>",…}
     ```
   - The worker prints `[worker] job … DONE: event … evaluated=2 new=2 ready=1 skipped=1`. Running it again prints `no runnable jobs`.
4. **Inspect each investor's outcome.**
   - **Investor A**, **Signals** page: *Ready for evaluation · Long*. API: `GET /v1/me/signals` with A's session.
   - **Investor B**, **Signals** page: *Skipped · PAUSED — "This order block is paused."*
   - `GET /v1/me/signals/{id}` with the other investor's outcome ID returns `404 NOT_FOUND`, identical to an unknown ID.
   - **Admin → TradingView Webhook & Routes** shows the event with `READY_FOR_EVALUATION ×1, SKIPPED:PAUSED ×1`: counts only, no investor identities. It also shows the alert templates, routes, recent rejections and *Rotate token*.
5. **Replay a newer bar.** Move the clock 15 minutes for all three commands (e.g. `2026-11-08T09:45:03Z`). Other options: `--action BEARISH_FLIP`, `--bar-open <iso>`, `--content-type text/plain`, `--print`.

`SIGNAL_TEST_CLOCK` affects only signal intake and routing. It is refused under `NODE_ENV=production` unless `ALLOW_SIGNAL_TEST_CLOCK=true` is also set, which only the E2E server does. Never set either in a real deployment.

### Tests for this slice

| Suite | Covers |
| --- | --- |
| `packages/domain/test/signals.test.ts` | Exact payload, malformed variants, timing (alignment, pre-close, future, stale, tolerance), per-investor screening |
| `packages/db/test/clock.test.ts` | Controlled clock and its production guard |
| `apps/web/test/api/webhook.test.ts` | Covered in detail below |
| `apps/web/e2e/3-tradingview-replay.spec.ts` | The real `npm run replay` and `npm run worker:once` against the running app; Signals pages; cross-investor 404; ops view shows counts only and no token |

`apps/web/test/api/webhook.test.ts` covers:
- **Commit and timing:** 202 only after the event and job commit together; all four times stored separately.
- **Pause B:** A is ready, B is `PAUSED`.
- **Duplicates and retries:**
  - A duplicate returns 200 with no new job.
  - A retried job adds no outcome.
  - Lease reclaim, with fencing.
  - A crash mid-dispatch rolls back fully, then exactly one outcome per investor.
- **Rejections and ordering:** conflicting same-bar, out-of-order, stale, malformed, unknown route, misaligned and pre-close; information-only route; ambiguous-route prevention.
- **Concurrency:** 5 concurrent deliveries give one 202 and four 200s.
- **Outcome privacy:** A↔B 404s; admin counts only.
- **Failure and tokens:** a real database outage returns 503; token rotation; no token in logs.

### Still open after this slice

- **Signal source controls:** TradingView source-IP allow-listing and trusted-proxy handling of forwarded addresses need the deployment proxy.
- **Rate limiting:** the webhook limiter is in-memory and single-process.
- **Position-aware decisions (STR-03 to STR-07):** with no positions yet, flips are screened as potential entries, and explicit closes record `NO_MANAGED_POSITION`. Opposite-signal policies, adds and reversals need paper positions.
- **Later M2 checks:** EMA 200 (STR-09), market-data freshness, spread and deviation, risk reservation, sizing, paper adapter and exits.
- **Weekday timing:** the weekday is checked at evaluation. The CFG-04 recheck at order submission arrives with execution.
- **Ordering:** enforced at intake per chart stream. Per-execution-scope serialization (ARC-02) arrives with order intents.
- **Admin paper-only test signals** (SIG-04) are not built.
- **Operations metrics** (queue lag, webhook latency, OPS-04/05) and alerting are not built.
