# TrendPilot build checkpoint

**DEVELOPMENT PAUSED: 2026-11-09 (evening), after the post-Step-12 Paper fixes:** MEXC WebSocket feed, XAU_USDT onboarding, route Edit/Delete, and strategy package controls.
- Live order submission is disabled. No live account is activated, and no real order was ever submitted.
- For this pause nothing was reset, committed, pushed, deployed or reconfigured; only this file was edited.
- The working tree and all Paper data are preserved.

## Pause record — 2026-11-09 evening

### Git state (checked at pause)
- **Branch:** `feature/admin-mailbox-settings`, tracking `origin/feature/admin-mailbox-settings`, **in sync** (not ahead or behind).
- **HEAD:** `eaf93d95623f6092c475cd4d142cd873a31eb076`, "Add Create, Edit, and Delete controls to Admin → Strategy Package".
  - 9 commits ahead of `main`.
  - `origin/main` is `4a5e703`.
- **Uncommitted changes:** none. `git status` is clean apart from this checkpoint edit.
- **Ignored, local only:** `.env`, `.env.staging`, `backups/`, `database-export/`, `test-results/`, `apps/web/.next/`, `apps/web/server-*.log`. Never commit `.env*`, `database-export/` or `backups/`.
- **Commits for this session's work** (all on the branch above):

| Commit | Content |
| --- | --- |
| `01fcfde` "Fixed bugs for websokcet" | MEXC WebSocket feed, SSE live quotes, migration `0016`, Caddy SSE route, `docs/STAGING.md` updates. It also carries `scripts/db-import.sh` and the STAGING import section. |
| `b919569` "Live Validation added" | XAU_USDT / MEXC Get Contract Info pair validation. |
| `93029ec` "Edit/Delete actions to Admin" | Signal route Edit and Delete. |
| `eaf93d9` | Strategy package Create, Edit, Delete and Archive, plus migration `0017`. |

### Deployed revision: partly verified (2026-11-10)
- **The deployed server is the Ubuntu host at `192.168.91.16`**, using PM2 and standalone PostgreSQL. The web app is served directly on port **3000** (`http://192.168.91.16:3000`).
  - Earlier records named `192.168.1.230`; that address was wrong. It never answered from this workstation (ping, SSH and HTTP all timed out).
- **Checked from this workstation on 2026-11-10:**
  - Ping: replies, about 34 ms.
  - `GET http://192.168.91.16:3000/v1/health` → `200 {"status":"ok","web":"up","database":"up","mode":"PAPER","liveOrderTransport":"disabled"}`.
  - Ports 80, 443 and 8080: connection refused. No reverse proxy answers on this host, so the "proxy does not buffer `/v1/market/quotes/stream`" check applies only if a proxy is added in front of port 3000.
  - **Build fingerprint**, from unauthenticated route probes (401 = route exists, 404 = it does not; the control path returned 404):
    - `/v1/market/quotes/stream` (`01fcfde`) → 401;
    - `/v1/admin/strategy-packages/{id}/archive` and `/restore` (added in `eaf93d9`) → 401.
    - So the running build **includes `eaf93d9`**, the newest fix commit.
  - SSH: the port answers, but `ssh pms@192.168.91.16` is refused (`Permission denied (publickey,password)`). The user name `pms` comes from the old SSH config entry for `192.168.1.230` and may not be right for this host.
- **Still not verified (needs SSH or admin sign-in on the server):**
  - git HEAD;
  - whether migrations `0016` and `0017` were applied;
  - `pm2 list`, including exactly one `market:feed`;
  - feed logs;
  - the server's routes, strategy versions and investor blocks.
- The only other deployed facts in this file are the ones the operator reported: the REST 510 feed log, the XAUUSDT rejection, and the 5m alert answered with `422 ROUTE_NOT_FOUND`.
- **Required on deploy:** `npm ci && npm run db:migrate && npm run build && pm2 restart all`.
  - It applies migrations `0016` (quote channel columns) and `0017` (package archive and revision).
  - The `market:feed` process must run under PM2, with exactly one instance.

### Local environment at pause (this workstation)
- **Local staging stack `trendpilot-staging`: running.**
  - web, worker, feed, caddy, db.
  - Its image was built 2026-11-09 13:36 UTC from the WebSocket-feed working tree, so it does **not** include the XAU, route or package changes.
  - Its database is at migration `0016`, with 0 users and 0 instruments.
  - It is a rehearsal stack, not the deployment. `LIVE_ORDER_TRANSPORT=disabled` was confirmed inside the web container.
  - Left running and unchanged.
