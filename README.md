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
- **Weekday, twice.** The local weekday is checked at evaluation and again at submission. Crossing into a disabled day cancels the order and releases the reservation.

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

## M2 slice 4 — split take profit, trailing stop, close and reverse

Builds on the slice 3 exit engine (same simulator, durable jobs and fixture price replay). Every position uses the exit plan and strategy version saved with it at entry. Paper mode only; live order submission stays disabled and no public MEXC market data is used.

**Split take profit (EXT-03).**
- At the confirmed entry fill, each target in the saved plan becomes a `position_targets` row. The row holds the immutable level ID, the trigger price (from the average entry, rounded toward entry) and the target's planned share of the filled quantity, rounded down to the contract step.
- A plan that allocates 100% gives the last target the exact remainder. A plan below 100% is valid only with the trailing stop enabled, which manages the rest (EXT-07). A fixed TP is a single 100% target.
- When a target is reached on its basis, the engine sends a reduce-only market close for that target's remaining quantity, capped at the position.
- *Requested* and *filled* quantities are tracked separately. Only confirmed fills move a target forward (`PENDING → REQUESTED → PARTIAL → DONE`). A partly filled target resumes for exactly its remainder on a later price, and only after its earlier order is reconciled.
- After every fill, the stop is resized to the remaining quantity and verified.
- A database trigger stops target progress from ever decreasing and stops a `DONE` target from reopening. Replaying the same price or the same fill repeats nothing.

**Trailing stop (EXT-04).**
- **Activation:** uses the saved activation move (or "from entry") on the saved price basis.
- **Watermark:** the highest price for a Long and the lowest for a Short.
- **Level:** high minus distance for a Long, low plus distance for a Short. It only tightens; a database trigger refuses any loosening.
- **Persistence:** status, activation time, watermark and level are stored on the position, so a restarted worker continues from them.
- **Trigger:** a software trigger closes the remaining quantity at market. The original venue stop stays in place as protection while any quantity is open. Trailing also manages the remainder after split TP.

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

**Split TP and trailing** (A: 50% at +2% and 30% at +4%, with the 20% remainder on a 1% trailing stop that activates at +3%, mark price; B: no TP, a 1% trailing stop from entry, last price):

```sh
# Terminal 1
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run dev

# Terminal 2
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run demo:paper -- --reset-paper --profile split
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run replay
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run worker:once        # entriesApproved=2; A targets tp1 66300.5 (76), tp2 67600.5 (45)

npm run market:tick -- --price 66400 --liquidity 50 --at 2026-11-08T09:30:20Z
SIGNAL_TEST_CLOCK=2026-11-08T09:30:20Z npm run worker:once        # tp1 EXPIRED (PARTIAL_FILL) filled=50 remaining=103
npm run market:tick -- --price 66400 --at 2026-11-08T09:30:30Z
SIGNAL_TEST_CLOCK=2026-11-08T09:30:30Z npm run worker:once        # tp1 FILLED filled=26 remaining=77 (target done)
npm run market:tick -- --price 66400 --at 2026-11-08T09:30:35Z
SIGNAL_TEST_CLOCK=2026-11-08T09:30:35Z npm run worker:once        # takeProfitsRequested=0 (no repeat)
npm run market:tick -- --price 67000 --at 2026-11-08T09:30:40Z
SIGNAL_TEST_CLOCK=2026-11-08T09:30:40Z npm run worker:once        # trailingActivated=1 (A: level 66330)
npm run market:tick -- --price 67700 --at 2026-11-08T09:30:50Z
SIGNAL_TEST_CLOCK=2026-11-08T09:30:50Z npm run worker:once        # tp2 FILLED filled=45 remaining=32; trailing level 67023
npm run market:tick -- --price 67000 --at 2026-11-08T09:31:00Z
SIGNAL_TEST_CLOCK=2026-11-08T09:31:00Z npm run worker:once        # trailingStopsRequested=2 → A and B closed (TRAILING_STOP)
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
  - *My Trades* → open row → **Take profit · trailing** shows "N of M targets filled" and, for each target, its trigger price, status and filled/planned quantity.
  - *Trade detail* → **Take-profit targets** lists, per target, the trigger and basis, planned, requested and filled quantities, and status.
  - API: `GET /v1/me/trades/{id}` → `targets[]`. Database: `position_targets`.
- **Remaining stop coverage:**
  - *My Trades* → **Stop loss** shows *Protected · covers N*, where N equals the remaining contracts.
  - *Trade detail* → **Stop loss** shows the covered contracts, and **Remaining contracts** shows `R of N`.
  - The resting order is `sim_orders` (`STOP_MARKET`, `contracts`), and the platform view is `positions.stop_contracts`.
- **Trailing:**
  - *My Trades* shows "Trailing L (best W)".
  - *Trade detail* → **Trailing stop** shows state, activation price, distance and basis, watermark, level and activation time.
  - API: `trailing` on the trade. Database: the `positions.trailing_*` columns.
- **Each reversal outcome:**
  - *Signals*: *Close and reverse · filled*, together with either *Reversed · Paper Short filled* or *Stayed flat · REASON* (or *Opening leg pending*).
  - *Trade detail* of the closed position → **Close and reverse**: the outcome, reason text and a link to the new position. The new position links back to the one it replaced.
  - API: `reversal` / `reversedFromPositionId` on `GET /v1/me/trades/{id}`, and `exit` + `entry` on `GET /v1/me/signals`.
  - Database: the `signal_decisions` row with step `ENTRY_V1` has `detail.reversal = true`, `fromPositionId` and `closeState`.

### Tests for this slice

| Suite | Covers |
| --- | --- |
| `packages/domain/test/exits.test.ts` | Target planning (full and partial splits, fixed, off), target status from fills, trailing activation and level rounding, and the Long/Short watermark, tighten-only rule and trigger |
| `packages/domain/test/orderBlock.test.ts` | A split below 100% is valid only with trailing enabled; above 100% is invalid |
| `apps/web/test/api/splitTrailing.test.ts` | Long split + trailing remainder; partial target fill and its resume; no repeat on the same price or a duplicate tick; activation on the saved basis; restart (a fresh worker pool re-runs a crashed tick from persisted state); tighten-only (including the DB guard); trailing close of the remainder with zero confirmed and the stop cleared; target progress API and isolation; Short trailing on LAST from entry; competing triggers (target in flight vs trailing vs manual close vs venue stop; a stop beating a pending target); target DB guard |
| `apps/web/test/api/reversal.test.ts` | Successful close-then-open with the new stop in the same simulated request; owner views and isolation; replaying the same event, plus re-running dispatch, close, reverse and submit concurrently, creates no duplicate fill, entry or position; partial close withholds and keeps the remainder protected; an uncertain close (venue stop first, close refused) withholds; a close crossing local midnight into a disabled day gives `DAY_DISABLED`; paused gives `PAUSED`; expired gives `SIGNAL_STALE` |
| `apps/web/e2e/6-split-trailing-reverse.spec.ts` | The real `demo:paper --profile split/reverse`, `replay`, `market:tick` and `worker:once` commands; the My Trades, trade detail and Signals views for both investors |

### Still open after this slice
- **Market data:** public MEXC market data integration is deferred. Prices are fixtures (`source = FIXTURE`).
- **Trailing:** the trailing stop is a software trigger; native venue tightening is not modelled.
- **Minimum residuals:** there is no special handling for exchange minimum residuals beyond rounding targets down to the contract step.
- **Risk:** daily-loss limits and cooldown are not enforced yet.
- **Live trading:** live order submission remains disabled; no adapter or credentials exist.
