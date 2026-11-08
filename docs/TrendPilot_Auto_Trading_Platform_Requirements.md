# TrendPilot Auto Trading Platform Requirements

**Version 2.0 · 8 November 2026**

For product, design, engineering and acceptance testing.

TrendPilot receives centrally managed TradingView alerts and evaluates each alert against the private settings of every eligible investor. Each investor trades selected MEXC Futures contracts through their own exchange credentials. Two investors can trade the same token independently, with different sizes, exits and results.

## 1 Scope and release stages

| Area | Requirement |
| --- | --- |
| Initial market | MEXC Futures USDT-settled perpetual contracts. Support long and short with one-way exposure per exchange connection, environment and contract. Design for additional exchanges through adapters. |
| MagicPatterns demo | Keep the current dashboard layout. Simulate onboarding, market data, webhook events, fills, stops, exits and balances with private demo accounts and a clearly labelled demo live mode. |
| Production platform | Run execution, monitoring and account synchronization continuously on the backend. Deliver platform paper trading and enable live orders only after exchange and recovery tests pass. |
| Exchange custody | Funds stay at the investor’s exchange. TrendPilot reads account data and places or cancels authorized trades. Deposit, withdrawal and custody functions are outside scope. |

### How to read this specification

Numbered requirements define the product. Section 11 records proposed defaults and decisions that still need validation. The latest rules here govern account navigation, weekday scheduling, initial protection and market exits.

## 2 Users and navigation

### 2.1 Investor privacy and onboarding

The administrator creates individual investor profiles and triggers an email invitation when a profile is created or an authorized password reset is initiated. Use expiring, single-use links. Support login, password recovery, multifactor authentication and session revocation. Paper access and live activation are separate.

Investor scope is always the signed-in user. Enforce ownership on every API, record lookup, export, private WebSocket subscription, cache key and background job. An investor may see only their own connections, order blocks, holdings, trades, funds, P&L, notifications and signal outcomes. Administrators manage users and platform health. Any access to private records requires an explicit operational permission and an audit event. Secrets remain unavailable in plaintext.

### 2.2 Investor screens

| Screen | Contents and actions |
| --- | --- |
| Dashboard | Keep the existing layout. Populate it with the investor’s own daily P&L, open positions, balance and status. Label paper and live values separately. |
| My Account | Profile, security, exchange connection setup and editing, balances and Holdings. Show exchange connection health and last synchronization. |
| Trade Settings | Create and edit order blocks for individual tokens. Show direction, strategy, mode, selected days, key risk settings and Pause or Resume. |
| My Trades | Open trades, order and trade history, trade detail, manual market close, per-trade P&L and linked events. Surface relevant signal outcomes and exports in context. |

My Account is the fixed signed-in scope. Remove the header account switcher, All my accounts and the Trading Account field. Consolidate the standalone Strategies, Trading and Risk Settings, Exit Settings, and Positions and Orders menus into the relevant screens above.

### 2.3 Administrator screens

Provide Users, TradingView Webhook and Signal Routes, Strategy Packages, Trading Pairs, and Operations. Operations covers exchange adapter health, rejected signals, failed protection, reconciliations, system limits and audit records. Administrators can type a ticker, validate it against exchange instruments and publish the pair with suggested SL, TP and trailing settings. Separate information-only events from actionable signals. Keep critical status visible on desktop and mobile without relying on color alone.

## 3 Investor configuration

### 3.1 Exchange connection

Within My Account, the investor can create or update their own exchange connection. Offer MEXC Futures as the initial selectable exchange. Use the approved connection for that investor and exchange. If additional connections are stored, use a single active live connection per exchange in the initial UI. Block connection changes that would orphan managed positions. Keep exchange keys on the backend, mask them after entry and verify read and trade permissions.

### 3.2 Order block fields