- **Dev database `trendpilot`** (container `trendpilot-demo-dashboard-db-1`): migration level `0016`. `0017` is **not** applied there. It holds local Paper verification data:
  - **Instruments:** BTCUSDT (fixture) and XAUUSDT → XAU_USDT (MEXC-verified, not fixture).
  - **Strategy:** "Supertrend 15m — paper fixture" v1 15m and **v2 15m**. That local v2 was published during the XAU check and is **not** the deployed v2, which runs at 5m.
  - **Routes:** two enabled 15m routes for `BTCUSDT.P`, bullish and bearish.
  - **Activity:** no order blocks; 2 `SIGNAL_STALE` rejections.
- **Other databases:** `trendpilot_test` and `trendpilot_e2e` hold the last test runs.
- **No local web, worker or feed processes are running.** The ones started for verification were stopped. The unrelated `penta-crm-postgres` container was not touched.

### Work items: observed / implemented locally / deployed / still to test

**1. MEXC market feed (REST ticker rate limit)**
- **Observed (deployed, operator report):** the Market Data Feed log showed BTC_USDT going HEALTHY → DOWN after `GET /api/v1/contract/ticker` returned MEXC code 510 (IP rate limit). In that build, REST polling was the only ticker source.
- **Implemented locally (committed in `01fcfde`):**
  - One public WebSocket (`wss://contract.mexc.com/edge`, `sub.ticker`) is the primary source, shared by all users.
  - Ping every 15 s, with the pong used as the clock sample. Reconnect backs off from 1 s to 30 s, then resubscribes.
  - Freshness is tracked per contract, separately from socket state.
  - No routine REST ticker calls. REST is kept for candles, contract detail and funding.
  - A 510 or 429 pauses all REST calls for about 60 s.
  - A REST error never marks a contract DOWN while WebSocket quotes are fresh.
  - REST ticker fallback is optional and off by default (`MARKET_FEED_REST_FALLBACK`). Rollback switch: `MARKET_FEED_TICKER_SOURCE=rest`.
  - A database lock keeps exactly one feed active.
  - Postgres NOTIFY feeds an SSE endpoint, `/v1/market/quotes/stream`.
  - The Dashboard and Market Data Feed pages update live, showing bid, ask, mark, source and last update. Refresh reads the database only.
- **Verified locally against live MEXC** (dev DB, real feed process, production web build):
  - Log sequence: `→ sub.ticker BTC_USDT` → `rs.sub.ticker success` → `push.ticker` about every 2.5 s.
  - **REST ticker calls = 0** over about 9.5 min.
  - A forced disconnect reconnected in 937 ms and resubscribed. BTC stayed HEALTHY throughout.
  - SSE latency from feed receipt to the client was 19–37 ms.
  - In headless Chromium, the dashboard prices changed with no reload.
- **Deployed:** unknown (see above).
- **Still to test on the deployed server:**
  - The PM2 feed log shows the subscription and push.ticker lines.
  - Market Data Feed shows REST ticker 0 and no 510 errors.
  - BTC_USDT updates on the dashboard without Refresh.
  - The proxy or Nginx does not buffer `/v1/market/quotes/stream`.
  - Only one feed runs per public IP.

**2. XAU_USDT onboarding**
- **Observed (deployed, operator report):** Validate rejected XAUUSDT because it only checked the local fixtures.
- **Implemented locally (`b919569`):**
  - In production, Validate and Publish use MEXC `GET /api/v1/contract/detail/country`. Tests and local dev or demo use fixtures; `PAIR_VALIDATION_SOURCE` overrides.
  - `XAUUSDT` and `XAU_USDT` both resolve to XAU_USDT.
  - The contract must be an enabled, USDT-settled perpetual.
  - Size, tick, step, min, max, fee and leverage limits are read from MEXC.
  - Errors are distinct: unknown symbol (400), rate limit (429), timeout or exchange error (503).
  - The feed subscribes newly published pairs on the running socket, with no restart.
- **Verified locally against live MEXC:**
  - Validate returned 200: size 0.001, tick 0.01, leverage 1–1000×.
  - Publish succeeded, with `isFixture` false.
  - The running feed sent `sub.ticker XAU_USDT` and reached HEALTHY with no spec mismatch.
  - After approving XAUUSDT in a strategy version, the order preview computed 242 contracts with the XAU spec.
