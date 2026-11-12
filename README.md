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

**Steps 8 and 9 (public MEXC market data in Paper mode; Dashboard, Holdings and reporting): done.** See [Step 8](#step-8--public-mexc-prices-and-closed-candles-in-paper-mode) and [Step 9](#step-9--dashboard-holdings-trade-reporting-and-reconciliation).

**Live order submission is disabled and no live adapter exists.** Paper orders always fill in the paper simulator.

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
     - Set the stop (percent or price, mark or last basis), take profit, Trailing Take Profit (Activate after profit, Trail distance, basis), trading days, multiple entries and risk limits.
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
| UI-03 / CFG-03 Trade Settings controls | ✅ | Pair, compatible strategy, direction, cost, leverage, margin, stop type and basis, TP fixed/split/off, Trailing Take Profit, 7 weekdays, adds, risk caps, pause/resume |
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
| UI-01 Dashboard, UI-04 My Trades, Holdings | **Done (Step 9)** | Dashboard, Holdings, trade reporting; see [Step 9](#step-9--dashboard-holdings-trade-reporting-and-reconciliation). Contract/strategy filters and exports still open |
| IAM-02 admin operational-access permission for private records | **Open** | No admin screen exposes investor settings, so no such permission exists yet |
| Hardening | **Open** | RLS or least-privilege DB role; shared rate limiter (currently in-memory). Job/outbox tables (ARC-01) exist since M2 |
| Docs | **Partly done (Step 10)** | Deployment, operations, backup and restore: [`docs/STAGING.md`](docs/STAGING.md). Capability matrix still open |

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

## M2 slice 2 — paper entries from a confirmed flat state

Blocks that pass the routing screen now go through the full entry evaluation, independently per investor. They use the investor's saved settings and pinned strategy version (STR-01/02, STR-08, STR-09):

- **Scope must be flat.** An open position gives `POSITION_NOT_FLAT`; an unresolved order in the same scope gives `ORDER_UNCERTAIN`.
- **Fresh quote.** No quote, or one older than 15 s, gives `FEED_STALE`.
- **Spread and price deviation** against the TradingView reference price.
- **EMA 200** from consecutive closed candles of the mapped contract and signal timeframe, aligned to the signal bar.
  - Seed = mean of the first 200 closes; then EMA = prev + 2/201 × (close − prev).
  - Long needs close > EMA; Short needs close < EMA.
  - Equality, a gap, too little history or a forming bar blocks the entry (`EMA_FILTERED` / `EMA_UNAVAILABLE`). EMA Off bypasses the filter.
- **Sizing (EXE-01):** order cost × leverage ÷ executable price ÷ contract size, using decimal arithmetic and rounding down to the contract step. Size is never increased to reach the minimum.
- **Risk limits.** The stop must sit before the estimated liquidation price, with a buffer.
- **Funds:** margin plus fee must fit the available paper balance (`INSUFFICIENT_MARGIN`).
- **Weekday and trading window, twice.** The local weekday and the block's optional trading window (Start–End, HH:mm in the block timezone; Start included, End not; a window ending earlier than it starts runs past midnight and belongs to the day it started) are checked at evaluation and again at submission. Outside them the entry is skipped (`DAY_DISABLED` / `OUTSIDE_TRADING_WINDOW`, shown as "Outside trading window" in Signals), or a pending order is cancelled and its reservation released. Exits are never gated.

### How an entry is executed

1. **Dispatch transaction.** Under the investor's paper-account lock, three things commit together: the decision, an **order intent** (stable client order ID, stop included, settings snapshot) with its **margin reservation**, and a `paper.submit` job.
2. **Submit job.**
   - The intent is marked `SUBMITTING`.
   - The **paper simulator** receives the opening order with the stop in the same request. It fills at the fixture ask (Long) or bid (Short) and rests a reduce-only stop for the filled quantity.
   - The platform records the fill, the position and the ledger, then verifies that the stop covers the filled contracts (`PROTECTED`).
3. **After a crash.** A retry first looks the order up at the simulator by client order ID; it never submits twice.
   - Duplicate fills are prevented by venue fill ID.
   - Ledger rows are unique per (account, kind, reference), so margin is reserved and debited exactly once.
   - Ledger and fill rows are append-only.

### Replay the shared-alert demo

This is one alert where Investor A gets a protected paper Long and Investor B gets `DAY_DISABLED`. Use the same fixed clock for every command; in PowerShell, set `$env:SIGNAL_TEST_CLOCK='2026-11-08T09:30:03Z'` once.

```sh
# Terminal 1: web app (2026-11-08 is a Sunday in Asia/Dhaka)
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run dev

# Terminal 2: blocks for A (every day) and B (every day except Sunday), fixture candles and a quote
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run demo:paper -- --reset-paper
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run replay -- --repeat 2       # → 202 accepted, then 200 duplicate
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run worker:once                # → entriesApproved=1, then paper order … FILLED position=…
```

**Restart drill.**
1. Run the worker with `PAPER_SIM_CRASH_AFTER_FILL=1 npm run worker:once` instead of the plain command. The process exits right after the simulated fill.
2. Replay the alert again. It returns a 200 duplicate.
3. Wait 30 s for the lease to expire, then run `npm run worker:once`. It prints `FILLED … [reconciled with simulator]`. There is still exactly one fill, one position and one margin debit.

Use `--reset-paper` only in a development database: it truncates all paper state. If the bar was already used, move the clock 15 minutes later (e.g. `09:45:03Z`) for every command.

**Other fixture cases:**
- `npm run demo:paper -- --market down|flat|gap|none` and `--ema on` (pins both blocks to an EMA 200 version of the same package).
- `npm run market:fixture -- --scenario up|down|flat|gap|none`.

### Where to see it
- **Investor A → My Trades:**
  - The paper balance (wallet, position margin, reserved, available).
  - The BTCUSDT Long with average entry, contracts, margin, leverage, estimated liquidation, and the **stop loss** with its basis and *Protected · covers N*.
  - *Details* opens the trade: the stop's trigger price, basis, covered contracts, venue order and verification time; the opening order with its client order ID and fill; and its ledger rows.
- **Investor A → Signals:** *Paper Long · filled*, with a link to the position.
- **Investor A → My Account:** paper balance.
- **Investor B → Signals:** *Skipped · DAY_DISABLED*. B's My Trades is empty.
- **API:**
  - `GET /v1/me/holdings`, `/v1/me/trades`, `/v1/me/trades/{id}`, `/v1/me/orders`, `/v1/me/orders/{id}`, `/v1/me/ledger`.
  - Another investor's IDs return `404 NOT_FOUND`; admins get 403.

### Tests for this slice

| Suite | Covers |
| --- | --- |
| `packages/domain/test/market.test.ts` | EMA formula against an independent recomputation, 200-close boundary, determinism; missing, forming and gapped history; filter rules incl. equality and Off; every entry-check reason; liquidation estimate |
| `apps/web/test/api/paper.test.ts` | Covered in detail below |
| `apps/web/e2e/4-paper-entry.spec.ts` | The real `demo:paper`, `replay` and `worker:once` commands, a real worker crash after the simulated fill, a duplicate replay and restart; My Trades, trade detail and Signals pages; B's 404s |

`apps/web/test/api/paper.test.ts` covers:
- **The shared alert (A Long, B DAY_DISABLED):**
  - Intent and reservation are committed before submission.
  - Stop in the opening request; stop coverage equals the filled contracts.
  - Exact sizing, fee and margin; ledger reconciliation.
- **Short case.**
- **EMA:** on (above, below, equal, gap, no candles) and off with no history.
- **Other entry checks:** `FEED_STALE`, `INSUFFICIENT_MARGIN`, `POSITION_NOT_FLAT`, and the weekday recheck at submission.
- **Failure handling:** duplicate alert; crash after the simulated fill; re-run dispatch; concurrent submit workers — still one fill, one position and one margin debit.
- **Isolation:** B can't read A's order or trade.

### Still open after this slice
- **Market data:** no live MEXC market data. Candles and quotes are fixtures (`source = FIXTURE`), and there's no stale-stream handling beyond quote age.
- **Positions:** adds and reversals are not built. (Exits and stop triggering arrived in slice 3, below.)
- **Risk:** daily-loss limits and cooldown need realized P&L and exits, so they are recorded as not yet applicable. Cross-margin liquidation is only an isolated-style estimate.
- **Fills:** partial fills, slippage modelling beyond a 0.2 % allowance, funding, and stop re-verification after later changes are not covered.
- **Operations:** no queue-lag or protection alerts and no admin paper-operations view. Admins see outcome counts only.
- **Live order submission** remains disabled; no adapter or credentials exist.

## M2 slice 3 — paper exits (stop loss, fixed TP, close on signal, manual close)

Four exit paths now close paper positions through the same simulator, durable jobs and fixture market data. Live order submission stays disabled.

| Path | Trigger | How it closes |
| --- | --- | --- |
| **Stop loss** | A replayed tick reaches the attached stop **on its saved trigger basis** (mark or last) | The simulator triggers the resting reduce-only stop itself. The platform then records the venue fill (no platform order) |
| **Fixed take profit** | A replayed tick reaches the TP saved with the position (from the confirmed average entry, rounded toward entry) | A `paper.close` job submits a simulated reduce-only market close for the confirmed remaining quantity |
| **Close on signal** | An explicit `CLOSE_LONG` / `CLOSE_SHORT` that matches the side, or an opposite flip when the position's saved policy is `CLOSE_ONLY` | Same market close. `KEEP_OPEN` records `HELD · KEEP_OPEN`. `CLOSE_AND_REVERSE` closes only (`REVERSAL_CLOSE`); the reversal entry is the next slice |
| **Manual close** | *Close at market* in My Trades → `POST /v1/me/positions/{id}/close` with an `Idempotency-Key` | Ownership is checked by the route and again by the worker. A replayed key returns the same command (`GET /v1/me/commands/{id}`) |

**Consistency rules:**
- Exits use the settings saved with the position (`strategy_version_id`, TP price/basis, stop basis), not the block's current settings.
- Pause, disabled weekdays and the EMA filter gate **new entries only**. Exits still run while they are active.
- One unresolved close per position (unique index). A second trigger gets `EXIT_IN_PROGRESS` or is held.
- The close intent is persisted before submission. Remaining quantity is rechecked at the venue. The close is reduce-only, so it can never flip the position; on a flat venue it is `REJECTED · REDUCE_ONLY_NO_POSITION`.
- On a partial fill the stop is resized to exactly the remainder and the position stays open. Only after the venue confirms zero are the stop cancelled and the position marked `CLOSED`.
- Each confirmed fill writes an append-only `position_exits` row with reason, price, contracts, fee, gross realized P&L, released margin (proportional; the final close releases the exact remainder) and remaining contracts. The ledger gets `REALIZED_PNL`, `TRADING_FEE` and `POSITION_MARGIN_RELEASE`.

### Replay the exits demo

Use the same `SIGNAL_TEST_CLOCK` as slice 2 for the entry, then later `--at` / clock values for prices. In PowerShell set each with `$env:SIGNAL_TEST_CLOCK='…'`.

```sh
# Terminal 1: web app
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run dev

# Terminal 2: A (TP 3 %, stop 1.5 %) and B (TP 6 %, stop 2 %), both every day; open both Longs
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run demo:paper -- --reset-paper --profile exits
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run replay
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run worker:once     # → entriesApproved=2

# Fixed TP for A only (A target 66950.5, B target 68900.5)
npm run market:tick -- --price 67000 --at 2026-11-08T09:31:00Z
SIGNAL_TEST_CLOCK=2026-11-08T09:31:00Z npm run worker:once     # → takeProfitsRequested=1, paper close … FILLED filled=153 remaining=0 position CLOSED

# Stop loss for B (stop 63700.5, mark basis)
npm run market:tick -- --price 63600 --at 2026-11-08T09:32:00Z
SIGNAL_TEST_CLOCK=2026-11-08T09:32:00Z npm run worker:once     # → stopsTriggered=1 stopExitsRecorded=1
```

**Variations:**
- **Partial close:** add `--liquidity 100` to a tick. The close fills 100 contracts, the stop is resized to the remainder, and the position stays open. The next close takes the rest.
- **Manual close:** click *Close at market* in My Trades, confirm, then run `npm run worker:once` with a clock at or after the latest tick.
- **Close signal:** `npm run replay -- --action CLOSE_LONG` on the next bar (move the clock 15 minutes).
- **Restart drill:** run the worker with `PAPER_SIM_CRASH_AFTER_FILL=1` after the TP tick. It exits right after the simulated close fill. Wait 30 s for the lease, then run `npm run worker:once`: `FILLED … [reconciled with simulator]`, still one close fill and one margin release.
- `--mark` / `--last` on `market:tick` let the two bases diverge (A's stop uses mark; set a block's stop basis to Last to watch it ignore a mark-only move).

### Where to verify exit reason, remaining quantity and realized P&L
- **My Trades → Closed paper positions** (Paper label): *Exit reason*, *Opened · remaining* (e.g. `153 · 0`), *Realized P&L* (gross), *Fees* (open + close) and *Net*.
- **My Trades → open positions:** remaining contracts, with *of N opened · realized …* after a partial close; the take-profit price; the stop's *Protected · covers N*; and *Close at market*.
- **Trade detail (`/my-trades/{id}`):** Exit reason, *Remaining contracts* `R of N`, realized/net P&L, and an **Exits** table (reason, contracts, price, P&L, fee, margin released, remaining) plus the reduce-only close orders and ledger rows.
- **Signals:** *Paper close · filled* or *Position kept open · KEEP_OPEN* for exit decisions.
- **API:** `GET /v1/me/trades/{id}` (`exits[]`, `closeOrders[]`, `closeReason`, `contracts`, `initialContracts`, `realizedPnlUsdt`, `netRealizedUsdt`), `GET /v1/me/commands/{id}`, `GET /v1/me/ledger`.
- **Database:** `position_exits`, `positions.close_reason / contracts / realized_pnl_usdt`, `paper_account_reconciliation`.

### Tests for this slice

| Suite | Covers |
| --- | --- |
| `packages/domain/test/exits.test.ts` | TP price rounding (Long/Short), TP and stop reach rules, basis selection, realized P&L, proportional and final margin release, signal-exit decisions for every policy |
| `apps/web/test/api/exits.test.ts` | Two investors on BTCUSDT with different TP targets (only A closes; B open and protected); stop loss on mark vs last basis; Short TP and stop; `CLOSE_LONG` while A is paused and the weekday is disabled; opposite flip under `KEEP_OPEN` / `CLOSE_ONLY` / `CLOSE_AND_REVERSE` with no reverse position; manual close (idempotency key required and replayed, per-owner keys, B gets 404, admin 403, `EXIT_IN_PROGRESS`, `POSITION_NOT_OPEN`); partial close with stop resize, then the remainder; TP close racing a venue stop (reduce-only rejection, one exit, one margin release); crash after the simulated close fill plus concurrent re-runs; append-only exits |
| `apps/web/e2e/5-paper-exits.spec.ts` | Real `demo:paper --profile exits`, `replay`, `market:tick` and `worker:once`; a real crash after the close fill and a restart; A's closed trade in My Trades and detail; B's 404 on A's close; B closes from the UI |

### Still open after this slice
- Split TP, trailing stops and close-and-reverse — done in slice 4, below.
- Daily-loss limits and cooldown can now use realized P&L but are not enforced yet.
- No live market data; ticks are fixtures. Funding and slippage models beyond the simulator's top-of-book fill are not built.
- Live order submission remains disabled; no adapter or credentials exist.

## M2 slice 4 — split take profit, trailing exit, close and reverse

> The trailing exit described here is now **Trailing Take Profit**: see [Trailing Take Profit](#trailing-take-profit-replaces-the-trailing-stop) below. Positions opened before that change keep the legacy trailing stop they were saved with.

Builds on the slice 3 exit engine (same simulator, durable jobs and fixture price replay). Every position uses the exit plan and strategy version saved with it at entry. Paper mode only; live order submission stays disabled and no public MEXC market data is used.

**Split take profit (EXT-03).**
- At the confirmed entry fill, each target in the saved plan becomes a `position_targets` row. The row holds the immutable level ID, the trigger price (from the average entry, rounded toward entry) and the target's planned share of the filled quantity, rounded down to the contract step.
- **Allocation (EXT-07).** Trailing Take Profit's **Position to close (%)** (0–100, decimals allowed) is its share of the confirmed opening quantity, rounded down to the contract step. Take Profit, when on, manages the exact rest: 0% leaves everything to Take Profit, 100% everything to Trailing Take Profit, 40% splits 40/60. With trailing off, Take Profit manages the whole position. With Take Profit off, anything Trailing Take Profit does not take stays open under the stop loss and signal or manual closes. A fixed target manages the whole Take Profit share; split targets divide it (their shares total exactly 100%) and the last one gets the exact remainder.
- **Arm, then pull back.** Reaching a target only arms it (persisted on the target row, so it survives worker restarts). A later price strictly back through the target — below it for a Long, above it for a Short — sends a reduce-only market close for that target's unfilled allocation, capped at the position. Positions opened before this rule keep the touch-to-close rule saved with them (`trigger_rule = 'TOUCH'`).
- *Requested* and *filled* quantities are tracked separately. Only confirmed fills move a target forward (`PENDING → REQUESTED → PARTIAL → DONE`). A partly filled target resumes for exactly its remainder on a later price, and only after its earlier order is reconciled.
- After every fill, the stop is resized to the remaining quantity and verified.
- A database trigger stops target progress from ever decreasing and stops a `DONE` target from reopening. Replaying the same price or the same fill repeats nothing.

**Trailing exit (EXT-04)** — now Trailing Take Profit; the mechanics below are shared with the legacy trailing stop.
- **Activation:** the saved activation move from the confirmed average entry, on the saved price basis. Trailing Take Profit always waits for it; only legacy positions can be active from entry.
- **Watermark:** the highest price for a Long and the lowest for a Short.
- **Level:** high minus distance for a Long, low plus distance for a Short. It only tightens; a database trigger refuses any loosening.
- **Persistence:** kind, status, activation time, watermark and level are stored on the position, so a restarted worker continues from them.
- **Trigger:** a software trigger closes at market. Trailing Take Profit closes only the quantity no unfinished target reserves; the legacy trailing stop closes the whole remaining position. The fixed venue stop stays in place as protection while any quantity is open.

**Close and reverse (STR-06).**
- **Close first:** on an opposite flip with saved policy `CLOSE_AND_REVERSE`, the engine sends the market close first. The same event does not evaluate an entry for that block.
- **Wait for terminal:** once the close is terminal, a `paper.reverse` job checks the state:
  - The position is `CLOSED` with zero quantity.
  - The venue reports zero.
  - The old stop is no longer active.
  - No other order is unresolved.
  - If any of these fails, the opposite entry is withheld (`REVERSAL_CLOSE_INCOMPLETE`, `REVERSAL_NOT_FLAT`, `REVERSAL_PROTECTION_UNRECONCILED`, `REVERSAL_ORDERS_UNRESOLVED`). A partial close keeps its remainder protected.
- **Recheck everything:** every entry rule is checked again at that moment:
  - signal expiry, local weekday, pause, direction and account status
  - EMA, quote freshness, margin and sizing
- **Outcome:** a blocked reversal records its reason and stays flat. An approved one goes through the normal paper submit, which attaches the new stop in the same simulated request.
- **No duplicates:** the entry decision is unique per (event, block). An event's exit step only acts on positions that were already open when it arrived, so re-running an older event can never close the new leg.

### Replay commands

Use one fixed clock per command. In PowerShell, set it with `$env:SIGNAL_TEST_CLOCK='…'` before each command instead of the `VAR=… cmd` prefix.

**Split TP and Trailing Take Profit** (A: Trailing Take Profit closes 20% and activates at +3%, trailing 1%, mark price; the two targets split the other 80% — 62.5% of it at +2% and 37.5% at +4%; B: no TP, Trailing Take Profit closes 100%, activates at +1% and trails 1%, last price):

```sh
# Terminal 1
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run dev

# Terminal 2
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run demo:paper -- --reset-paper --profile split
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run replay
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run worker:once        # entriesApproved=2; A targets tp1 66300.5 (76), tp2 67600.5 (47); trailing 30

npm run market:tick -- --price 66400 --at 2026-11-08T09:30:15Z
SIGNAL_TEST_CLOCK=2026-11-08T09:30:15Z npm run worker:once        # targetsArmed=1, takeProfitsRequested=0 (first touch only arms tp1)
npm run market:tick -- --price 66250 --liquidity 50 --at 2026-11-08T09:30:20Z
SIGNAL_TEST_CLOCK=2026-11-08T09:30:20Z npm run worker:once        # pullback: tp1 EXPIRED (PARTIAL_FILL) filled=50 remaining=103
npm run market:tick -- --price 66250 --at 2026-11-08T09:30:30Z
SIGNAL_TEST_CLOCK=2026-11-08T09:30:30Z npm run worker:once        # tp1 FILLED filled=26 remaining=77 (target done)
npm run market:tick -- --price 66250 --at 2026-11-08T09:30:35Z
SIGNAL_TEST_CLOCK=2026-11-08T09:30:35Z npm run worker:once        # takeProfitsRequested=0 (no repeat)
npm run market:tick -- --price 67000 --at 2026-11-08T09:30:40Z
SIGNAL_TEST_CLOCK=2026-11-08T09:30:40Z npm run worker:once        # trailingActivated=1 (A: level 66330; B armed at 66400)
npm run market:tick -- --price 67700 --at 2026-11-08T09:30:50Z
SIGNAL_TEST_CLOCK=2026-11-08T09:30:50Z npm run worker:once        # tp2 armed (targetsArmed=1); trailing level 67023
npm run market:tick -- --price 67500 --at 2026-11-08T09:30:55Z
SIGNAL_TEST_CLOCK=2026-11-08T09:30:55Z npm run worker:once        # pullback: tp2 FILLED filled=47 remaining=30
npm run market:tick -- --price 67000 --at 2026-11-08T09:31:00Z
SIGNAL_TEST_CLOCK=2026-11-08T09:31:00Z npm run worker:once        # trailingTakeProfitsRequested=2 → A and B closed (TRAILING_TAKE_PROFIT)
```

Each `worker:once` is a new process, so trailing state that carries across runs has survived a restart. For a Short, run `demo:paper -- --market down --profile split` and `replay -- --action BEARISH_FLIP`.

**Close and reverse** (both blocks pinned to a `CLOSE_AND_REVERSE` version; B trades Long only, so B's reversal stays flat):

```sh
# Terminal 1: open the Longs on the 09:15 bar
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run dev
# Terminal 2
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run demo:paper -- --reset-paper --profile reverse
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run replay
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run worker:once        # entriesApproved=2

# Terminal 1: restart the web app on the next bar (an opposite flip on the same bar is rejected: CONFLICTING_SAME_BAR)
SIGNAL_TEST_CLOCK=2026-11-08T09:45:03Z npm run dev
# Terminal 2
npm run market:tick -- --price 64900 --at 2026-11-08T09:45:20Z
SIGNAL_TEST_CLOCK=2026-11-08T09:45:03Z npm run replay -- --action BEARISH_FLIP
SIGNAL_TEST_CLOCK=2026-11-08T09:45:20Z npm run worker:once
#   exitsRequested=2 exitsHeld=0 reversalsPending=2
#   paper close … FILLED … position CLOSED exit=REVERSAL_CLOSE reversal queued   (×2)
#   reversal for close … ENTRY_APPROVED order=…        (A)
#   reversal for close … SKIPPED (DIRECTION_DISABLED)  (B)
#   paper order … FILLED position=…                    (A's Short, stop attached)
SIGNAL_TEST_CLOCK=2026-11-08T09:45:03Z npm run replay -- --action BEARISH_FLIP   # → 200 duplicate
SIGNAL_TEST_CLOCK=2026-11-08T09:45:20Z npm run worker:once        # no runnable jobs
```

Variations:
- **Incomplete close:** add `--liquidity 100` to the 09:45:20 tick. The close fills 100 of 153, the reversal is `SKIPPED (REVERSAL_CLOSE_INCOMPLETE)`, and the Long keeps 53 contracts with its stop resized to 53.
- **Expired signal:** run that worker with a clock more than 120 s after the bar close (e.g. `09:47:30Z`, with a tick at that time) to get `SIGNAL_STALE`.
- **Paused block:** pause the block after the replay to get `PAUSED`.

### Where to verify
- **Target progress:**
  - *My Trades* → open row → **Take profit · trailing take profit** shows "N of M targets filled" and, for each target, its trigger price, status and filled/planned quantity.
  - *Trade detail* → **Take-profit targets** lists, per target, the trigger and basis, planned, requested and filled quantities, and status.
  - API: `GET /v1/me/trades/{id}` → `targets[]`. Database: `position_targets`.
- **Remaining stop coverage:**
  - *My Trades* → **Stop loss** shows *Protected · covers N*, where N equals the remaining contracts.
  - *Trade detail* → **Stop loss** shows the covered contracts, and **Remaining contracts** shows `R of N`.
  - The resting order is `sim_orders` (`STOP_MARKET`, `contracts`), and the platform view is `positions.stop_contracts`.
- **Trailing Take Profit:**
  - *Holdings* → **Trailing take profit** shows *Waiting for activation* (with the activation price) or *Active* (closing level and best price), the contracts it manages and the trail distance.
  - *My Trades* shows "Trailing take profit: Active · closes at L (best W) · N contracts".
  - *Trade detail* → **Trailing take profit** shows state, activation price, trail distance and basis, best price, closing level, the quantity it manages and activation time. Exits closed by it read *Trailing take profit* (`TRAILING_TAKE_PROFIT`).
  - API: `trailing` (with `kind`, `status`, `contracts`) on the trade and on each holding. Database: the `positions.trailing_*` columns.
- **Each reversal outcome:**
  - *Signals*: *Close and reverse · filled*, together with either *Reversed · Paper Short filled* or *Stayed flat · REASON* (or *Opening leg pending*).
  - *Trade detail* of the closed position → **Close and reverse**: the outcome, reason text and a link to the new position. The new position links back to the one it replaced.
  - API: `reversal` / `reversedFromPositionId` on `GET /v1/me/trades/{id}`, and `exit` + `entry` on `GET /v1/me/signals`.
  - Database: the `signal_decisions` row with step `ENTRY_V1` has `detail.reversal = true`, `fromPositionId` and `closeState`.

### Tests for this slice

| Suite | Covers |
| --- | --- |
| `packages/domain/test/exits.test.ts` | Target planning (full and partial splits, fixed, off), target status from fills, trailing activation and level rounding, and the Long/Short watermark, tighten-only rule and trigger |
| `packages/domain/test/orderBlock.test.ts` | A split below 100% is valid only with Trailing Take Profit enabled; above 100% is invalid; targets closing 100% leave nothing for it; Activate after profit and Trail distance are both required |
| `apps/web/test/api/splitTrailing.test.ts` | Long split + trailing remainder; partial target fill and its resume; no repeat on the same price or a duplicate tick; activation on the saved basis; restart (a fresh worker pool re-runs a crashed tick from persisted state); tighten-only (including the DB guard); Trailing Take Profit close of the remainder with zero confirmed and the stop cleared; target progress API and isolation; a legacy Short position's trailing stop from entry on LAST keeps working; competing triggers on a legacy position (target in flight vs trailing vs manual close vs venue stop; a stop beating a pending target); target DB guard |
| `apps/web/test/api/reversal.test.ts` | Successful close-then-open with the new stop in the same simulated request; owner views and isolation; replaying the same event, plus re-running dispatch, close, reverse and submit concurrently, creates no duplicate fill, entry or position; partial close withholds and keeps the remainder protected; an uncertain close (venue stop first, close refused) withholds; a close crossing local midnight into a disabled day gives `DAY_DISABLED`; paused gives `PAUSED`; expired gives `SIGNAL_STALE` |
| `apps/web/e2e/6-split-trailing-reverse.spec.ts` | The real `demo:paper --profile split/reverse`, `replay`, `market:tick` and `worker:once` commands; the My Trades, trade detail and Signals views for both investors |

### Still open after this slice
- **Market data:** public MEXC market data was added in Step 8 (below). Replays still use fixtures (`source = FIXTURE`).
- **Trailing:** Trailing Take Profit is a software trigger; native venue trailing orders are not modelled.
- **Minimum residuals:** there is no special handling for exchange minimum residuals beyond rounding targets down to the contract step.
- **Risk:** daily-loss limits and cooldown are not enforced yet.
- **Live trading:** live order submission remains disabled; no adapter or credentials exist.

## Step 8 — public MEXC prices and closed candles in Paper mode

Paper mode can now run on live **public** MEXC Futures market data. Order execution is unchanged: every order still fills in the paper simulator. Live order submission stays disabled; the web app, the worker and the feed all check `LIVE_ORDER_TRANSPORT=disabled`.

**Feed** (`npm run market:feed`, or `npm run market:feed -- --once` for one cycle):
- **Endpoints:** public only — `ping`, `ticker`, `kline/{symbol}` (Min5, Min15), `detail` and `funding_rate/history` under `https://contract.mexc.com/api/v1/contract/`. The adapter refuses any other path before sending, and it sends no key, signature or cookie.
- **Coverage:** every published contract plus any contract with an open position. Symbols come from each instrument's `exchange_symbol` (for example `BTC_USDT`).
- **Quotes:** bid/ask, mark (`fairPrice`) and last. Each quote goes to `market_quotes` with `source = 'MEXC_PUBLIC'` and queues the same `market.tick` job a fixture tick does, so stops, TP targets and trailing run on it.
- **Candles:** closed 5m and 15m bars go to `market_candles` (`source = 'MEXC_PUBLIC'`). A bar counts as closed only 3 s after its close on the exchange clock, so a forming bar is never stored. The first run backfills 300 bars per interval; later syncs re-read the last two bars to catch late revisions.
- **EMA:** EMA 200 never mixes sources. The consecutive run stops at a candle from a different source than the signal bar.
- **Health (MKT-02):**
  - *Stale:* the exchange price has not updated for 15 s. Stale quotes are not written, and entries are blocked by `FEED_STALE`.
  - *Down:* backoff per contract (1 s doubling to 60 s, ±20 % jitter).
  - *Clock skew:* the offset is measured from `ping`. Quotes are mapped to the local clock; beyond ±5 s none are written.
  - *Gaps:* detected and backfilled. A bar the exchange cannot supply is recorded once as `GAP_UNRESOLVED`.
  - *Recovery:* after an outage the feed records an `UNVERIFIED_INTERVAL` window, in which stop or target crossings could not be observed, and continues from the current price. Nothing is filled retroactively.
  - *Symbols:* an unmapped or unknown symbol is `SYMBOL_UNAVAILABLE`. Contract-spec differences from the public detail are flagged as `CONTRACT_MISMATCH`.
  - State is kept in `market_feed_status` and history in `market_feed_events`, so a restarted feed continues where it stopped.
- **Labels:**
  - The order preview shows *MEXC public price* when a fresh public quote exists, otherwise *Fixture data*.
  - Entry decisions record `checks.quote.source` and `checks.ema.source`.
  - Trade detail shows *Entry price data*.
  - Admins see **Market Data Feed** (`/admin/market-data`, `GET /v1/admin/market-feeds`): per contract, the state, freshness and current price source, plus recent feed events. A stopped feed shows *Not reporting*.
- **Fixtures:** replays and tests keep `source = 'FIXTURE'` (`market:fixture`, `market:tick`, `demo:paper`). The feed refuses to start while `SIGNAL_TEST_CLOCK` is set; fixture replays don't need it. Tests never use the network: they use recorded responses in `packages/db/test/fixtures/mexc-public/` and an in-process stub exchange.

## Step 9 — Dashboard, Holdings, trade reporting and reconciliation

**Where:**
- *Dashboard* (`/dashboard`, `GET /v1/me/dashboard[?date=YYYY-MM-DD]`):
  - available balance, used margin, order reserve and equity (wallet + unrealized);
  - unrealized P&L (mark) and open positions;
  - for the selected day: gross realized, fees (entry and exit), simulated funding, net realized and fill counts;
  - the last price update with a stale flag, a Paper label and a ledger check.
- *My Account → Holdings* (`GET /v1/me/holdings`): for each open position, the contract, side, remaining of initial contracts, notional, entry, current mark and last (with source and time), stop coverage, unrealized P&L and liquidation. Liquidation is shown only as the simulator's isolated-margin estimate and labelled *Estimated*; otherwise it shows *Unavailable*.
- *Trade detail* (`/my-trades/{id}`): entry and exit fills, partial exits, fees, a **Funding (simulated)** table, net realized including funding, the exit reason and a link to the triggering signal.
- *Signals*: each investor still sees only their own decisions and skip reasons (`DAY_DISABLED`, `EMA_FILTERED`, `FEED_STALE`, …).

**Rules (REP-02/03/04):**
- **Sources of truth:** confirmed paper fills, booked funding and the paper ledger.
  - Opening fees come from opening-order fills. Closing fees and realized P&L come from `position_exits`. Each is counted once.
  - Margin postings and releases, and the opening balance, are balance movements and never P&L.
- **Reporting day:** a calendar day in the investor's reporting timezone (Asia/Dhaka by default, so one day runs from 18:00 UTC to 18:00 UTC). Realized results count on the fill date, funding on the settlement time.
- **Net realized** = gross realized − fees + booked funding.
- **Funding:**
  - Booked only from a **settled** rate: public `funding_rate/history`, or `npm run market:funding` as a fixture. A predicted rate is never booked.
  - Applies to every paper position open at a settlement (every 8 h, UTC), on the contracts held then, at the newest mark price within 15 minutes before the settlement.
  - Paid funding is negative, received funding positive.
  - Booked once per position and settlement (a `paper_funding` unique key plus a ledger key). A repeated rate or a re-delivered job books nothing.
  - **Status:** `NONE_DUE` is a real zero (no position was open at a settlement). `UNAVAILABLE` means funding was due but no settled rate or mark price is recorded; the amount is null, never 0. `INCOMPLETE` means partly booked.
- **Missing or stale prices:** a position without a price shows *Unavailable*, and unrealized P&L and equity are null. A price older than 15 s is shown with *Stale*.
- **Reconciliation:**
  - Wallet, margin and reserve each equal their ledger bucket.
  - The realized P&L ledger equals the exits.
  - The fee ledger equals opening plus closing fees.
  - The funding ledger equals booked funding.
- **Ownership:** every `/v1/me/*` route uses the session owner only. Another investor's trade ID returns 404, and any `ownerId` parameter is ignored.

### Reproduce the dashboard totals

```sh
# Terminal 1 (web app pinned to 09:30:03Z = 15:30 in Dhaka)
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run dev
# Terminal 2
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run demo:paper -- --reset-paper --profile exits   # A: TP 3 %, B: TP 6 %
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run replay
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run worker:once        # entriesApproved=2 (A 153 contracts, B 38)
npm run market:tick -- --price 67000 --at 2026-11-08T09:31:00Z
SIGNAL_TEST_CLOCK=2026-11-08T09:31:00Z npm run worker:once        # A closes by TAKE_PROFIT; B stays open
```

Sign in as each investor and open **Dashboard**, **My Account → Holdings** and **My Trades**.

To book funding, restart the web app with `SIGNAL_TEST_CLOCK=2026-11-08T16:00:10Z`, then run:

```sh
npm run market:tick -- --price 65500 --at 2026-11-08T15:59:50Z
SIGNAL_TEST_CLOCK=2026-11-08T15:59:50Z npm run worker:once
npm run market:funding -- --rate 0.0001 --at 2026-11-08T16:00:00Z
SIGNAL_TEST_CLOCK=2026-11-08T16:00:10Z npm run worker:once        # funding … positions=1 booked=1 (B only; A is flat)
npm run market:funding -- --rate 0.0001 --at 2026-11-08T16:00:00Z   # (already recorded): nothing new
```

B's Dashboard then shows funding *Booked*, and B's trade lists it.

### Tests for Steps 8 and 9

| Suite | Covers |
| --- | --- |
| `packages/domain/test/marketFeed.test.ts` | Closed-bar rule (never a forming bar), gap ranges, backoff, clock offset, quote sanity, freshness, EMA source isolation |
| `packages/domain/test/reporting.test.ts` | Asia/Dhaka day bounds and DST days, unrealized P&L and funding signs, settlement times, funding status, net realized |
| `packages/db/test/mexcPublic.test.ts` | Recorded MEXC responses (ticker, klines, ping, detail, funding history); the public-path allowlist; no credentials sent; HTTP, API and network errors |
| `apps/worker/test/feedGuard.test.ts` | The feed refuses a fixed clock and an enabled live transport |
| `apps/web/test/api/marketFeed.test.ts` | Public data drives a paper entry (EMA on public candles), tick jobs and a stop-loss exit; incremental sync, revisions and gaps; outage, backoff and recovery; stale prices; clock skew; symbol mapping; restart; settled funding sync; the admin feed API |
| `apps/web/test/api/reporting.test.ts` | Holdings and dashboard; stale and missing prices; a partial exit and a duplicate tick; funding booked once (duplicate rate and job); a close after local midnight; unavailable vs zero funding; ledger reconciliation; ownership |
| `apps/web/e2e/7-reporting-isolation.spec.ts` | Two investors on the same token with different sizes and exits: Dashboard totals vs the database, Holdings, trade detail, cross-investor 404s, own signal decisions |

## Step 10 — Paper release: operations, staging and recovery

- **Operations** (`/admin/operations`, `GET /v1/admin/operations`): database, worker and market-feed liveness (heartbeats in `service_heartbeats`), job queue (pending, running, due backlog, failed/DEAD with errors), feed state and events, and alerts in text. `GET /v1/health` is a public, data-free liveness check.
- **Retention:** the worker removes finished jobs and quotes older than `JOB_RETENTION_DAYS` / `QUOTE_RETENTION_DAYS` (default 7) every hour. Pending, running and failed jobs, candles, fills, exits, funding and the ledger are never pruned.
- **Fresh deployments:** `npm run ops:bootstrap-admin` creates the first administrator (refused once one exists) and prints a single-use invite link; *Create webhook* in TradingView Webhook & Routes issues the first webhook URL; `npm run ops:mail` relays captured invite/reset mail (no SMTP in this build).
- **Staging:** `Dockerfile`, `docker-compose.staging.yml` (db, migrate, web, worker, feed, Caddy HTTPS), `.env.staging.example`, `npm run staging:smoke` (HTTPS webhook smoke test) and `scripts/backup-restore-drill.sh`. Runbook: [`docs/STAGING.md`](docs/STAGING.md).
- **Tests:** `apps/web/test/api/operations.test.ts` (health, admin-only operations, heartbeats, a DEAD job and a DOWN feed surfacing, first-webhook creation, retention).

## Step 11 — private MEXC Futures adapter (live activation still disabled)

- **Exchange interface:** the paper entry, exit and reversal flows now call an `ExecutionVenue` (`packages/db/src/venue/`). PAPER resolves to the paper simulator (`paperVenue`, unchanged behaviour); LIVE resolves through `openLiveOrderTransport`, which refuses in every environment of this build. Durable `order_intents` and the existing worker drive both.
- **Adapter:** `packages/db/src/live/` — server-side signing (HMAC-SHA256, `ApiKey`/`Request-Time`/`Signature`), a READ_ONLY transport (allowlisted GETs) and an ORDERS transport that cannot be constructed here, normalization of balances, positions, orders, fills (de-duplicated by deal ID) and stop orders, and `mexcVenue` (open with `stopLossPrice` in the same request, reduce-only closes that cannot flip, stop resize after a partial close).
- **Gate:** every order needs its capability verified on a live pilot (`capabilities.ts`); nothing is, so the adapter refuses every order without contacting MEXC.
- **Execution safety added for live venues:** a fill whose stop is not verified queues an immediate emergency close (`PROTECTION_FAILURE`); an uncertain submission is reconciled by client order ID and never resent blind (`reconcileGraceMs`); a stop replaced by the venue updates the position's stop reference.
- **Read-only account check:** `npm run ops:mexc-readonly-check` (pending: no authorized read-only account is configured).
- **Endpoints, fields, documentation gaps, capability matrix and the Step 12 checklist:** [`docs/MEXC_PRIVATE_ADAPTER.md`](docs/MEXC_PRIVATE_ADAPTER.md).
- **Tests:** `packages/db/test/mexcPrivate.test.ts` (signing, refusal in Paper/Demo/replay/CI, read-only transport, normalization, gate, source scan) and `apps/web/test/api/liveAdapter.test.ts` (the real alert → intent → worker flow against a mocked MEXC: attached stop, missing/failed stops, rejections, partial fills, duplicate deals, timeouts before/after acceptance, failed lookups, capped closes, stop resize and auto-shrink, rejected closes).

## Step 12 — live pilot preparation (dry run only; live submission disabled)

- **Pilot scope:** `live_pilots` (migration `0014`) allowlists one investor, one MEXC account reference (never a key) and one contract, with operator-approved limits (max contracts and notional per order, max leverage, max exposure). Adds and automatic reversal are off by database constraint; only one pilot can be open.
- **Two authorizations:** platform approval (`POST /v1/admin/live-pilot/approve`, refused until six pre-pilot checks are recorded with evidence) and explicit investor activation (`POST /v1/me/live-pilot/activate`, allowlisted investor only, block must fit the limits). Every action is audited.
- **Guard:** `pilotGuardedVenue` wraps the MEXC adapter: opening orders pass the allowlist, approvals, activation, halt and limits; closes, stop resizes and lookups are never gated. A missing stop or an uncertain submission halts new entries automatically; only an operator resumes, and not while an order is unresolved or a position unprotected.
- **Readiness:** `GET /v1/admin/live-pilot` lists every item for the first supervised trade and for expansion (today: not ready — see the runbook).
- **Dry run:** `apps/web/test/api/pilotRehearsal.test.ts` runs the planned flow against mocked MEXC responses and writes `test-results/pilot-rehearsal.md` (redacted requests, results, reconciliation, readiness).
- **Runbook:** [`docs/LIVE_PILOT_RUNBOOK.md`](docs/LIVE_PILOT_RUNBOOK.md).

## Admin → Settings → Mail Box (outgoing email)

- **Where:** Admin menu → **Settings** → **Mail Box** (`/admin/settings/mail-box`). Administrators only; API `GET|PUT /v1/admin/settings/mail` and `POST /v1/admin/settings/mail/test`.
- **Settings:** SMTP host, port, security (STARTTLS or implicit TLS; plain SMTP is not offered), username, password or app password, sender name and email, optional Reply-To. Validated server-side; saved with optimistic concurrency (`If-Match`).
- **Password:** sealed with the platform secret box (AES-256-GCM, `DATA_ENCRYPTION_KEY`) in `mail_settings`. Never returned, logged or audited; the page shows only whether one is configured. A blank password keeps the stored one; **Remove** clears it.
- **Send Test Email:** sends one message with the saved settings and shows the server's reply or a redacted error, plus the last test time and result. Limited to 5 per admin per 15 minutes. Settings changes and test attempts are audited (`ADMIN_MAIL_SETTINGS_UPDATE`, `ADMIN_MAIL_TEST_SEND`) without credentials.
- **Delivery:** invitations, password resets and notices are still written to `email_outbox` in the same transaction as the change. `EMAIL_DELIVERY=capture` (default outside production; tests and e2e) stores them only, so `/dev/mail` and `npm run ops:mail` keep working. `EMAIL_DELIVERY=smtp` (default in production) also queues an `email.deliver` job; the worker sends it in a separate loop so mail never delays trading jobs. Results: `SENT`, retried on connection/timeout/4xx, or `FAILED` with the reason (including "SMTP is not configured"), shown under **Delivery** on the Mail Box page.
- **Migration:** `0015_m5_mail_settings` (new `mail_settings` table; `email_outbox` delivery columns). Run `npm run db:migrate`.
- **Tests:** `apps/web/test/api/mailBox.test.ts` (mocked SMTP), `apps/web/e2e/8-mail-box-settings.spec.ts`.

## Trailing Take Profit (replaces the trailing stop)

The trailing exit is now **Trailing Take Profit**. It locks in profit after an explicit favourable move; it is never active from entry, so it can no longer close a position at a loss straight after entry. Paper mode only; live order submission stays disabled.

**Settings (Trade Settings → Exits).**
- **Activate after profit (%)** and **Trail distance (%)** are both required when it is on, plus the trigger basis (mark or last). Both percentages are price movement from the confirmed average entry, before fees and leverage. The activation value is always entered by the investor; it is never assumed or derived from the trail distance.
- The fixed **Stop Loss** stays mandatory and is attached to the opening order request. It protects the whole position before and after Trailing Take Profit activates.
- **Quantity:** take-profit targets close their shares; Trailing Take Profit manages the rest. Split targets below 100% put the remainder on it; a Fixed target can close less than 100% when it is on; with TP off it manages 100%. Targets that close 100% leave it nothing, so that combination is refused. The editor and the order preview show which quantity each exit manages.
- New drafts start with it off (the pair's suggested trail distance is prefilled): the investor chooses the activation value and the quantity split.

**Behaviour.**
- **Long:** arms only once price has risen by the activation percentage (activation price rounded up to the tick), then tracks the highest price. **Short:** arms only once price has fallen by it (rounded down), then tracks the lowest price.
- After activation, a pullback of the trail distance from that high or low triggers a reduce-only market close for the quantity no unfinished target reserves. Once that quantity is closed it is *Done*; it never closes target quantity, and targets never close its quantity.
- State (kind, status, activation price, best price, level) is stored on the position, so a restarted worker continues from it.
- *Holdings* shows *Waiting for activation* or *Active*; *My Trades* records the exit reason `TRAILING_TAKE_PROFIT`.

**Existing data (migration `0018_m8_trailing_take_profit`).**
- **Open positions keep their saved behaviour.** Every position that already had a trailing exit is marked `trailing_kind = 'STOP'` and keeps working as the legacy trailing stop (closes the whole remaining position, reason `TRAILING_STOP`). New entries get `trailing_kind = 'TAKE_PROFIT'`.
- **Order blocks saved with the old trailing stop on are not converted automatically.** They are flagged `trailing_conversion_required`; their new entries are held (decision reason `TRAILING_CONVERSION_REQUIRED`) and Trade Settings shows *Needs update*. Saving the block with Trailing Take Profit settings (explicit activation value) or with trailing off converts it; an unrelated edit cannot skip the activation value. The conversion is audited (`trailingConvertedToTakeProfit`).

**Tests.**

| Suite | Covers |
| --- | --- |
| `packages/domain/test/exits.test.ts` | The BTC example (entry 74788.4, activation 0.3 %, trail 0.1 %): activation prices; a direct move to 74863.2 does not trigger (the legacy from-entry stop would have); a favourable move short of activation then a rebound never arms; Short and Long arming, tracking and the pullback trigger; the quantity it manages next to targets |
| `packages/domain/test/orderBlock.test.ts`, `preview.test.ts` | Both values required; quantity rules (Fixed below 100 %, split remainder, 100 % refused); preview quantities per exit and activation rounding |
| `apps/web/test/api/trailingTakeProfit.test.ts` | Paper, end to end: the Short example with the stop attached to the opening order, the 74863.2 move, below-activation rebound, activation, restart after activation (fresh worker, re-run tick), pullback close as `TRAILING_TAKE_PROFIT` in profit; the Long equivalent; split targets with Trailing Take Profit on the remainder (66 + 28 + 39 = 133, nothing closed twice; *Done* state); legacy block migration flag, held entries, unrelated edit refused, explicit conversion, next entry opens with Trailing Take Profit |
| `apps/web/test/api/splitTrailing.test.ts` | Trailing Take Profit on a split remainder; legacy positions (trailing stop from entry, competing triggers) keep their saved behaviour |
| `apps/web/e2e/6-split-trailing-reverse.spec.ts` | The replay commands above, with the My Trades and trade detail views (state, closing level, managed contracts) |

## Live mode — Paper and Live in one application (2026-11-12)

TrendPilot is one application with two modes. **Paper** uses the simulator and an isolated paper balance. **Live** sends real orders to each investor's own MEXC Futures account. Both modes use:
- the same TradingView alerts and strategy rules;
- the same public MEXC price feed;
- the same durable order intents and worker.

What differs per mode:
- **Account.** Balance, orders, fills, positions and ledger are separate (`paper_accounts` is keyed by owner and mode).
- **Execution adapter.** Paper uses the simulator; Live uses the MEXC adapter behind the Live guard.

**Live ships switched OFF.** A Live opening order needs all of the following (`docs/LIVE_PILOT_RUNBOOK.md` §0):
- `LIVE_ORDER_TRANSPORT=enabled` in a production process;
- the admin platform switch, which cannot be turned on before the order capabilities are recorded;
- a verified MEXC connection, approved by an admin with limits (contracts per order, notional per order, leverage, exposure);
- the investor's own activation;
- the contract on the Live allowlist.

The worker re-checks every gate right before it sends. Stops, take profits, trailing take profit, close-on-signal, manual and emergency closes are never gated.

| Area | Where |
| --- | --- |
| Investor: connect MEXC, activate or deactivate, halt | Sidebar → **Live Trading** (`/live-trading`); API `/v1/me/live`, `/v1/me/exchange-connection` (+ `/verify`), `/v1/me/live/{activate,deactivate,halt}` |
| Investor: Live order blocks | Trade Settings → Trading mode **Live (MEXC)** (one block per pair and mode) |
| Investor: results | Dashboard, My Holdings and My Trades each have **Paper / Live** tabs (`?mode=live`). Paper and Live are never summed |
| Admin: switch, halt, capability evidence, approvals and limits, contract allowlist, sync now, drift | Admin → **Live Trading** (`/admin/live`); API `/v1/admin/live/**` |
| Monitoring | Admin → Operations (Live alerts), `/v1/health` (`liveOrderTransport`, `mode`) |
| Private sync | Worker, every `LIVE_SYNC_MS` (default 30 s) |

- **Credentials.** API keys are sealed with AES-256-GCM (`DATA_ENCRYPTION_KEY`) and opened only on the server to sign requests. No API returns them; only `…1234` is shown.
- **Migration.** `0020_m10_live_mode` adds:
  - `exchange_connections` and `live_control` (with the switch Off);
  - `instruments.live_allowed`;
  - `paper_accounts.mode` and the synced exchange balance;
  - the synced exchange fields on `positions`.

  The routing screen no longer skips LIVE blocks with `LIVE_DISABLED`; Live entries are gated by the Live rules instead. An ineligible Live entry is recorded as `LIVE_NOT_ELIGIBLE` with a `liveReason`.

**Tests:**
- `apps/web/test/api/liveMode.test.ts` (14 scenarios, mocked MEXC per investor):
  - Off by default and sealed keys;
  - attached stop on a partial fill, and reduce-only close;
  - stop resize after a partial take profit;
  - operator, investor and worker-time halts;
  - missing stop leading to an emergency close;
  - uncertain submission (reconciled, or never resent);
  - sync of the balance, an exchange-side stop, a manual MEXC close, and drift;
  - two investors on one contract;
  - transport off;
  - limits.
- `packages/domain/test/live.test.ts`: every gate.
- `packages/domain/test/liveTransport.test.ts`: `enabled` is accepted only in production.
- `apps/web/e2e/10-live-off-by-default.spec.ts`: the Live UI is Off by default; Paper and Live tabs.

## Per-side Take Profit (Long and Short) — 2026-11-12

Each token's Trade Settings now hold two independent Take Profit configurations, `takeProfitLong` and `takeProfitShort`. Each can be Fixed, Split (2–3 targets) or Off, with its own target percentages.
- The editor shows a **Long take profit** and a **Short take profit** section. With a one-sided direction only the applicable section is shown, and the other side's saved values are kept: changing the direction never discards them.
- Validation runs per enabled side and reports inline under `takeProfitLong.*` or `takeProfitShort.*` on blur and on Save.
- Clearing a percentage with Backspace leaves the editor open with a field message.

**At entry**
- The actual side of the entry selects the configuration. It is saved with the intent and the position as `settingsSnapshot.block.takeProfit`, together with `takeProfitSide`.
- Targets are computed from the confirmed average entry: above it for a Long, below it for a Short.
- After a close-and-reverse, the new position uses its new side's configuration.

**Exits are unchanged**
- Each target, including every split target, arms on the favourable touch. It submits a market close on a later pullback through the target: back down for a Long, back up for a Short.
- Take Profit manages what is left after Trailing Take Profit's *Position to close (%)*. With 40 % trailing, the side's Take Profit manages 60 %, and split shares divide that 60 %.
- Partial fills, stop resizing and stop coverage follow the existing exit workflow.

**Existing data**
- Migration `0021_m11_take_profit_per_side` keeps `take_profit` as the Long configuration and adds `take_profit_short`, both starting from the current shared configuration.
- Open positions keep the exit plan saved with them.
- API clients that still send one `takeProfit` set both sides.

**Where to see it**
- **Order preview:** each side shows its plan (Fixed, Split or Off) and how much it manages, with targets marked above or below entry.
- **My Holdings / My Trades detail:** the saved plan, e.g. "Short take profit · Split · targets below entry".

**Tests**
- `apps/web/test/api/takeProfitPerSide.test.ts` (Paper, 9 scenarios):
  - Long Fixed / Short Split on one token, with 40 % trailing;
  - a reversal;
  - Short arm-then-rebound with stop coverage of the remainder;
  - saved plans in holdings and trade detail;
  - later edits not touching open positions;
  - Long Off;
  - legacy shared input;
  - a direction change keeping both sides;
  - the preview.
- `packages/domain/test/orderBlock.test.ts`: per-side validation and Backspace.
- `apps/web/e2e/99-take-profit-per-side.spec.ts`: the editor in the browser.
