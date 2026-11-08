# TrendPilot build checkpoint

**Paused:** 2026-11-08, after Step 7. Step 8 has not been started.
**Branch:** `feature/m1-m2-signal-intake`.
- `bb9af44`: M1 + M2 slice 1. Pushed.
- `3b81866`: M2 slices 2–4 (Steps 5–7) and this checkpoint. Pushed.
- A follow-up commit updates this checkpoint. Pushed.
- The working tree is clean (see §4).
**Baseline:** `docs/TrendPilot_SRS.md`. Product context: `docs/TrendPilot_Auto_Trading_Platform_Requirements.md`.

## 1. Where we stopped

| Step | Scope (SRS) | State |
| --- | --- | --- |
| 1–3 | M1: domain, access, identity, admin, Trade Settings | Done, verified, committed (`bb9af44`) |
| 4 | M2 slice 1: TradingView webhook intake, routing, durable jobs | Done, verified, committed (`bb9af44`) |
| 5 | M2 slice 2: paper entries with the attached stop (EXE-01…04) | Done, verified, committed and pushed (`3b81866`) |
| 6 | M2 slice 3: paper exits — stop loss, fixed TP, signal close, manual close (EXT-01/02/05/06) | Done, verified, committed and pushed (`3b81866`) |
| 7 | M2 slice 4: split TP (EXT-03), trailing stop (EXT-04), close and reverse (STR-06) | Done, verified, committed and pushed (`3b81866`) — **last completed and verified step** |

### Step 7 verification (latest results, 2026-11-08)
- `npm run lint`: clean.
- `npm run typecheck`: clean (all workspaces).
- Results below are from the last code change, before commit `3b81866`. No tests were rerun after the commit; the commit changed no code.
- `npm test` (Vitest): **22 files, 341 tests passed**. Before Step 7 changed the worker, the Step 6 exit tests passed 47/47.
- `npm run test:e2e` (Playwright, 6 specs): **38 passed** (8.0 min). The `npm error … start failed` lines in that output are the intentional worker-crash drills.
- The manual close-and-reverse replay was run end to end against the **e2e** database on port 3101, including the web-server restart on the next bar. The output matched the README.
- Migrations up to `0010_m2_split_trailing_reverse` are applied to the dev database (`trendpilot`). The test and e2e databases migrate themselves during test setup.

### Step 7 work that is unfinished or not tested by hand
These are deliberately left for later slices, or covered only by automated tests:
- **Trailing stop:** only a software trigger. Native venue tightening is not modelled. The original venue stop stays at its initial price.
- **Minimum residuals:** no exchange minimum-residual or final-close rule beyond rounding each target down to the contract step (EXT-07 "tested, configured final-close rule").
- **Daily-loss limit and cooldown:** realized P&L now exists, but these risk controls are still not enforced.
- **Split TP and trailing replay:** the README sequence was verified by e2e spec 6, which runs the same CLI commands against the e2e server. It was **not** run by hand against `npm run dev`.
- **Short variant of the split replay** (`demo:paper -- --market down --profile split` + `replay -- --action BEARISH_FLIP`): **not run**. Short trailing is covered only by `splitTrailing.test.ts`.
- **Manual replay variations** in the README (expired signal, paused block, incomplete close via `--liquidity 100`): covered by `reversal.test.ts`, **not run by hand**.
- **Same-bar reversals:** spec 6 works around the e2e server's fixed clock. It opens the Longs on the previous bar and temporarily widens `signal_routes.max_signal_age_seconds` (restored in a `finally`). This is a test arrangement only, not product behaviour.

## 2. Commands

Prerequisites: Node 22, Docker. Copy `.env.example` to `.env` and fill in local development values only. No exchange credentials are used anywhere, and none belong in `.env` for Paper mode. In PowerShell, replace a `VAR=value cmd` prefix with `$env:VAR='value'; cmd`.

### Start
```sh
docker compose up -d db          # Postgres 16 on localhost:5433 (databases: trendpilot, trendpilot_test, trendpilot_e2e)
npm install
npm run db:migrate               # dev database
npm run db:seed                  # fixture admin, two investors, contracts, strategy, signal routes (only if the database is empty)
npm run dev                      # web app on http://localhost:3000
npm run worker                   # worker loop (or: npm run worker:once to drain the queue once)
```
- The replays below need a fixed clock. Start the web app with `SIGNAL_TEST_CLOCK=…`; it is refused in production.
- Port 3000 may already be in use by a dev server started by hand. Check before starting a second one.