- **Deployed:** unknown.
- **Still to test on the deployed server:**
  - Validate XAUUSDT once. `curl` gets a 403 from MEXC's edge on this endpoint while Node `fetch` gets 200, so confirm the server is not blocked.
  - Publish it.
  - Check XAU appears in Market Data Feed with live WebSocket prices.
  - Approve it in a strategy version if investors should trade it.

**3. BTCUSDT.P 5m webhook**
- **Observed (deployed, operator report):**
  - A 5m alert reached TrendPilot and got `422 ROUTE_NOT_FOUND`; only 15m routes were enabled.
  - Strategy v2 is published at **5m**, although the package name says 15m.
- **Implemented locally (`93029ec`, `eaf93d9`):**
  - Route Edit and Delete exist.
  - Edit checks that the lineage's newest published version matches the route's interval and contract.
  - Every route row and the route form show the real "v2 · 5m".
  - Trade Settings labels read "Package · vN · timeframe".
- **Verified locally (automated test only):** after editing the fixture route to 5m against a 5m v2, a fresh 5m `BTCUSDT.P` alert was **accepted** (202) and dispatched, and the old 15m tuple then returned `ROUTE_NOT_FOUND`.
- **On the deployed server: NOT done and NOT verified:**
  - **Both 5m routes** (BULLISH_FLIP and BEARISH_FLIP, `MEXC:BTCUSDT.P` → BTCUSDT, this lineage): existence unknown. Nothing was created on the server from here.
  - **The investor's Paper settings on v2:** unknown. Order blocks stay pinned to their version until the investor switches.
  - **A fresh 5m alert accepted on the server:** not verified.

**4. Admin controls**
- **Webhook routes (`93029ec`), implemented and tested locally:**
  - Edit uses a prefilled form, a revision check, a uniqueness check and the strategy interval and contract check.
  - Delete asks for confirmation and works only with no signal history. A route with history is refused and the dialog offers **Disable**.
  - Enable and disable kept.
  - Disabling, deleting or changing the routing of a route open positions depend on is blocked unless another enabled route covers the same contract, lineage and action.
  - Admin-only on the server. Changes are audited, and blocked attempts are logged as `DENIED`.
  - Create is now held to the same strategy check.
- **Strategy packages (`eaf93d9`), implemented and tested locally:**
  - Create package opens its first draft. Save draft and Publish are separate.
  - **Edit package** renames only: the ID, versions, routes and investor references are unchanged.
  - **Edit draft** for unpublished versions. A published version offers **Create draft from this version**, prefilled; publishing makes a new version, and blocks stay pinned.
  - Delete works only for an unused draft or a never-published package.
  - Deleting a **published version is refused** (409 IMMUTABLE), backed by the existing DB trigger.
  - **Archive** (with restore) hides a package from routes, new drafts and Trade Settings, and the server enforces this. It is blocked while an enabled route, an investor block or an open position depends on the package.
  - Renames, publishes, deletions, archives and restores are audited.
  - Migration `0017` adds `archived_at`, `archived_by` and `revision`.
- **Deployed:** unknown.
- **Still to test:** use the deployed UI for item 3 (edit the routes to 5m, rename the package if wanted) and confirm the audit log entries.

### Last test results (final code, 2026-11-09 evening)

| Check | Result |
| --- | --- |
| `npm run lint`, `npm run typecheck` | Clean |
| `npm test` (vitest) | **41 files, 561 tests passed** |
| `npm run test:e2e` | **46/46 passed** (5.7 min), run after the final UI fixes. The `npm error … start failed` lines are the intentional crash drills |
| `npm run build` | Succeeded (production build) |

- **Added this session:** `packages/db/test/mexcWs.test.ts`, `packages/db/test/contractCatalog.test.ts`, and these in `apps/web/test/api/`: `marketFeedStream.test.ts`, `xauPair.test.ts`, `signalRouteAdmin.test.ts`, `strategyPackageAdmin.test.ts`.
- **Tests changed on purpose:**
  - `operations.test.ts`: a 15m route on the 15m fixture.
  - The e2e package flow: the draft auto-opens, a single "Publish" button, and labels include the timeframe.