| Field | Behavior |
| --- | --- |
| Exchange and token | Select an enabled exchange and an administrator-approved perpetual contract. Resolve the owner’s exchange connection internally. |
| Strategy and direction | Select a published compatible package. Choose Long only, Short only, or Long and Short. |
| Mode and state | Paper or Live. Provide a per-token Pause or Resume action. Live requires investor activation and a ready connection. |
| Trade size and margin | Enter margin cost in USDT. Select leverage from exchange-supported choices and choose Isolated or Cross when supported. |
| Stop loss and targets | Show editable defaults from the package or token preset. Stop loss is required. Support fixed TP and optional split TP with separate trigger and quantity percentages. |
| Trailing stop | Set enablement, activation threshold, trailing distance and price basis. Expose a suggested value the investor can edit. |
| Trading days | Show Sunday, Monday, Tuesday, Wednesday, Thursday, Friday and Saturday as independent selections. Display the timezone beside the control. |
| Multiple entries | Default off. When enabled, allow later qualifying same-direction adds within the configured count and risk limits. |
| Risk limits | Use platform caps and optional stricter investor limits for open positions, exposure, stop risk, daily loss, cooldown, spread and price deviation. |

### 3.3 Trading day and pause behavior

Proposed timing rule. Use the local weekday at order submission, initially Asia/Dhaka, and show it on each order block. Select all days by default. An empty selection blocks new exposure. Recheck the day on a reversal entry after the previous position closes. Exits and protection continue on unselected days and while a block is paused. A signal skipped because of the schedule expires normally and is never queued for the next selected day.

Save the effective strategy version and exit plan at entry. New edits apply to future entries. A change to protection for an open position requires a separate validated, audited action.

## 4 TradingView and strategy packages

### 4.1 Administrative setup

The administrator copies a central webhook URL and configures signal routes and versioned packages. A route is keyed by the source chart exchange, ticker, timeframe and action and maps to a package version and an approved execution contract. Reject ambiguous trade routes. The same event can reach many investors, but only matching order blocks or existing positions are evaluated. Information-only routes record events without trading.

For each package, specify approved pairs, 5-minute or 15-minute timeframe, Supertrend ATR length and factor, allowed directions, optional trend filter, opposite-signal policy, target and stop defaults, signal expiry and reference price deviation. The initial paper test template uses confirmed 15-minute Supertrend, ATR length 10 and factor 3. Admins choose Off or EMA 200 when creating or editing a package. Publishing creates a new version.

### 4.2 Alert message templates

Create separate bullish and bearish Supertrend alerts on a standard time-based chart with Once Per Bar Close selected. Paste each JSON message into the corresponding alert and set the administrator’s webhook URL. The test route must recognize the resolved chart exchange, ticker and interval.

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

TradingView supplies the bar start in {{time}} and the alert firing time in {{timenow}}. The gateway derives the close boundary for the approved interval, checks that the alert did not fire before it, and stores both timestamps. If used, explicit CLOSE_LONG or CLOSE_SHORT actions follow the same schema and require an approved route. Record market type and strategy version from routing metadata. References 1 and 2.

### 4.3 Validation and dispatch

Accept HTTPS requests only. Authenticate the route with a high-entropy, rotatable URL and documented source controls. Keep route secrets and exchange credentials out of alert bodies and logs. Validate the schema, route, action, timestamp and age. Persist the event before acknowledging it, within TradingView’s three-second window, then dispatch asynchronously. Deduplicate using the approved route, bar and action. Record rejects, stale or out-of-order events and separate outcomes per investor. Measure bar close, alert firing, gateway receipt, evaluation, submission, acknowledgement and fills separately.

## 5 Position decisions and EMA filter

### 5.1 Entry and close decisions

| Position state | Confirmed signal | Required action |
| --- | --- | --- |
| Flat | Bullish flip | Open Long if permitted and all entry checks pass. |
| Flat | Bearish flip | Open Short if permitted and all entry checks pass. |
| Long or Short | Same direction | Keep the position. Add only on a fresh qualifying signal if multiple entries are enabled and checks pass. |
| Long or Short | Opposite direction | Apply the saved policy: Keep position open, Close position only, or Close and reverse. |
| Matching Long or Short | Explicit close | Submit a market close for the managed position when the route and saved position match. |
| Flat or mismatched | Explicit close | Record a skip. The signal cannot open a position. |