### Tests
```sh
npm run lint
npm run typecheck
npm test                         # Vitest: domain, db, web API integration (uses trendpilot_test)
npm run test:e2e                 # Playwright: builds and starts its own server on port 3100 (uses trendpilot_e2e)
```

### Replay: split TP and trailing stop
- Investor A: split TP 50% at +2% and 30% at +4%. The 20% remainder is on a 1% trailing stop that activates at +3% (mark price).
- Investor B: no TP, a 1% trailing stop from entry (last price).

`--reset-paper` clears paper state in the **dev** database. Leave it out to keep the current local paper data.
```sh
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run dev
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run demo:paper -- --reset-paper --profile split
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run replay
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run worker:once                 # entriesApproved=2
npm run market:tick -- --price 66400 --liquidity 50 --at 2026-11-08T09:30:20Z
SIGNAL_TEST_CLOCK=2026-11-08T09:30:20Z npm run worker:once                 # tp1 EXPIRED (PARTIAL_FILL) filled=50 remaining=103
npm run market:tick -- --price 66400 --at 2026-11-08T09:30:30Z
SIGNAL_TEST_CLOCK=2026-11-08T09:30:30Z npm run worker:once                 # tp1 FILLED filled=26 remaining=77
npm run market:tick -- --price 66400 --at 2026-11-08T09:30:35Z
SIGNAL_TEST_CLOCK=2026-11-08T09:30:35Z npm run worker:once                 # takeProfitsRequested=0 (no repeat)
npm run market:tick -- --price 67000 --at 2026-11-08T09:30:40Z
SIGNAL_TEST_CLOCK=2026-11-08T09:30:40Z npm run worker:once                 # trailingActivated=1
npm run market:tick -- --price 67700 --at 2026-11-08T09:30:50Z
SIGNAL_TEST_CLOCK=2026-11-08T09:30:50Z npm run worker:once                 # tp2 FILLED filled=45 remaining=32; trailing level 67023
npm run market:tick -- --price 67000 --at 2026-11-08T09:31:00Z
SIGNAL_TEST_CLOCK=2026-11-08T09:31:00Z npm run worker:once                 # trailingStopsRequested=2 → A and B closed (TRAILING_STOP)
```

### Replay: close and reverse
Both blocks are pinned to a `CLOSE_AND_REVERSE` version. B trades Long only, so B's reversal stays flat.
```sh
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run dev
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run demo:paper -- --reset-paper --profile reverse
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run replay
SIGNAL_TEST_CLOCK=2026-11-08T09:30:03Z npm run worker:once                 # entriesApproved=2
# Restart the web app on the next bar (an opposite flip on the same bar is rejected: CONFLICTING_SAME_BAR):
SIGNAL_TEST_CLOCK=2026-11-08T09:45:03Z npm run dev
npm run market:tick -- --price 64900 --at 2026-11-08T09:45:20Z
SIGNAL_TEST_CLOCK=2026-11-08T09:45:03Z npm run replay -- --action BEARISH_FLIP
SIGNAL_TEST_CLOCK=2026-11-08T09:45:20Z npm run worker:once
#   exitsRequested=2 reversalsPending=2; both closes FILLED (exit=REVERSAL_CLOSE, reversal queued)
#   A: reversal ENTRY_APPROVED → paper order FILLED (Short, stop attached); B: SKIPPED (DIRECTION_DISABLED)
SIGNAL_TEST_CLOCK=2026-11-08T09:45:03Z npm run replay -- --action BEARISH_FLIP   # → 200 duplicate
SIGNAL_TEST_CLOCK=2026-11-08T09:45:20Z npm run worker:once                 # no runnable jobs
```

### Where to verify
- **Target progress:** My Trades → "Take profit · trailing". Trade detail → "Take-profit targets". Database: `position_targets`.
- **Stop coverage:** My Trades → "Protected · covers N". Trade detail → "Remaining contracts R of N". Database: `sim_orders` (`STOP_MARKET`).
- **Trailing state:** trade detail → "Trailing stop". Database: the `positions.trailing_*` columns.
- **Reversal outcome:** Signals ("Close and reverse" plus "Reversed …" or "Stayed flat · REASON"). Trade detail → "Close and reverse". Database: `signal_decisions` rows with step `ENTRY_V1` and `detail.reversal`.