### First action when resuming
1. **Verify the deployed revision on the server** (`192.168.91.16`; needs SSH access with a valid user and key, or a session on that host):
   - `git log -1` should be `eaf93d9`, or the merge `4a945b4` on `main`. The route fingerprint already shows the `eaf93d9` code is running;
   - the migration level should include `0017`;
   - `pm2 list` should show web, worker and exactly one `market:feed`;
   - `/v1/health` should show `liveOrderTransport: disabled`. This was confirmed on 2026-11-10 at `http://192.168.91.16:3000/v1/health`.
   - If it is behind, deploy with `npm ci && npm run db:migrate && npm run build && pm2 restart all`.
2. **Then the first unresolved item: item 3 on the deployed server.**
   - In Admin → TradingView Webhook & Routes, edit the two 15m `BTCUSDT.P` routes to 5m. The edit is blocked while open positions depend on them; if so, add the 5m routes first, then disable the 15m ones.
   - Have the investor move the Paper block to v2 (5m).
   - Confirm the next 5m alert is accepted (202) rather than `ROUTE_NOT_FOUND`.
3. **Then check items 1 and 2 on the server** as listed under "Still to test".
4. Keep live order submission disabled throughout. No commit, push or deploy without an explicit request.

---

## Earlier pause record — Step 12 (2026-11-09, earlier; Git and environment facts below are superseded by the record above)

### Git state at that pause (superseded)
- **Current branch:** `feature/m3-market-data-and-reporting`.
  - It has no upstream; it was never pushed.
  - HEAD is `b3fc634b492b086cce1c4c9cd5038e62a251cd7a` ("Update build checkpoint after committing M2 slices 2-4"), the same commit as `origin/feature/m1-m2-signal-intake`.
- **Uncommitted:** 97 paths.
  - 37 modified tracked files (865 insertions, 252 deletions).
  - 60 untracked paths.
  - Together they make up Steps 8–12: migrations `0011`–`0014`, the market feed, reporting, funding, operations, staging, the MEXC adapter, the pilot code, their tests and the docs (listed in §5 below).
- **Ignored, local only:** `.env`, `.env.staging` (generated local staging secrets), `backups/` (one staging dump), and `test-results/` (including the dry-run transcript). These are not in Git. Do not commit `.env.staging`.
- **Earlier branch:** `feature/m1-m2-signal-intake` (Steps 1–7) is pushed. No PR is open for either branch.

### Step 12: dry-run results vs checks still pending on MEXC
- **Passed in the dry run** (mocked MEXC responses, real alert → intent → worker flow; `apps/web/test/api/pilotRehearsal.test.ts` 8/8; details in §1.2):
  - pilot allowlist, platform approval and investor activation, limits, adds and reversal off, audit;
  - the opening request carries the stop;
  - stop coverage equals the confirmed fill, including a partial fill (9 of 15);
  - take profit and close-on-signal are reduce-only closes that cannot flip;
  - fees, closed volume and P&L reconcile with the exchange records;
  - a missing stop triggers an emergency close and halts entries;
  - a timeout after submission halts entries and is reconciled before any retry;
  - a worker restart after a fill reconciles once;
  - closing stays available while halted;
  - limits refuse oversize and over-leveraged entries.
- **Still pending on MEXC (needs a real, authorized account):**
  - written eligibility confirmation for automated orders;
  - KYC, key permissions and IP whitelist;
  - the read-only account check (`npm run ops:mexc-readonly-check` → PENDING, no key configured);
  - the six pre-pilot checks with real evidence;
  - live evidence for the attached stop (atomicity, partial fill, listing), reduce-only close in the account's position mode, stop resize after a partial close, the unknown-order response and visibility delay, duplicate `externalOid`, and fee sign and currency.
- **Not built (needs a reviewed release before the first trade):**
  - encrypted credential storage;
  - LIVE mode for the pilot block;
  - live venue wiring;
  - the build gate;
  - an operator tool for exchange-side closes;
  - private sync and drift detection (needed before expansion).
- **Pilot runbook:** `docs/LIVE_PILOT_RUNBOOK.md`. Adapter and capability matrix: `docs/MEXC_PRIVATE_ADAPTER.md`.

### Live order submission: disabled — how it was verified
- **Code gates:**
  - `LIVE_ACTIVATION_ALLOWED_IN_THIS_BUILD = false` (`packages/db/src/live/mexcPrivate.ts:125`).
  - `ALLOWED_MODES = ['PAPER']` (`packages/domain/src/liveTransport.ts:26`).
  - `venueForMode('LIVE')` calls `openLiveOrderTransport`, which throws (`packages/db/src/venue/select.ts:14`).
  - `assertLiveTransportDisabled` runs at web start-up (`instrumentation.ts`), in `/v1/health`, and at worker and feed start-up.