Close and reverse is two steps. Submit a market close, verify the exchange is flat and any conflicting orders are resolved, then evaluate the opposite entry. If the close is partial or uncertain, keep protection on the remainder and withhold the new entry. If the entry checks fail or the signal expires after the close, remain flat. Keep position open leaves stop loss, TP and trailing management active.

Only a fresh qualifying flip can open a new position after an exit, except the opposite leg of a permitted reversal. Apply the entry filter, trading days, pause and direction restrictions to all new exposure. A valid close uses the saved policy even if the EMA filter or an entry restriction would block the opposite entry. Match closing signals to the managed position’s strategy and source route. Published strategy changes must preserve routing for active positions on older versions.

### 5.2 EMA 200 calculation

TradingView supplies the Supertrend flip. When the package has EMA 200 enabled, TrendPilot fetches MEXC Futures candles for the mapped execution contract and the same timeframe. Compare the MEXC candle close at the signal boundary with EMA 200 calculated through that candle. Long requires close above EMA 200. Short requires close below it. Equality blocks entry.

Warm up with at least 200 consecutive closed candles. Use a documented seed and a consistent warm-up window for paper and live. Seed with the mean of the first 200 closes, then apply a smoothing factor of 2 ÷ 201 to each subsequent close. Cache by exchange, contract, interval and bar. Exclude the forming candle. Backfill gaps, verify alignment and skip the filtered entry if reliable data is unavailable before signal expiry. Keep exits active. The demo uses labelled simulated candle data.

## 6 Order sizing and execution

### 6.1 Entry cost and validation

Order cost is the USDT margin allocated to an entry, with fees and funding shown separately. Target notional equals order cost multiplied by leverage. Divide by the estimated entry price to obtain underlying quantity, then convert it to exchange contracts with the current contract multiplier. Round down to the permitted increment. For example, 100 USDT at 10× targets 1,000 USDT of notional. At 50,000 USDT per BTC, that is 0.02 BTC before rounding.

Before submission verify contract eligibility, precision and minimum size, leverage tier, actual position and margin modes, available margin plus estimated charges and reserves, order cost, portfolio risk, spread, reference price deviation, signal age and data freshness. Reserve risk for pending orders. The proposed initial entry type is market, subject to paper and adapter testing. Reject an order that cannot satisfy minimum size within the requested allocation. Show estimated fees, margin, size, leverage, stop and loss to stop in the order preview.

### 6.2 Initial stop submitted with the opening order

Include the stop-loss price and trigger basis in the opening order submission. Calculate the provisional price from the executable entry estimate and saved stop rule. MEXC documents a stop-loss price field on its Place Order endpoint. Verify that the stop is present and covers actual exposure as fills arrive. Where a stop rule uses average fill price or entry ATR, reconcile to actual filled quantity and the saved rule without automatically widening the stop. Keep protection on already filled quantity during any update. Reference 3.

Use an exchange-hosted stop and a configured buffer from estimated liquidation. Block live entry if the adapter cannot submit the required stop with the opening order for the selected mode. If protection is rejected, missing or undersized after a fill, stop adding exposure, restore protection promptly or attempt an emergency market close under the recovery policy. Raise an alert and reconcile until the position is protected or confirmed flat.

### 6.3 Concurrent actions and same token adds

Serialize order and exit actions by investor, exchange connection, environment and contract. Recheck actual position and pending orders within that scope. Each qualifying same-direction add records a separate order and margin allocation. One-way mode uses the combined exchange position with a single verified position-level exit plan. Treat this aggregation as the proposed initial implementation. Require compatible leverage, margin and exits and block any add that cannot maintain verified protection.

Store a unique order identifier and track submission, acknowledgement, partial fill, fill, rejection, cancellation, expiry and unknown status. Query by exchange or client order ID after a timeout before retrying. An acknowledgement alone does not establish a fill or protection. Exchange data governs live order, position and balance state.

