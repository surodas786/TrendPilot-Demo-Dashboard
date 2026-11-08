# TrendPilot Software Requirements Specification

**Version 1.0 · 8 November 2026 · Implementation baseline for Claude Code**

This SRS translates TrendPilot Product Requirements v2.0 into an engineering specification. TrendPilot receives shared TradingView signals, evaluates them independently for each eligible investor, and executes through that investor’s own MEXC Futures connection or an isolated paper account. The investor’s browser is a control and reporting surface. Server workers handle trading and protection continuously.

## 1 Implementation instructions

1. Inspect the repository and its instructions first. Preserve its stack, conventions and existing dashboard layout where a usable export is available. The [MagicPatterns demo](https://project-trendpilot-demo-dashboard-918.magicpatterns.app/) is a visual reference. If its source is absent, build the screens from §4 and record the visual dependency.
2. For an empty repository, the proposed stack is TypeScript, Next.js for UI and HTTP APIs, PostgreSQL for state and durable jobs, and a separate TypeScript worker for ingestion processing, execution, monitoring and reconciliation. Keep shared domain logic framework-independent. Use migrations, a decimal library and a real time-zone library. Redis is optional and may hold disposable data only.
3. Implement §14 in order. Start with deterministic fixtures and paper execution. Test external adapters through fixtures and mocks. Keep the private live-order transport disabled in all development, demo, CI, test and replay environments. A release gate and investor opt-in are both required for live trading.
4. Requirement IDs are stable. Link tests and implementation milestones to them. API and table names describe the proposed interface for a new build. Existing equivalents are acceptable if they preserve the same contracts, isolation and outcomes.
5. Treat §13 values as proposed engineering defaults. Where the live policy has no approved value, the application may support configuration and paper simulation, but live entry must remain unavailable for the affected policy or capability.

## 2 Scope and definitions

| ID | Area | Requirement |
| --- | --- | --- |
| SCP-01 | Initial market | Selected MEXC USDT-settled perpetual contracts. Support Long and Short with one-way exposure per investor, exchange connection, execution mode and contract. An adapter interface supports later exchanges. |
| SCP-02 | Investor scope | Each investor has private settings, funds, trades and exchange credentials. Two investors can trade the same contract from the same signal with different outcomes. |
| SCP-03 | Operating modes | Demo uses fixtures. Paper uses simulated private execution and market data. Live uses the investor’s authorized MEXC connection. Separate balances, jobs, positions, ledgers and execution adapters by mode. |
| SCP-04 | Funds | Investor funds remain at MEXC. The app may read balances and accessible transfer history and place or cancel permitted trades. Custody, deposits, withdrawals and transfers are outside scope. |
| SCP-05 | Later scope | Additional exchanges, hedge mode, independently protected same-token positions, multi-timeframe rules and extra indicators are separate releases. |

**Order block** means the investor’s trading settings for one exchange contract and mode. **Package version** means an immutable published strategy configuration. **Signal route** maps a TradingView source tuple to an execution contract and strategy lineage. **Managed position** means exchange exposure opened by TrendPilot or explicitly adopted. **Opening stop** means exchange-hosted stop loss submitted in the same request as the opening order. **Flat** means an authoritative position snapshot confirms zero quantity and there are no unresolved orders that could reopen exposure.

## 3 Architecture and trust boundaries

| Component | Responsibility |
| --- | --- |
| Web UI and API | Authenticate, enforce ownership and roles, validate user settings, serve read models and enqueue authorized commands. Browser requests never sign or send exchange orders. |
| Webhook ingress | Validate, normalize, durably store, deduplicate and enqueue a shared signal. No exchange calls before acknowledgement. |
| Signal and strategy worker | Route signals, evaluate each eligible block or position, read aligned closed candles and record decisions. |
| Execution worker | Reserve account risk, serialize trade actions, maintain durable order intents, call an approved adapter and reconcile fills and protection. |
| Market data worker | Maintain shared public subscriptions, a closed-candle cache, freshness state and backfill. Evaluate software exit triggers through durable position jobs. |
| Account synchronization worker | Receive investor-specific private events, pull snapshots and reconcile orders, stops, fills, balances, funding and external activity. |
| Reporting and notification workers | Build scoped read models and exports, deliver alerts and retain audit history. |

**ARC-01** Use a transactional outbox or an equivalent database-backed job queue. Persist the accepted event and work item atomically. Assume at-least-once processing. Claims expire on worker failure. Persist checkpoints and make handlers idempotent.

**ARC-02** Serialize commands by investor, connection or paper account, mode and instrument. Persist one unresolved exposure-changing operation per scope. Use an ownership token or fencing mechanism for worker claims and an account-level transaction for risk reservations across instruments. Every network submission requires a committed intent and stable client order ID where supported. If a worker dies around a network call, the next worker must reconcile that intent before sending another order. A database lease alone cannot prevent a duplicate exchange submission.

**ARC-03** Use exchange state as the authority for live orders, fills, balances and positions. Use the platform as the authority for settings, authorization, intent and audit history. Quarantine a scope when the two cannot be reconciled. Prioritize protection and closing work over new exposure.

## 4 Users and screens

| ID | Screen | Required behavior |
| --- | --- | --- |
| IAM-01 | User access | Admin creates a named investor and sends an invite. Authorized resets and invitations use expiring single-use links with hashed tokens. Support MFA, login, password recovery and session revocation. Suspend entry access while keeping existing protection active. |
| IAM-02 | Authorization | Resolve investor identity from the session or trusted internal ownership records. Check it on every object lookup, mutation, socket subscription, export, cache and job. Derive account ownership server-side. Admin operational access to private records requires a separate permission and audit event. Admin screens never return plaintext credentials. |
| UI-01 | Dashboard | Retain the demo dashboard layout as the design reference. Show own daily realized and unrealized P&L, equity, balances, funding, fees, position counts, mode, data freshness and connection status. Filter by date, contract, strategy and mode. |
| UI-02 | My Account | Show profile, MFA, exchange setup, balances and Holdings. Holdings includes active orders and a distinct unmanaged positions view. My Account is the fixed signed-in scope. The header account selector, All my accounts and Trading Account fields are absent. |
| UI-03 | Trade Settings | Add, preview, edit, pause and resume token order blocks. Show strategy, mode, direction, order cost, leverage, margin, SL, TP, trailing, risk limits and seven independently selectable weekdays. |
| UI-04 | My Trades | Show active and historical trades, status, manual market close, fill history, linked signal decisions, snapshots, exits, fees, funding and exports. Embed an exact-contract TradingView chart if supported and permitted. Otherwise use a labelled exchange-data chart. |
| UI-05 | Administrator | Users, TradingView Webhook and Signal Routes, Strategy Packages, Trading Pairs and Operations. Type a ticker, validate it against the exchange, publish it, and set suggested stop, TP and trailing values. View feed and connection health, blocked entries, failed protection, reconciliation and audit events. |
| UI-06 | Presentation | Provide empty, loading, stale, disconnected, error and pending order states. Label Demo, Paper and Live. Show critical status in text as well as color. Preserve readable layouts and keyboard access on desktop and mobile. |

## 5 Configuration

**CFG-01 Exchange connection.** My Account allows the investor to create and update their own connection. Initially one active live connection per investor and exchange. Exchange and adapter resolve from an approved server configuration. Validate account identity, key permissions, supported contracts, one-way mode, connection and clock health, and stop attachment capabilities. Present Masked, Pending validation, Ready, Degraded, Disabled and Revoked states. Separate validation from explicit investor live activation. A connection change or removal cannot orphan a managed position or pending order. Reject linking the same verified live exchange account identity to different investors, since their one-way positions would merge at the exchange.

**CFG-02 Package version.** Admin defines approved contract mappings, timeframe 5m or 15m, Supertrend ATR length and factor, permitted directions, EMA filter Off or EMA 200, opposite-signal behavior, signal maximum age, price deviation and suggested exit settings. Editing creates a draft. Publishing creates a new immutable version. Existing order blocks remain pinned until an explicit migration. Managed positions retain their saved strategy and exit plan. Preserve their closing route through package changes and retirements.

**CFG-03 Order block schema.**

| Field | Type or rule |
| --- | --- |
| instrumentId, strategyVersionId | Approved, mutually compatible records. Exchange is derived from the instrument. |
| mode, direction | PAPER or LIVE. LONG_ONLY, SHORT_ONLY or BOTH. |
| orderCostUsdt, leverage, marginMode | Positive decimal USDT cost, supported leverage selection, ISOLATED or CROSS when verified. |
| stop | Required. PERCENT or PRICE, with ATR_DISTANCE where enabled. Store a price basis and positive value. Validate long and short independently when needed. |
| takeProfit | FIXED, SPLIT or OFF. Each level has stable ID, target rule and close percentage. Targets may use price movement, absolute price or R if enabled. |
| trailing | Enabled flag, activation rule, distance and trigger basis. Persist each position’s watermark and derived stop. |
| weekdays, timezone | Set of SUN, MON, TUE, WED, THU, FRI, SAT. Show all seven in this order. Use Asia/Dhaka initially. |
| allowAdds, maxAdds | Off by default. Count confirmed and pending adds when enabled. |
| risk | Optional stricter caps for open positions, notional, stop risk, daily loss, cooldown, spread and price deviation. Apply platform ceilings. |
| status, version | ACTIVE or PAUSED. Use optimistic concurrency on updates. Keep immutable setting snapshots on order intents and positions. |

**CFG-04 Weekdays and pause.** Use the local weekday at new-order submission as the proposed rule. Recheck after any queue delay and before the opening leg of a reversal. All days selected initially. An empty set blocks entries. An ineligible event is skipped, not queued for another day. A pause, suspension, unselected day, daily loss halt or global entry halt blocks new exposure while allowing TP, stop, trailing, manual close and valid signal exits. Resume requires fresh state and eligibility checks. A pause cannot cancel an already accepted exchange order by itself. Resolve outstanding entry intents explicitly and continue protecting any fills.

**CFG-05 Changes and defaults.** Populate editable suggestions from published pair or package settings. Apply changes to future entries. An active position’s plan changes only through a distinct validated and audited operation. If an add would change its exit basis, require the explicit add policy in §8 and verify continuous protection.

## 6 TradingView intake and routing

**SIG-01 Endpoint.** `POST /v1/webhooks/tradingview/{ingressToken}` over HTTPS. The administrator copies the central URL. Use a rotatable high-entropy token with securely stored verifier, constant-time comparison and URL redaction at ingress, proxy and application layers. Apply documented provider source controls and trust forwarded addresses only from configured proxies. Rate-limit and cap body size. Never put exchange keys or investor identifiers in the body.

**SIG-02 Payload.** In TradingView, use separate Supertrend bullish and bearish alerts, on the approved time-based chart, with Once Per Bar Close. Use the exact placeholders below. The bearish alert uses the second message.

```json
{
  "action": "BULLISH_FLIP",
  "source_exchange": "{{exchange}}",
  "source_symbol": "{{ticker}}",
  "interval": "{{interval}}",
  "bar_open_utc": "{{time}}",
  "alert_fired_utc": "{{timenow}}",
  "reference_price": "{{close}}"
}
```

```json
{
  "action": "BEARISH_FLIP",
  "source_exchange": "{{exchange}}",
  "source_symbol": "{{ticker}}",
  "interval": "{{interval}}",
  "bar_open_utc": "{{time}}",
  "alert_fired_utc": "{{timenow}}",
  "reference_price": "{{close}}"
}
```

**SIG-03 Validation.** Require the six fields above. Normalize source exchange and exact ticker to the registered route format. Accept interval strings "5" and "15". Validate UTC timestamps, candle alignment, resolved placeholders, positive decimal reference price and approved source. Derive bar close from bar open plus the interval. Reject pre-close, future, stale and out-of-order actionable signals under the configured clock and expiry policy. Store bar open, derived close, firing and receipt separately. An authorized route may also accept CLOSE_LONG or CLOSE_SHORT with the same schema. Those actions can only close matching managed positions.

**SIG-04 Routing.** The unique actionable source tuple is source exchange, ticker, interval and action. Resolve to approved market, instrument and strategy lineage. Keep version eligibility on the block or saved position. A compatible route may serve older saved positions without remapping them to a different instrument or policy. Reject ambiguous actionable routes. Information-only routes record events without invoking execution. Admin test routes and replay are restricted to Demo or Paper.

**SIG-05 Durability and ordering.** Use a unique key on ingress namespace, stable route ID, bar open and action. Record one accepted canonical event and enqueue fan-out atomically. Return 202 after commit. Return 200 for a duplicate accepted event, 400 for malformed payload, 404 for invalid ingress, 422 for unrecognized or unprocessable input, and 503 for persistence failure. Do not acknowledge an event that is not durable. Keep per-route and per-execution-scope ordering, with a bar watermark for directional decisions. Hold or reject conflicting same-bar flips so one position cannot open twice from the bar. Record a separate decision for each investor and target. An investor’s rejection never blocks another investor.

## 7 Strategy decision engine

| ID | Verified state and event | Decision |
| --- | --- | --- |
| STR-01 | Flat and bullish flip | Evaluate Long entry. |
| STR-02 | Flat and bearish flip | Evaluate Short entry. |
| STR-03 | Open position and same-direction flip | Hold unless a new qualifying flip meets the opt-in add policy and all entry checks. |
| STR-04 | Open position and opposite-direction flip | Apply the saved policy KEEP_OPEN, CLOSE_ONLY or CLOSE_AND_REVERSE. KEEP_OPEN leaves protection active. |
| STR-05 | Matching explicit close | Submit a market close for the confirmed remaining managed quantity. Flat or mismatched positions are skipped. |
| STR-06 | Close and reverse | Close at market first. Wait for confirmed flat state, terminal conflicting orders and removal or safe reconciliation of obsolete protection. Then revalidate all entry checks, including freshness and local weekday, before opening the opposite side. A partial or uncertain close stays protected and cannot reverse. If the new leg fails eligibility, remain flat. |
| STR-07 | Stale state, conflict or unknown order | Block new exposure and reconcile. Do not treat the local absence of a position as verified flat. |

**STR-08 Entry checks.** Check global, investor and order-block status, live activation where applicable, strategy direction, signal age, price/feed freshness, weekdays, EMA, exposure, external position conflicts, cost, minimum size, leverage and margin mode, funds and estimated fees, spread, price deviation, cooldown and daily loss. Apply these to new exposure only. An exit uses its saved policy even if entry checks would fail. A completed exit requires a fresh qualifying flip for re-entry, except the eligible second leg of a reversal.

**STR-09 EMA 200.** TradingView generates Supertrend flips. TrendPilot calculates EMA on closed MEXC Futures candles for the mapped execution instrument and signal interval. At the exact signal bar boundary, use the aligned MEXC close and EMA through that bar. Seed from the arithmetic mean of the first 200 consecutive closes. Then update `EMA = previousEMA + (2/201) × (close − previousEMA)`. Persist consistent warm-up history or a checkpoint with its anchor. Cache by exchange, instrument, interval and bar close. Backfill gaps and rebuild affected checkpoints if history changes. Long passes above EMA, short below. Equality, missing data or misalignment blocks the filtered entry by expiry. Off bypasses the calculation. A forming candle and a TradingView reference price cannot supply the EMA input.

## 8 Sizing and exchange execution

**EXE-01 Sizing.** Use decimal values. Let `p` be a fresh executable price estimate, `m` the contract multiplier in underlying units per contract and `s` the contract quantity step.

```text
targetNotional = orderCostUsdt × leverage
rawContracts = targetNotional ÷ p ÷ m
contracts = floor(rawContracts ÷ s) × s
estimatedNotional = contracts × m × p
estimatedMargin = estimatedNotional ÷ leverage
```

Validate current precision, minimum and maximum size, risk tier, leverage, margin and position mode, exchange rules and available margin plus fees and reserves. Use ask-side inputs for buying and bid-side inputs for selling, with policy-defined slippage allowances. Display estimated fees and loss to stop separately. A quote or order preview is not a guarantee of fill price. Under the proposed market-entry default, block entry if the configured slippage or budget policy cannot be met. Never increase size to satisfy a minimum.

**EXE-02 Attached stop.** The opening request must carry stop price and trigger basis. Derive a provisional stop from the entry estimate and risk rule. Verify correct trigger side, precision, coverage and configured distance from liquidation. The adapter maps these to exchange fields and proves their behavior for each enabled mode and order type. Reject live entry if attached protection is unsupported, disabled or unverified. A strategy-specific ATR stop requires a reproducible closed-candle ATR input and sufficient history.

**EXE-03 After fill.** Verify exchange stop coverage on each fill, including partial fills and adds. Reconcile to actual average fill and position size where required. An adjustment may tighten and may resize but may not silently widen protection or create an unprotected interval. If coverage is missing, rejected or too small, block new entries, attempt restoration or an emergency market close under the approved deadline, notify operations and investor, and reconcile until protected or flat. Never mark a position protected solely from an order acknowledgement.

**EXE-04 Lifecycle.** Persist INTENT, SUBMITTING, ACKNOWLEDGED, PARTIALLY_FILLED, FILLED, REJECTED, CANCELLED, EXPIRED and UNKNOWN. Track intent kind, stable client order ID, exchange IDs, cumulative confirmed quantity and timestamps. Deduplicate fills by exchange fill ID within connection scope. Reconcile a timeout with authoritative order and position queries. Retry only when non-acceptance is established or the adapter proves repeat submission is idempotent. Otherwise keep the scope blocked and escalate. Disallow changing leverage or margin on open exposure through ordinary settings edits.

**EXE-05 Same-token entries.** Proposed first release uses one aggregate one-way position per scope. Individual adds retain their own order, quantity, allocation and fills. Require compatible strategy, direction, leverage, margin and exit policy. Serialize adds, validate limits and prove the old and new combined quantity stay protected. Keep live adds disabled until quantity and target recalculation rules are approved and verified. Unmanaged exposure blocks new entries on that contract until explicitly adopted or resolved.

## 9 Exits and market data

| ID | Exit | Execution and state |
| --- | --- | --- |
| EXT-01 | Initial stop loss | Exchange-hosted stop sent with entry, verified against actual exposure and maintained through pauses and outages. |
| EXT-02 | Fixed TP | Trigger from the selected exchange price stream. Submit a closing market order, using reduce-only or verified equivalent semantics. |
| EXT-03 | Split TP | Each target has an immutable level ID and close fraction of the plan’s base quantity. Track requested and filled quantity separately. Reserve the remaining eligible quantity until reconciliation. Verify resized SL after each fill. |
| EXT-04 | Trailing stop | Track favorable high for Long or low for Short after activation. Persist activation, watermark and effective stop. Tighten only. Use verified native tightening where supported, or a software trigger with the original exchange stop kept as protection. |
| EXT-05 | Signal or manual close | Submit a market order for the verified remaining managed quantity. Confirm user intent for manual close. Report actual status until terminal. |
| EXT-06 | Races and partial fills | Serialize triggers and cap aggregate closing quantity. Reconcile any active close before issuing another that could overlap. Exchange-native close-only protection may still fire during a software close. Verify the exchange cannot flip exposure. A touched target is not a fill. |

**EXT-07 Rules.** For Long TP, compare trigger price at or above the target. For Short TP, use at or below. Long trailing stop derives from its high less distance, Short from its low plus distance. Validate ordered targets, valid fractions, trigger basis and price precision. Keep price movement, leverage-based returns and percentage of quantity distinct. One R is the saved initial distance between average entry and initial stop. A full split allocates 100%. Otherwise assign the remainder to an enabled exit plan. Round to supported contracts. An unfilled target can resume for its remaining quantity only after the earlier order is reconciled. Use a tested, configured final-close rule for exchange minimum residuals. If an exit is rejected, surface the failure and retain valid protection.

**MKT-01 Streams.** Maintain public exchange subscriptions for approved active contracts and open positions. Share by contract across investors. Keep authenticated private streams and broadcasts owner-scoped. Track last, mark or fair, bid, ask, candle boundaries, timestamps and instrument health. Use exchange price data for exits. TradingView price is for signal context and deviation checking.

**MKT-02 Recovery.** Handle heartbeat, stale data, reconnect with backoff, resubscribe, snapshots and gap backfill. On stale data, block affected entries. Keep native stops active. On recovery, use current authoritative state to evaluate any still-eligible software exit. Record any interval where a crossing could not be verified. Do not fabricate a historical market fill or watermark from an incomplete stream. Preserve state through process restarts and browser shutdown.

## 10 Data and external interfaces

Every private record carries a server-validated owner. Use owner-aware foreign keys and indexes. PostgreSQL decimal types store quantities and monetary values. JSON APIs serialize them as strings. Use UTC timestamps for storage, explicit IANA timezones for display and daily boundaries, and opaque IDs for exposed records. Keep strategy and setting snapshots immutable.

| Record | Core fields and integrity |
| --- | --- |
| User, membership, session, invitation | User ID, role, status, MFA and session metadata. Hashed single-use invite/reset tokens with expiry. |
| ExchangeConnection, PaperAccount | Owner, exchange, mode, verified account identity where available, encrypted secret reference, status, activation, sync time. Unique active live connection per owner and exchange. |
| Instrument, strategy package, version, route | Exchange and exchange symbol, instrument metadata, versioned settings, published state and source mapping. Unique stable actionable source tuple. |
| OrderBlock, settings snapshot | Owner, instrument, mode, package version, rule fields, revision and pause. Unique active configuration per owner, instrument and mode. |
| SignalEvent, SignalDecision | Canonical event, route, bar and timestamps. Decision includes owner, target scope, status, reason, correlation ID and resulting intent. Unique event/target/decision step. |
| Position, ExitPlan, TargetProgress | Owner, account, mode, instrument, side, strategy snapshot, remaining and initial quantity, fill average, protection status, liquidation, watermark and applied target quantities. |
| OrderIntent, ExchangeOrder, Fill | Owner, scope, kind, client ID, state, exchange ID, side, quantity, trigger metadata, fee and fill time. Unique fill IDs within account scope. |
| BalanceSnapshot, LedgerEntry, SyncCheckpoint | Owner, account, mode, equity, available and used margin, asset, fee, realized P&L, funding or transfer category, provider identifier, timestamp and provenance. |
| RiskReservation, Job, Outbox, AuditEvent | Scope, idempotency, claim metadata, retry and next attempt. Append-only audit events identify actor, action, result and redacted before/after metadata. |

### 10.1 First-party API

All routes below other than authenticated webhook ingress and login flows require a session. Investor routes use `/me` ownership. Admin routes require explicit permissions. Cursor-paginate lists and bound filters. Use structured errors `{code, message, correlationId}`. Return a consistent not-found response for unowned object IDs. Mutation commands affecting execution require an idempotency key. Reject key reuse with changed input. Configuration writes require a revision or ETag.

| Method and path | Contract |
| --- | --- |
| GET /v1/me | User, roles, allowed modes and timezone. |
| GET/PUT /v1/me/exchange-connections/{exchange} | Return redacted state or submit new credentials for validation. Never echo secrets. |
| POST /v1/me/exchange-connections/{exchange}/validate or /activate | Start validation or record explicit live opt-in after platform and adapter gates pass. |
| GET /v1/instruments and /v1/strategy-versions | List compatible published instruments and packages. |
| GET/POST /v1/me/order-blocks | List or create investor blocks. Create validates schema, defaults and uniqueness. |
| PATCH /v1/me/order-blocks/{id} | Apply revision-checked edits for future entries. |
| POST /v1/me/order-blocks/{id}/preview or /pause or /resume | Preview returns sizing, stop, fees and validation reasons without orders. Pause and resume apply entry gates. |
| GET /v1/me/dashboard, /v1/me/holdings, /v1/me/trades, /v1/me/trades/{id} | Scoped read models, filters and freshness. |
| POST /v1/me/positions/{id}/close | Accept a full managed-position market-close command. Return 202 and command ID. Recheck verified quantity and ownership in worker. |
| GET /v1/me/commands/{id}, /v1/me/signals, /v1/me/ledger | Scoped status, decisions and financial history. |
| POST /v1/me/exports and GET /v1/me/exports/{id} | Create an owned export and fetch its status or short-lived authorized download. |
| GET /v1/me/events | Authenticated SSE or equivalent socket for owned balance, order, position and notification events. Reauthorize on reconnect and revocation. |
| /v1/admin/users, /instruments, /strategy-packages, /routes, /operations | Create or suspend users, send invitations/resets, validate or publish instruments, publish package versions, manage routes, run paper-only test signals and inspect operations. Scope all under /v1/admin. |

Decision reasons include `ROUTE_INFO_ONLY`, `SIGNAL_STALE`, `OUT_OF_ORDER`, `PAUSED`, `DAY_DISABLED`, `DIRECTION_DISABLED`, `EMA_UNAVAILABLE`, `EMA_FILTERED`, `FEED_STALE`, `INSUFFICIENT_MARGIN`, `SIZE_BELOW_MINIMUM`, `RISK_LIMIT`, `UNMANAGED_EXPOSURE`, `ORDER_UNCERTAIN`, `PROTECTION_FAILED` and `LIVE_DISABLED`. Persist decisions with timestamps and redacted details.

### 10.2 Exchange adapter

Expose instrument metadata, historical candles, public stream, private account events where available, balances, positions, open orders, fills, funding and transfers where accessible. Expose capabilities for one-way mode, leverage and margin, attached stops, market close, stop resize and order lookup. Provide `placeOpeningOrderWithStop`, `placeMarketClose`, `lookupOrder`, `inspectProtection`, `resizeProtection` and `cancelOrder` with typed normalized results. Accept typed quantities and price bases. Each call returns accepted, rejected or unknown as applicable. Map and test actual provider parameters and permissions in the adapter. Avoid inferred API behavior from the exchange’s manual trading UI.

## 11 Synchronization and reporting

- **REP-01** Sync balances, positions, orders, fills, actual fees, funding and accessible external transfers using private events and scheduled reconciliation. Proposed intervals are 60 seconds for balances, five minutes for full reconciliation, daily ledger backfill and immediate reconciliation after reconnect. Rate-limit manual refresh. Label missing or stale data.
- **REP-02** Deduplicate finance events with provider IDs or a documented stable fallback key. Separate predicted funding from settled funding. Record paid funding as negative and received funding as positive. Link it to a position only if attribution is reliable. Adjust affected periods when late data arrives.
- **REP-03** Net realized P&L equals gross realized trading P&L less commissions plus net actual funding. Normalize exchange fields before combining. Attribute partial realized results to the fill date. Show unrealized separately. Separate opening and closing equity from net external flows. Define the treatment of breakeven before reporting win rate.
- **REP-04** In Holdings, show pair, side, open time, average entry, current and mark price, contracts, notional, allocated cost, current margin, leverage, margin mode, realized and unrealized P&L, stop coverage, targets and trailing state. Show exchange-reported liquidation where present. Label estimates and price basis. Display distance to liquidation and estimated liquidation loss where reliable, and unavailable otherwise. Cross margin values may change with account equity and other positions.
- **REP-05** My Trades includes original signal, strategy and block snapshots, order and fill history, exchange and platform statuses, fees, funding, liquidation and linked logs. Exports include user scope, mode, currency, timezone, filters, data freshness and unresolved gaps.

## 12 Security and reliability

- **OPS-01** Encrypt API keys and secrets with managed key protection. Restrict decryption to the live execution and synchronization service identities. Use TLS, signed requests, approved endpoints and outbound IPs where required. Reject withdrawal permissions when verifiable. Redact secrets and authorization material from logs, errors, traces, exports and audit. Never use real keys in fixtures or tests.
- **OPS-02** Keep Demo and Paper unable to reach live private order transports. Live entry requires the deployment gate, investor activation, ready credentials, verified exchange capabilities and current reconciliation. An entry halt leaves protection and closing operations available. Resume only after validation. Administrative live capability flags and user activation changes are audited.
- **OPS-03** Reconcile ambiguous responses and restart from durable intent and position state. Detect manual exchange changes, order drift and missing stops. Include unmanaged exposure in risk checks. Adoption requires explicit owner intent, verified quantity, known pending orders and valid protection. Guard credential rotation, disconnection and revocation flows when positions remain open. Prioritize emergency restoration or closure when protection fails.
- **OPS-04** Emit metrics for queue lag, webhook processing, candle/feed age, stop coverage, unknown orders, private synchronization and mismatches. Audit administrative and trading actions with correlation IDs. Notify in app and optionally by email for fills, rejections, failed protection, stale feeds, account outages and loss limits.
- **OPS-05** Proposed under agreed load: p95 webhook response within 1 second, p95 accepted signal to initial submission within 2 seconds when dependencies are healthy, UI update within 2 seconds of backend receipt, and 99.9% monthly platform availability subject to agreement. The webhook must commit before acknowledgement and finish within TradingView’s documented 3-second delivery timeout. Record signal firing, bar close, received, evaluation, submitted, acknowledged and fill times separately. Report upstream delay independently.
- **OPS-06** Use migrations, backup and restore tests, worker and feed health checks, clock monitoring, least-privilege database identities and replayable fixtures. Define capacity, retention, recovery time and recovery point before production. A rollback must preserve execution intents and ongoing position protection.

## 13 Proposed defaults and live gates

| Item | Starting point | Live requirement |
| --- | --- | --- |
| Weekdays and reporting | Asia/Dhaka. All days selected for a new block. Entry weekday evaluated at submission. | Confirm timezone configurability. |
| Supertrend | Paper fixture uses confirmed 15m bars, ATR length 10 and factor 3. Packages support 5m and 15m. | Publish verified routes and package-specific settings. |
| EMA and reversal | EMA Off and KEEP_OPEN are proposed conservative draft defaults. Both are selectable by the admin. | Approve effective strategy policy, expiry, spread, price deviation and clock tolerances. |
| Entry and margin | Market entry in paper, Isolated where supported, one-way mode. | Verify market entry with attached SL, stop trigger basis, precision, minimums, leverage, fees, slippage policy and supported margin modes. |
| Adds and split exits | Adds off by default. Paper can demonstrate aggregate adds. | Approve add count, post-add TP basis, stop replacement procedure and residual quantity behavior. Keep affected features disabled until verified. |
| Risk and recovery | Daily loss breach blocks new exposure and preserves exits. | Approve daily loss measure, notional and leverage limits, liquidation buffer, protection deadline and escalation path. |
| External dependencies | Mock email and charts where unavailable. Use local paper simulator with labelled assumptions. | Verify email provider, chart availability, permissions, exchange limits, account capability and any sandbox before relying on them. |

## 14 Build milestones and acceptance

| Milestone | Deliverable | Exit condition |
| --- | --- | --- |
| M1 Domain and access | Local setup, migrations, owner-aware queries, authentication, screens, admin fixtures and audit. | Isolation, onboarding and configuration tests pass. |
| M2 Signal to paper | Webhook, routing, durable fan-out, market data and EMA, risk checks, paper adapter, all exit paths, restart recovery. | Deterministic end-to-end paper tests pass with two investors on one token. |
| M3 Reporting and operations | Synchronization, dashboards, My Account, My Trades, exports, alerts, health and restore runbook. | Reconciliation, ledger, security, observability and failure tests pass. |
| M4 Live adapter validation | MEXC private adapter with contract fixtures, then separately authorized controlled pilot. | Live gates, account permissions, attached stop coverage, market closes and restart recovery verified for pilot contracts. Live remains disabled until approved. |

| Test | Requirement | Expected result |
| --- | --- | --- |
| AT-01 | SCP-02, IAM-02 | A and B trade the same token with different size and exit plans. Each sees only their data. Cross-user reads, writes, streams, caches, jobs and exports deny access. |
| AT-02 | IAM-01, UI-02, CFG-01 | Invite/reset link expires and works once. No account selector. Connection changes cannot strand a position. A shared verified exchange account cannot be linked to two investors. |
| AT-03 | SIG-01–05 | Correct TradingView payload persists before response. Duplicate, invalid, information-only, stale, out-of-order or conflicting events cannot duplicate entry. Queue retry is safe. |
| AT-04 | STR-01–09 | Test every decision row. Disabled EMA bypasses. Enabled EMA tests above, below, equality, missing history and a forming candle. EMA never blocks a valid close. |
| AT-05 | CFG-04, STR-06 | All seven day controls persist. Pause and an unselected day block opens/adds. SL, TP, trailing and valid closes continue. Reversal crosses local midnight and rechecks the new day. |
| AT-06 | EXE-01, ARC-02 | Verify units and rounding using fixtures, including minimum failures. Two simultaneous signals on different instruments cannot oversubscribe one account. |
| AT-07 | EXE-02–03 | Opening request carries SL. Verify initial and partial-fill protection. Missing SL blocks adds and starts recovery and alerting. |
| AT-08 | EXT-01–07 | Fixed and split TP use market closes. A partially filled target accounts only for actual fills. Remaining SL matches exposure. Simultaneous stop, TP and manual close cannot create reverse exposure. |
| AT-09 | STR-04–06, EXE-04 | Keep, close-only and reverse behave independently. Partial or unknown close cannot open the opposite leg. Confirmed flat alone still requires fresh eligibility. |
| AT-10 | ARC-01–03, EXE-04, MKT-02 | Crash before or after remote submission, duplicate fill, reconnect and stale stream recover without duplicate orders. Unknown order state remains blocked. |
| AT-11 | SCP-03, OPS-01–02 | Demo, Paper, tests and replay cannot call live order transport. Browser closure does not stop workers. Disabled or suspended users retain existing protection. |
| AT-12 | REP-01–05 | Duplicate funding books once. Late fees revise the correct day. Transfers do not inflate P&L. Missing liquidation is unavailable. Chart fallback uses the mapped execution contract. |

Deliver the repository with local run instructions, a secret-free environment template, migrations, fixture seed with two investors and one admin, deterministic tests, supported-capability matrix and deployment/recovery notes. Document missing credentials, integrations and release approvals as blockers rather than marking them complete. The initial demo and paper build must run without a live exchange key.

## 15 References

- [TrendPilot Product Requirements v2.0](https://chatgpt.com/library?file_id=libfile_33182fa7c91481918f89adbd7b30870a&account_id=personal)
- [TradingView webhook configuration](https://www.tradingview.com/support/solutions/43000529348-how-to-configure-webhook-alerts/)
- [TradingView alert message variables](https://www.tradingview.com/support/solutions/43000531021-how-to-use-a-variable-value-in-alert/)
- [MEXC Futures REST integration guide](https://www.mexc.com/api-docs/futures/integration-guide)
- [MEXC Futures Place Order API](https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/place-order)
- [MEXC Futures WebSocket endpoints](https://www.mexc.com/api-docs/futures/websocket-api/native-ws-endpoint)
- [TradingView Advanced Chart widget](https://www.tradingview.com/widget-docs/widgets/charts/advanced-chart/)