- **Configuration:**
  - `LIVE_ORDER_TRANSPORT=disabled` in `.env`, `.env.staging`, `.env.example` and `.env.staging.example`.
  - No `LIVE_ORDER_TRANSPORT`, `TRENDPILOT_MODE` or `MEXC_*` credential variable is set in the shell.
  - No MEXC API key or secret exists in any file.
- **Tests:** the database-free guard suites ran at pause time and passed **33/33**: `mexcPrivate.test.ts`, `liveGuard.test.ts`, `feedGuard.test.ts`, `liveTransport.test.ts`. They prove that 9 environment variants (development, Paper staging, Demo, replay, e2e, CI, test, even a fully "live" production configuration) cannot open the order transport. The last full regression (2026-11-09) passed: unit 481/481, e2e 44/44, lint, typecheck and build clean.
- **Data:** no `live_pilots` row exists in any local database. Dev `trendpilot` predates the table (migrations through `0010`). `trendpilot_test` and `trendpilot_e2e` (through `0014`) have none. The restore-drill database predates the table.

### Running deployment at that pause (superseded: a server deployment now exists, see above)
- **No remote deployment existed then.** Nothing was ever deployed to a staging or production host, so no remote configuration could be checked. Remote HTTPS staging is pending its inputs (`docs/STAGING.md` §2).
- **Local staging stack** (`trendpilot-staging`): all containers are stopped. `db`, `caddy` and `migrate` exited with code 0; `web`, `worker` and `feed` exited with code 1, which is consistent with `docker compose stop` stopping npm processes. I did not restart them, to preserve state, so its live settings were not re-checked while running. Its database volume holds the smoke-test data (admin `ops-admin@paper-smoke.invalid`, two smoke investors) at migration `0013`. It has no `live_pilots` table, which arrived in `0014`.
- **Local processes:** nothing listens on ports 3000, 3100, 3101, 443 or 8443. The running containers are the dev database (`trendpilot-demo-dashboard-db-1`, healthy) and an unrelated `penta-crm-postgres` container, which was not inspected or touched.
- **Paper data preserved:**
  - `trendpilot` (dev, migrations through `0010`);
  - `trendpilot_test` and `trendpilot_e2e` (last test runs);
  - `trendpilot_restore_drill`;
  - the staging volume;
  - `backups/trendpilot_staging_20261108T184356Z.dump`.

### First action when resuming (Step 12 live-pilot track; superseded for Paper work by the record above)
1. **Read the runbook:** `docs/LIVE_PILOT_RUNBOOK.md` (§0 scope, §1 preconditions, §5 abort criteria, §6 manual protection and close).
2. **Recheck the planned pilot scope against current facts:**
   - the investor (active, consenting, the only allowlisted account);
   - the MEXC account (eligibility confirmation, KYC, key permissions, IP whitelist, position mode, flat);
   - the contract (published, MEXC spec matches the platform instrument);
   - the limits (max contracts and notional per order, max leverage, max exposure; recommended 1–2 × the minimum contracts, ≤ 3x, exposure ≤ one order).
3. **Wait for explicit operator approval** before enabling live trading. Until then, keep the build gate closed, `ALLOWED_MODES` PAPER-only, and `LIVE_ORDER_TRANSPORT=disabled`, and place no real order.
4. **Housekeeping, only on request:**
   - commit and push Steps 8–12;
   - open PRs (`gh` is signed in as `surodas786`; the git user is `miltondatta`);
   - run `npm run db:migrate` on the dev database.

---

## Readiness decision

**NOT READY for the first live trade. Live order submission stays disabled.**
- **The dry run passed:** every planned pilot step, rehearsed against mocked MEXC responses through the real alert → intent → worker flow. Results are in §1.2.
- **The real pilot is blocked by items the dry run cannot clear** (§3):
  - MEXC's written eligibility confirmation;
  - an authorized read-only account check;
  - encrypted credential storage;
  - LIVE mode, live venue wiring and the build gate (a separately reviewed release);
  - an operator tool for exchange-side closes;
  - the operator's written approval of the first trade.
- **The Paper release candidate is unchanged:** verified locally, with remote HTTPS staging pending its inputs.