## 7 Exits and market monitoring

### 7.1 Exit order rules

| Exit event | Execution rule |
| --- | --- |
| Initial stop loss | Submit with entry. Exchange-hosted protection stays active while the position is open and is verified against filled exposure. |
| Take profit | When the selected MEXC trigger price reaches a configured target, submit a reduce-only or equivalent market close for the applicable quantity. |
| Split take profit | Use separately configured levels and close fractions. On each confirmed partial fill, resize and verify protection for the remaining position. |
| Trailing stop | Track the high for a Long or low for a Short after activation. Tighten only. Persist the watermark and activation state through restarts. |
| Signal or manual close | Submit a market close for the verified remaining managed quantity. Track partial fills and confirm closure from the exchange. |

Support Fixed TP, Trailing, and Split TP with optional trailing for the remainder. Keep the opening stop mandatory in every mode. Validate stop and target side, trigger basis, price precision and liquidation buffer. Support percentage distance and price-based rules, with ATR stops or risk-multiple targets where enabled in the package. One R is the initial price distance from entry to stop. Keep price movement, return on margin and percent of quantity to close separate.

For split TP, define fractions against the managed size at plan initialization or its explicitly recalculated aggregate size after an add. Require total planned closure of 100% for a full split or identify the remainder for trailing or another exit. Round to permitted quantities and resolve minimum-size residuals using a documented, tested final-close rule. A target crossing triggers a market order. Fill price may differ.

Coordinate all exit causes under a position lock. Use exchange reduce-only or equivalent closing semantics, reconcile actual quantity and apply each target once. Handle simultaneous stop, target, signal and manual close without reverse exposure. Resize or cancel obsolete protection as confirmed fills change the position. Reconcile after any unknown result.

### 7.2 Live prices

Maintain MEXC Futures WebSocket subscriptions for approved active pairs and open positions. Share public subscriptions by contract while keeping each investor’s private events and exit state isolated. Track last price, mark or fair price, bid and ask, timestamp and candle state. Use the configured exchange price basis for triggers. TradingView chart prices are for signal context.

Use heartbeats, stale-data checks, reconnect and resubscribe, REST snapshots and gap recovery. Block affected new entries on stale data. Keep native stops active. After reconnecting, reconcile positions, stops and software exit state before allowing new entries. A closed browser has no effect on backend monitoring.

## 8 Accounts and reporting

### 8.1 Funds and funding

Sync wallet balance, available and used margin, equity, positions, open orders, fills, fees and available transfer records. Use private events with periodic reconciliation. Proposed starting cadence is balances every 60 seconds, full account reconciliation every five minutes and after reconnect, and ledger backfill daily or on demand. Label data age and gaps and rate-limit manual refresh.

Show predicted funding separately from actual payments and receipts. Deduplicate ledger items using exchange IDs or a documented stable key. Attribute funding to a position only when it can be linked reliably. Keep unallocated funding at the account level. Recalculate affected reports when late fees or funding arrive.

### 8.2 Dashboard and Holdings

Dashboard shows daily realized and unrealized P&L separately, opening and current equity, fees, funding, balance, used margin, open positions, completed trade counts and connection status. Store timestamps in UTC and display the reporting timezone, initially Asia/Dhaka. Apply date, contract, strategy and mode filters within the signed-in investor’s scope.

In My Account → Holdings, show token, direction, open time, average entry and current price, quantity, cost, notional, leverage, margin mode, realized and unrealized P&L, current protection and liquidation information. Separate asset balances, active orders and unmanaged positions. Show exchange-reported liquidation price where available, distinguish any estimate and identify its price basis. Show unavailable data explicitly. Show the distance to liquidation from the current mark price, and estimated liquidation loss where reliable. Indicate that cross margin uses account equity and other exposure.

### 8.3 My Trades and position detail