More detail: README sections "M2 slice 2", "M2 slice 3" and "M2 slice 4".

## 3. Open bugs and blockers

- **Open bugs:** none known. Two bugs were found and fixed during Step 7:
  - Re-dispatching an older event could act on a newer position. The exit step now only considers positions open at the event's receipt and not opened by that event.
  - The worker log printed un-normalized contract quantities.
- **Pull request blocked:** the PR for this branch was never opened. `gh auth status` reports a failed login for the default GitHub account. Re-authenticate with `gh auth login -h github.com` before opening it. A draft PR body from the earlier session lives in a temporary scratch folder and may be gone; regenerate it from the README if needed.
- **Worker pool size:** the paper simulator writes through its own database connection, like a separate venue, while the platform transaction holds the position lock. A worker needs a pool of at least 2 connections; the worker uses 4 and 2. A pool of 1 deadlocks. Keep this in mind for any new worker or script.
- **Fixed signal clock:**
  - The web app's `SIGNAL_TEST_CLOCK` is fixed for the life of the process, so multi-bar replays need a restart.
  - The e2e server's clock is fixed at `2026-11-08T09:30:03Z`.
- **Port 3000:** a dev server started by hand outside these sessions may already be listening on 3000. It was left untouched; verification used ports 3100 and 3101.

## 4. Commits and changes to review

Steps 5–7 are committed in **`3b81866`** ("Build M2 slices 2-4: paper entries, exits, split TP, trailing, reversal"): 72 files, pushed to `origin/feature/m1-m2-signal-intake`. They were committed as one commit because the steps share files such as `schema.ts` and `dispatch.ts`. The commit message describes each step.

Before committing, the staged files were checked: no `.env` files, test output, logs or credentials.

Nothing is uncommitted. The checkpoint update is its own follow-up commit.

**Review when resuming** (contents of `3b81866`):
- **Database:**
  - Migrations `0006`–`0010` and their snapshots.
  - Paper engine in `packages/db/src/paper/`: simulator, entry, exits, reversal, read models.
  - Dispatch entry, exit and reversal steps.
  - Demo, fixture and tick CLIs.
- **Domain:** EMA and entry checks, exit rules, the split TP rule.
- **Web:** `/v1/me` holdings, orders, positions, trades, ledger and commands routes; My Trades and trade detail pages; the Signals page.
- **Worker:** new job kinds and the crash drill.
- **Tests:** API, domain and e2e specs 4–6.

**Local data (not reset):**
- Dev database `trendpilot`: holds the paper state from earlier sessions. Migrated through `0010`.
- E2E database `trendpilot_e2e`: holds the last e2e and manual-verification run.

## 5. Next task: Step 8 (not started)

**Connect public MEXC Futures prices and closed candles to Paper mode.**

- **Market data source:**
  - Add a market-data adapter for MEXC Futures **public** endpoints only: ticker and mark/last/bid/ask, and closed klines for the 5m and 15m intervals.
  - No API keys and no private endpoints.
- **Write to the existing tables:**
  - Write into the existing `market_quotes` and `market_candles` tables with `source = 'MEXC_PUBLIC'`, so entry checks (EMA 200, quote freshness, slippage) and exits (stops, TP targets, trailing) run on live public prices.
  - Each quote must enqueue the same `market.tick` job the fixtures use.
- **Fixtures for tests:** keep `source = 'FIXTURE'` and the deterministic replays for tests and demos. Tests must not depend on the network: use recorded responses or a stub server.
- **Feed health (MKT-02):** stale-stream handling, reconnect and backoff, closed-candle detection (never use a forming bar), gap detection and backfill, clock-skew tolerance, and per-contract symbol mapping.
- **Keep Paper mode unchanged:** order execution stays in the paper simulator, and live order submission stays disabled (`LIVE_ORDER_TRANSPORT=disabled`; the live-transport guard must remain).
- **Show the data source:** label it in the UI and API (fixture vs public MEXC), and surface feed health to admins.

**First action when resuming:**
1. Run `git status`: the tree should be clean.
2. Run `npm test` and `npm run test:e2e` to confirm the Step 7 baseline (341 / 38).
3. Open the PR for `feature/m1-m2-signal-intake` → `main` once `gh auth login -h github.com` succeeds.
4. Then start Step 8.