**Branches**
- `feature/m1-m2-signal-intake`: Steps 1–7, committed and pushed. PR not opened.
- `feature/m3-market-data-and-reporting`: Steps 8–12, based on `b3fc634`. **Not committed** (97 changed or new paths).

**Docs**
- **Pilot runbook:** `docs/LIVE_PILOT_RUNBOOK.md`.
- **Adapter and capability matrix:** `docs/MEXC_PRIVATE_ADAPTER.md`.
- **Staging:** `docs/STAGING.md`.
- **Dry-run transcript:** `test-results/pilot-rehearsal.md`, regenerated by the rehearsal test; gitignored.
- **Baseline:** `docs/TrendPilot_SRS.md`.

## 1. Where we stopped

| Step | Scope | State |
| --- | --- | --- |
| 1–7 | M1 + M2 Paper trading | Done, committed |
| 8–10 | Public MEXC data, reporting, Paper release workflow | Done and verified locally; remote staging pending; uncommitted |
| 11 | Private MEXC adapter, mocked verification | Done; read-only check pending; uncommitted |
| 12 | Pilot scope, guard, dry run, runbook | **Done as a dry run; not ready for a real trade**; uncommitted |

### 1.1 Built in Step 12
- **Pilot scope** (migration `0014`, table `live_pilots`):
  - one investor, one MEXC account reference (never a credential), one contract;
  - operator-approved limits: max contracts per order, max notional per order, max leverage (1–20), max exposure;
  - `allow_adds` and `allow_reversal` forced false by a CHECK constraint;
  - a unique index permits only one open pilot.
- **Authorization:**
  - *Platform:* `POST /v1/admin/live-pilot/approve`, refused until six pre-pilot checks are recorded as passed with evidence: eligibility, KYC and key permissions, read-only check, position mode, contract spec, account flat.
  - *Investor:* explicit activation via `POST /v1/me/live-pilot/activate`. Only the allowlisted investor can activate, and the order block must have no adds, no reversing strategy, leverage within the limit, and the approved contract.
  - Both are audited.
- **Halts:**
  - Operators halt with `POST /v1/admin/live-pilot/halt`; investors with `POST /v1/me/live-pilot/halt` or by deactivating.
  - The guard halts automatically on `PROTECTION_FAILURE` or `UNCERTAIN_ORDER`.
  - Resume is operator-only, needs a note, and is refused while an order is unresolved or an open position is unprotected.
- **Guard** (`pilotGuardedVenue`):
  - Opening orders are checked against the allowlist, approval, activation, halt, a required stop, no adds, and the limits.
  - Closes, stop resizes, cancels and lookups pass untouched, so protection and closing are never gated.
- **Readiness:** `GET /v1/admin/live-pilot` lists each item, its stage (`FIRST_TRADE` or `EXPANSION`) and its state (`PASS`, `MISSING` or `BLOCKED_IN_THIS_BUILD`).
- **Not changed:**
  - `LIVE_ACTIVATION_ALLOWED_IN_THIS_BUILD = false`;
  - `ALLOWED_MODES = ['PAPER']`;
  - `venueForMode('LIVE')` still fails closed;
  - no credentials anywhere; the transcript uses dummy keys, redacted.

### 1.2 Dry-run results (`pilotRehearsal.test.ts`, 8/8, run 3 times)

Planned scope used: investor A on BTCUSDT, MEXC reference "UID …4821 (dry run)". Limits: 15 contracts and 110 USDT per order, 5x leverage, 110 USDT exposure. Block: 20 USDT × 5, stop 1.5 % on mark price, fixed TP 3 %.