Show the source signal, strategy and order-block snapshot, order and fill timeline, allocated costs, exit status, fees, funding and P&L. Include the exact contract’s TradingView chart where supported and permitted, otherwise show a labelled exchange-data chart. Provide manual market close with scope confirmation and actual order status. Use a verified closing quantity and apply the same race controls as automated exits. Reference 6.

Net realized P&L equals gross realized trading P&L less commissions plus net actual funding. Normalize source amounts to avoid double-counting fees. Attribute partial fills on their fill date and report unrealized P&L separately. Calculate trading equity change after accounting for external flows, so deposits and withdrawals are not trading P&L. Define treatment of breakeven trades before publishing win rates.

Provide scoped exports for trades, fills, funds and fees, funding and relevant signals. Include currency, timezone, filters and synchronization status. Use USDT as the initial reporting currency.

## 9 Operations and service controls

### 9.1 Paper and live separation

Platform paper trading uses exchange market data with a simulated balance, orders, fills, fees, funding, liquidation estimates and optional slippage. It uses the same strategy, sizing and exit decisions as live execution, with a separate simulator and ledger. Paper and demo routes cannot call live private order endpoints. Treat any exchange sandbox as optional until its supported operations are verified.

For live trading, validate credentials, identity, allowed permissions, position mode, eligible contracts, network and clock health, and the protection behavior for the account. Use only approved REST and WebSocket endpoints. Encrypt keys at rest, use TLS and signed requests, restrict access to the execution backend and support rotation and revocation. Require read and trade permissions and reject withdrawal permissions where verifiable. Use approved outbound IPs where required.

### 9.2 Recovery and emergency controls

Persist signals, jobs, orders and exit state. On restart or reconnect, reconcile exchange orders, fills, balances and positions before resuming entries. Detect manual exchange changes. Treat external positions as unmanaged until explicitly adopted after verifying their ownership, size, orders and stop coverage. Include unmanaged exposure in risk checks.

Pause, user suspension and global entry halt stop new entries while existing exits and protection continue. Reaching the daily loss limit blocks new entries by default. Any forced closure policy requires explicit configuration. Resume requires a fresh state and permission check. Manual close-all, if enabled, is scoped to the investor’s managed positions and tracks each result independently. Guard disconnection or credential removal while managed exposure remains. Prioritize protective actions over entry jobs and recover uncertain results before retrying.

### 9.3 Logs, alerts and records

Record per-investor signal outcomes with a reason, order and protection state changes, fill events, reconciliation, manual actions, credential changes and administrative edits. Link signal, investor, strategy version, order block, position, order and correlation identifiers. Keep audit records append-only and redact secrets. Provide in-app notifications and configurable email for failed protection, feed and connection problems, fills, rejections and loss limits.

### 9.4 Service targets

Under an agreed test load, target a webhook response within one second at the 95th percentile, accepted signal to initial submission within two seconds at the 95th percentile when dependencies are healthy, and dashboard updates within two seconds of backend receipt. Track upstream delay and exchange execution separately. Confirm a proposed 99.9% monthly platform availability target before release.

Define capacity, retention, recovery time and recovery point objectives. Back up financial and configuration records, test restore and failover, and monitor queue lag, stale feeds, failed protection and state mismatches. Use decimal arithmetic for money and contract quantities.

## 10 Acceptance tests

Run these tests with separate investor profiles on the same token, in paper first and then in an authorized controlled live pilot where exchange behavior is part of the result.