| # | Scenario | Result |
| --- | --- | --- |
| 1 | Scope and authorization | Approval refused until the six checks were recorded; activation refused before approval and for investor B; A activated |
| 2 | Entry with the stop attached, **partial fill** | Redacted request: `POST /api/v1/private/order/create` with `side 1, type 5, vol 15, leverage 5, openType 1, externalOid tp-…, stopLossPrice 64025.5, lossTrend 2 (mark), positionMode 2`. MEXC filled 9 of 15; MEXC stop 9 contracts at 64025.5; platform 9 contracts, stop covers 9, PROTECTED. Investor B on the same alert: REJECTED `PILOT_INVESTOR_NOT_ALLOWLISTED`, no request sent |
| 3 | Take profit | `side 4, type 5, vol 9, reduceOnly true, positionId` → closed `TAKE_PROFIT`. MEXC Long 0, no Short, no active stop |
| 4 | Close on signal | Full 15-contract entry (stop covers 15) → `CLOSE_LONG` sent `side 4, reduceOnly, vol 15` → `SIGNAL_CLOSE`. No Short opened |
| 5 | **Missing stop** | Fill without a confirmed stop → `UNPROTECTED` → emergency reduce-only close filled (`PROTECTION_FAILURE`) → entries halted. Next alert: REJECTED `PILOT_ENTRIES_HALTED`, no request. Operator resumed after review |
| 6 | **Timeout after submission** | Accepted but the response timed out and the order was not yet visible → intent `SUBMITTING`, entries halted (`UNCERTAIN_ORDER`), resume refused while unresolved. A later attempt reconciled it by client order ID: FILLED with the stop verified, **one** order sent with that ID. A manual close while halted was accepted and filled |
| 7 | **Worker restart after the exchange filled** | The crash after the MEXC fill left the intent `SUBMITTING` with no position. A new worker and adapter instance reconciled it: one order at MEXC, position recorded once, stop verified |
| 8 | Pilot limits | Max contracts lowered to 5 → `PILOT_ORDER_SIZE`; max leverage 3x → `PILOT_LEVERAGE`; nothing sent. An add on an open position → `PILOT_ADDS_DISABLED` (unit test) |
| 9 | End state and reconciliation | All 5 platform positions CLOSED; every MEXC (mock) position 0 with no active stop. Fees: platform **0.3595056** = exchange deals **0.3595056** USDT. Closed volume **69 = 69** contracts. Realized P&L: platform **1.764** = recomputed from exchange fill prices **1.764** USDT. The paper-ledger identity holds. Investor deactivated |
| 10 | Readiness after the dry run | `readyForFirstTrade: false`, `readyForExpansion: false` (§3) |

### 1.3 Test results (final code, 2026-11-09)

| Check | Result |
| --- | --- |
| `npm run lint`, `npm run typecheck` | Clean |
| `npm run build` | Succeeded |
| `npm test` | **34 files, 481 tests passed** (Step 11: 449) |
| `npm run test:e2e` | **44/44** (6.5 min). The two `npm error … start failed` lines are the intentional crash drills |
| Step 12 suites | 32 new tests: `packages/domain/test/pilot.test.ts` (entry rules, limits, block issues), `apps/web/test/api/livePilot.test.ts` (roles, evidence, approval, activation, halts, isolation, constraints, audit), `apps/web/test/api/pilotRehearsal.test.ts` (dry run) |

**Fixes made while rehearsing:**
- **Mock exchange clock:** deals were stamped with wall-clock time while the rehearsal ran on a fixed clock. The mock now takes an injectable clock.
- **Order assumption:** a Step 11 test assumed which investor's order ran first. It now matches requests by client order ID.

No product defect was found in the rehearsal.

## 2. Commands and screens to repeat the checks

```sh
npm run lint && npm run typecheck && npm run build
npm test                                                     # expect 34 files, 481 tests
npx vitest run apps/web/test/api/pilotRehearsal.test.ts      # dry run; writes test-results/pilot-rehearsal.md
npx vitest run packages/domain/test/pilot.test.ts apps/web/test/api/livePilot.test.ts apps/web/test/api/liveAdapter.test.ts packages/db/test/mexcPrivate.test.ts
npm run test:e2e                                             # expect 44; stop the staging containers first
npm run ops:mexc-readonly-check -- --symbol BTC_USDT         # PENDING until an authorized read-only key is exported
```

**Pilot API:**
- *Admin:* `GET|POST /v1/admin/live-pilot`, `POST …/checks`, `…/approve`, `…/halt`, `…/resume`, `…/end`.
- *Investor:* `GET /v1/me/live-pilot`, `POST …/activate`, `…/deactivate`, `…/halt`.
- There is no pilot screen yet; use the API.

**Paper drills, staging, smoke test, backup and restore:** unchanged; see `docs/STAGING.md` and the README.

## 3. Open blockers

**Before the first supervised live trade** (stage `FIRST_TRADE`; the full table is in `docs/LIVE_PILOT_RUNBOOK.md` §1)
1. **MEXC eligibility:** written confirmation that the account may place automated futures orders for this use. MEXC says API access is "primarily available to institutional users" and restricts "bot trading, or algorithmic trading".
2. **Account and key:** KYC complete, minimal key permissions, IP whitelist.
3. **Read-only check** on the pilot account: pending, because no authorized read-only key is configured. This also verifies the reads: signing, balances, positions, position mode.
4. **The six pre-pilot checks** recorded with real evidence. The dry run used mock evidence only.
5. **Encrypted, access-restricted credential storage (OPS-01):** not built.
6. **Reviewed live release:**
   - LIVE mode for the pilot block (`ALLOWED_MODES`);
   - `venueForMode('LIVE')` → `pilotGuardedVenue(mexcVenue(…))`;
   - the build gate.

   None of these are built; all are intentionally closed.
7. **Operator tool to record an exchange-side manual close (drift):** not built. Without private sync, an operator close on MEXC leaves the platform position OPEN.
8. **Operator written approval of the first trade:** not given.

**Before expanding live access** (stage `EXPANSION`)
9. Live-pilot evidence for each order capability:
   - open with attached stop (atomicity, partial-fill sizing, listing);
   - reduce-only close in the account's position mode;
   - stop resize after a partial close (auto-shrink vs re-place, and the gap);
   - stop cancel;
   - order-by-ID lookup (unknown-ID response, visibility delay);
   - fills (fee sign and currency);
   - duplicate `externalOid`.
10. Scheduled private sync of balances, positions, fills and funding (REP-01), and drift detection (OPS-03).
11. Live notifications (OPS-04) for fills, rejections, failed protection, stale feeds and halts.
12. A pilot admin screen (the API exists).

**Paper (unchanged)**
- Remote HTTPS staging pending its inputs (`docs/STAGING.md` §2).
- Commit and PR decision. `gh` is signed in as `surodas786`; the git user is `miltondatta`.
- Dev database at `0010`: `npm run db:migrate` reaches `0014`.
- Tracked items: least-privilege database roles; admin MFA not enforced; latency not measured; dashboard filters and exports; daily-loss limit and cooldown; cosmetic `PENDING` protection on closed positions.

## 4. Dry run vs. real pilot

| Check | Dry run | Real pilot needed |
| --- | --- | --- |
| Allowlist, approvals, activation, limits, adds and reversal off, audit | **Passed** | — |
| Opening request with the stop attached (redacted) | **Passed** | MEXC creates and lists the stop atomically |
| Stop coverage = confirmed fill, including a partial fill | **Passed** | Real partial-fill stop behaviour |
| TP and close on signal: reduce-only, cannot flip | **Passed** | Behaviour in the account's position mode |
| Final position, fees, P&L vs exchange records | **Passed** (mock deals) | Real fee sign and currency, funding |
| Missing stop → emergency close, entries halted | **Passed** | How MEXC reports an attachment failure |
| Timeout after submission → reconcile before any retry | **Passed** | Real visibility delay; unknown-ID response |
| Worker restart after a fill | **Passed** | — |
| Closing available while halted | **Passed** | — |
| Eligibility, key permissions, read-only check | — | **Required** |
| Stop resize at MEXC after a partial close | Passed (modelled) | **Required** |
| Rate limits and maintenance codes | Codes mapped | Observe |

## 5. Changes to review (uncommitted)

**Step 12**
- `packages/domain/src/pilot.ts`
- `packages/db/src/live/pilot.ts`
- `schema.ts` (`live_pilots`) and migration `0014_m4_live_pilot`; the test reset includes `live_pilots`
- 10 routes under `apps/web/src/app/v1/admin/live-pilot/` and `apps/web/src/app/v1/me/live-pilot/`
- Tests: `packages/domain/test/pilot.test.ts`, `apps/web/test/api/livePilot.test.ts`, `apps/web/test/api/pilotRehearsal.test.ts`; the mock exchange clock in `apps/web/test/mexcMock.ts`; the order-independent match in `liveAdapter.test.ts`
- Docs: `docs/LIVE_PILOT_RUNBOOK.md`, the README Step 12 section, this checkpoint

**Steps 8–11:** as in the README sections and the previous checkpoints.

**Checked:**
- No credentials in source, tests or docs; the dry-run keys are dummy strings, redacted.
- The live gate is closed and `ALLOWED_MODES` is PAPER only.
- `test-results/`, `.env.staging` and `backups/` are gitignored.

**Next, only with separate approval:** clear §3 items 1–8. The operator then approves the first trade in writing and follows `docs/LIVE_PILOT_RUNBOOK.md` §2–§7.