| Scenario | Pass condition |
| --- | --- |
| Private account boundaries | Investor A cannot read, subscribe to, export or modify Investor B’s records. Both can independently trade the same token on one shared alert. |
| Admin and investor setup | Invite and reset links work once. Investor sees only My Account, with no account switcher or Trading Account selector. |
| Signal routing and replay | Only matching packages and tokens evaluate. Information-only, duplicate, stale and out-of-order events create no new order. One investor’s rejection does not stop others. |
| EMA settings | Off bypasses the filter. On uses the aligned closed MEXC candle. Missing history, equality and mismatched candles block entry while valid closes continue. |
| Trading days and pause | All seven weekdays are independently selectable. An unselected day or Pause blocks opens and adds. TP, SL, trailing and signal closes continue. A reversal crossing midnight rechecks the day. |
| Order sizing and entries | Cost and leverage convert correctly with contract rounding and fees. Invalid size, stale price, insufficient margin or unsupported leverage blocks submission. A same-direction add respects its limit. |
| Stop loss at opening | The initial entry request contains stop parameters. Verify full and partial fill coverage. Failed protection blocks adds and triggers recovery and notification. |
| Market exit and split TP | TP and signal closes submit market orders. Partial TP resizes protection from confirmed fills. Simultaneous triggers cannot flip the position. |
| Opposite signal policies | Test Keep position open, Close position only and Close and reverse. The reversal leg waits for confirmed flat state and fresh entry approval. |
| Timeout and restart | Unknown orders are reconciled before retry. Feed loss blocks entries. Restart restores trailing state and protection without duplicate orders. |
| Paper and live isolation | Demo, paper, test and replay cannot send live orders. Live mode requires a ready adapter and explicit owner activation. |
| Reporting and charts | Duplicate funding books once. Transfers do not inflate P&L. Missing liquidation data shows unavailable. Unavailable TradingView chart uses a labelled fallback. |

Historical testing must model fees, funding, slippage and intrabar execution assumptions. Paper testing covers strategies and application behavior. Adapter tests verify native stop attachment, partial fills and exits, allowed leverage and margin, liquidation data, reconciliation and account permissions.

## 11 Delivery decisions and references

### 11.1 Delivery sequence

| Stage | Deliverable and release condition |
| --- | --- |
| MagicPatterns demo | Use the existing TrendPilot demo as the design reference. Demonstrate two private investor profiles, admin setup, webhook test events, weekday selection, configurable EMA, both directions and each exit path using mock data. |
| Backend and paper | Implement authentication, ownership, durable webhooks, MEXC public data, paper execution, reporting and recovery. Pass the isolation and trading rule tests before testing with live credentials. |
| MEXC live pilot | Verify exchange permissions, stop attachment on entry, protection quantity, market close semantics, reconciliation, funding and liquidation for the pilot contracts. Enable live trading per investor after validation. |
| Later releases | Add exchanges through tested adapters. Consider independent same-token positions, additional indicators and other timeframes as separate changes. |

### 11.2 Proposed defaults and decisions to confirm

Weekday timing uses local order-submission time in Asia/Dhaka, with all days selected initially. Confirm whether investors may choose a different timezone. The initial UI uses one active live connection per investor and exchange. Same-token adds are opt-in and aggregate into one same-direction position. Confirm add limits and how its aggregate TP plan is recalculated before enabling adds in live trading.

Confirm the default opposite-signal policy, per-package expiry, price deviation and spread limits, loss-limit basis and behavior, default leverage and margin, supported stop and TP variants, trigger price basis, and liquidation buffer. Isolated margin is the proposed initial default where supported. Treat the 15-minute Supertrend template as a paper-test starting point.

Before enabling live trading, confirm supported contract and account capabilities, the protection recovery deadline, rounding and minimum residual close behavior, expected load, retention and service targets. Confirm whether email alerts and exact-contract TradingView chart embeds are available in the intended environments.

### 11.3 Integration references
1. [TradingView webhook configuration and delivery](https://www.tradingview.com/support/solutions/43000529348-how-to-configure-webhook-alerts/)
2. [TradingView alert message variables](https://www.tradingview.com/support/solutions/43000531021-how-to-use-a-variable-value-in-alert/)
3. [MEXC Futures Place Order API](https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/place-order)
4. [MEXC Futures REST integration guide](https://www.mexc.com/api-docs/futures/integration-guide)
5. [MEXC Futures WebSocket endpoints and formats](https://www.mexc.com/api-docs/futures/websocket-api/native-ws-endpoint)
6. [TradingView Advanced Chart widget](https://www.tradingview.com/widget-docs/widgets/charts/advanced-chart/)
