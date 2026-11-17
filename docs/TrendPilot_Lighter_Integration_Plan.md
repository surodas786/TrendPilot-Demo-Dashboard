# TrendPilot Lighter Exchange Integration Plan

17 November 2026 · Version 1.0 · For review before implementation

## 1. Target behavior

Add **Lighter USDC-settled perpetuals** as an execution venue alongside MEXC and Bitunix. Begin validation with gold (XAU). Allow additional Lighter markets only after an administrator verifies and publishes each market and signal route. TrendPilot receives the TradingView alert, applies each investor’s own strategy and trading settings, and sends eligible orders to that investor’s Lighter account. Positions continue to be managed by server workers when the investor closes the browser.

| Function | Source for a Lighter trade |
| --- | --- |
| Supertrend direction, interval and reference price | TradingView chart for the approved MEXC or Bitunix perpetual |
| Execution market | Lighter mainnet USDC perpetual, identified by verified native market ID |
| Current price, mark, index, bid/ask and depth | Lighter market data for that market |
| Sizing, slippage checks and market order price bounds | Fresh Lighter order book and market rules |
| EMA 200, ATR where configured, and holdings chart | Lighter candles for the execution market |
| Stop, TP and trailing TP reference | The saved Lighter trigger basis for that exit |
| Actual fills, balances, margin, liquidation, fees, funding and position state | The investor’s Lighter account and exchange records |

**First route to validate:** TradingView MEXC XAUUSDT.P → Lighter XAU perpetual, displayed as **XAU/USDC** once verified. TradingView lists the MEXC chart. Verify the exact exchange and ticker strings from a real alert before enabling the route. A Bitunix chart is an alternative source after its exact perpetual ticker and alert delivery are confirmed. The initial market choice is XAU. The route and market model must support additional approved USDC perpetuals.

Verify the Lighter target against the intended Ethereum-based Lighter mainnet catalog and account before publishing. Record the native market ID, symbol, market type, active status, base units, quote and settlement convention, quantity and price precision, minimum quantity and notional, supported margin modes and leverage. The SDK uses separate configurations for Ethereum-based Lighter and Robinhood Chain. Exclude spot, USDT and other settlement currencies from Lighter selection. Preserve the native symbol and market ID for API calls, even if the app’s display label adds USDC. Never derive the market ID by replacing USDT with USDC.

## 2. Repository and staging review

Start with a read-only audit of the current TrendPilot branch and staged deployment. Record the commit and baseline test results, including the deployed Bitunix paths. Trace each item below through the screen, API, worker, storage and reporting layers. Mark existing support, hard-coded MEXC assumptions, the required change and the verification method.

| Surface | Review and expected Lighter behavior |
| --- | --- |
| Admin Trading Pairs and strategy packages | Exchange selection includes Lighter. Validation queries its market catalog. Only published, eligible Lighter USDC perps appear for Lighter; status changes block new entries and preserve management of existing exposure. |
| TradingView Webhook and Signal Routes | Separate source chart and destination venue and market fields. Show direction, timeframe, route status, package version and test result. |
| My Account and balances | Link an investor-owned Lighter account through the existing exchange setup. Show venue, environment, connection health and perps collateral in USDC. |
| Trade Settings | New and existing order-block screens, pair search, duplicate/edit flows and validators all use venue-specific instruments. Show USDC order cost, leverage, margin capability, Long/Short permissions, seven selectable weekdays and the existing 24-hour operating-window controls. |
| Dashboard, Holdings and Holdings detail | Live updates without manual refresh. Show exchange, quote currency, freshness, entry, current and mark prices, liquidation where available, margin, SL and target lines, plus trailing TP state. Chart uses Lighter candles. |
| My Trades, history and exports | Show venue and currency on rows, filters, receipts, fees, funding and realized/unrealized P&L. Keep USDC and USDT totals separate unless an approved reporting conversion exists. |
| Platform Operations and workers | Include Lighter feed and account health, entry gates, failed protection, uncertain orders, reconciliation, notifications and audit detail. Check subscriptions, cache keys, job dispatch, storage and API allowlists for venue or currency assumptions. |

Access needed for this review is the current repository and a read-only view of staging or the relevant screens and logs. Public API verification requires network reachability to official endpoints. Validate signing and order behavior later in an isolated test environment. Record any gap between the SRS and the deployed system before proposing repository edits.

## 3. Shared webhook and route rules

- Reuse the existing authenticated TradingView webhook. Validate and durably enqueue before acknowledging. Preserve the payload contract for existing alerts. Capture chart exchange, exact ticker, action, timeframe, reference price, bar time, alert-firing time and receipt time using the existing supported fields. Verify placeholders against an actual alert. Reject unresolved fields, unsupported intervals, unknown routes, old or out-of-order actions and conflicting same-bar events under the existing rules.
- Use approved 5m or 15m Supertrend alerts and the existing confirmed-bar policy. Record upstream delivery lag separately from TrendPilot processing and exchange response times. Use the existing clock and expiry policies where approved. Keep alert reference price available for diagnosis and the optional cross-venue comparison.
- Resolve the full source tuple to explicitly authorized execution destinations. Reuse the current route-link mechanism if it supports this without ambiguity. Verify whether a route can intentionally serve both an existing venue and Lighter. Keep every existing destination and its configuration intact. If the schema supports a single destination only, propose the smallest scoped change for review before editing. Never infer destinations from matching base symbols. Ambiguous or unapproved mappings produce a visible rejection.
- Deduplicate the source event and each investor/destination decision. Evaluate eligible order blocks and route-pinned positions independently. If both MEXC and Bitunix can generate XAU signals for the same Lighter block, select one effective source. Any future failover must be explicitly configured, audited and designed to avoid dual submissions or opposing signals. Preserve valid exit routing for open positions during a source or package change.

## 4. Lighter market data and price comparison

- Use a shared Lighter public WebSocket subscription per environment and market. Maintain order book/ticker, last, mark, index and depth where supported. Key caches and subscriptions by venue, environment and market ID, with candle interval where applicable. Verify supported channels, timestamps, continuity and units against the current API. Use Lighter REST for catalog, candle history, snapshots and recovery within rate limits. Build closed 5m/15m candles from documented Lighter data when native resolution is unavailable, with verified alignment and coverage.
- Track freshness per price series and book. Detect stream gaps, invalid/crossed books and stale candles. Reconnect, resubscribe and obtain a consistent snapshot before resuming entries. A valid same-venue fallback must be fresh and suitable for the specific operation. Show the last known value and its age when stale. Block new exposure on unreliable execution data. Keep native stops active and exit commands available, with live submission dependent on valid Lighter execution inputs. Show and alert if a software exit cannot be evaluated or sent. Record gaps and never invent a crossing or historical fill.
- In the signal log, show the TradingView signal price and timestamp, a comparable Lighter snapshot with price type and timestamp, estimated executable Lighter price and actual Lighter fill. Prefer an aligned Lighter last/close for the cross-venue comparison and use Lighter bid/ask depth for execution. Keep time lag, cross-venue basis and fill slippage separate. Display quote currencies and age on both prices. Calculate percentage deviation only with time-aligned, comparable values and an approved USDT-to-USDC reference convention. Never assume the two quote currencies are interchangeable. If comparison is unavailable, use the approved route policy. A required deviation check fails closed for new entries.
- When EMA 200 is on, apply the existing strategy logic to enough consecutive, closed Lighter candles through the signal bar boundary. Long requires close above EMA, Short below. Equality, gaps or a missing aligned candle block filtered entry by expiry. EMA Off bypasses this filter. Exit eligibility remains independent of EMA. Reuse the existing persistent server-side monitor for TP and trailing TP. Every live price on a Lighter trade must resolve to Lighter, including when a chart or stream reconnects.

## 5. Accounts, sizing and order lifecycle

| Area | Implementation requirement |
| --- | --- |
| Connection and signer | Verify the intended network, account index, API key index and signing credential against the pinned Lighter SDK/API. Use the existing secrets store, with server-side signing and account-scoped read authentication. Verify the available key permissions for signing and reads. Keep wallets, wallet seed phrases, transfers, deposits and withdrawals outside the integration. Avoid exposing signed transactions, credentials or auth tokens in logs and traces. |
| Tenant isolation | Scope accounts, private subscriptions, jobs, data reads and commands by owner, venue, environment and account. Prevent the same verified exchange account from being attached to different investors. Public market data can be shared. Key expiry, rotation, disconnect and revocation must surface any exposure and unresolved orders before operations can be interrupted. |
| USDC sizing and risk | Treat order cost as a USDC collateral budget using the existing sizing policy. Estimate entry from the correct side of the Lighter book at the requested size. Use decimal arithmetic and verified native integer scaling. Apply leverage limits, margin mode, steps, multiplier or base-unit conventions, order minimums, fees and free collateral. Reserve funds per account across concurrent markets. Release or recompute reservations from confirmed outcomes. Require exchange-reported or appropriately labelled liquidation data for the checks that need it. |
| Position and direction rules | Support Long and Short across eligible trades. Verify Lighter’s position mode, including whether simultaneous same-market long and short are possible, before exposing mode controls. If the market uses net exposure, prevent an order from silently netting or reversing a managed position. Unmanaged or uncertain exposure blocks new entries in the affected scope. Live adds require verified aggregate protection and exit allocation. |
| Opening stop | Use a supported native linked entry plus reduce-only stop, submitted together. The public SDK exposes grouped orders. Verify accepted grouping, trigger basis, market bounds, expiry, stop activation, and protection on partial fills for both directions. An acknowledgement alone is insufficient. If required protection cannot be verified, hold live entry for that capability. After a fill, reconcile current size, stop coverage and actual entry. Persist and monitor stop expiry and correct coverage without silently widening or interrupting protection. Apply the approved restoration or emergency reduce-only close procedure for missing coverage. |
| TP and closes | Use Lighter market execution with the verified price bound or IOC behavior for fixed TP, trailing TP, Close on Signal and manual close. Cap each reduce-only exit at confirmed remaining exposure. A trigger or submission acknowledgement does not confirm a fill. For partial fills, reconcile the remainder and native stop before retry. For Close and Reverse, confirm flat and resolve pending orders before rechecking the opposite entry’s age, weekday, direction, feed, funds and risk. |
| Trailing Take-Profit | Preserve the latest requirement for separate Long and Short TP settings and **Target Close within Trailing TP**. Persist activation, favorable high for Long or low for Short, retracement rule, target and remaining allocated size. Verify the production meaning of Target Close, including partial/full behavior and precedence with a trailing or fixed TP trigger, before implementing. Keep the native opening SL in force and account for races between SL and software exits. |
| Idempotency and nonce | Persist intent before signing. Serialize exposure-changing operations per account and market, and coordinate nonce allocation across processes using the same account and API key index. Store stable client order index, transaction hash, exchange order IDs and cumulative fills. On timeout or restart, reconcile transaction, orders, fills and position before any retry. A nonce conflict or unknown acceptance must not create a second order. |
| Account reconciliation | Combine account-scoped private updates with periodic snapshots and recovery after reconnect. Read positions, orders, stops, fills, free balance, actual funding and fees. Deduplicate ledger events. Support manual Sync and automatic recognition of positions closed or reduced directly on Lighter. Update P&L, release reservations and reconcile orphaned orders or stops. Use native fills for realized P&L and display the documented basis for unrealized P&L. |

## 6. Implementation and review sequence

| Step | Authorized scope for a later prompt | Evidence before proceeding |
| --- | --- | --- |
| 0. Read-only discovery | Inspect code, latest migrations, current routes, menus, workers and staging behavior. Validate public Lighter XAU metadata and the actual TradingView test alert. Investigate SDK compatibility with the existing stack, signing boundaries and sandbox limitations. | File and symbol map, venue-by-feature inventory, baseline tests, validated source/target identities, and open decisions. No code edits. |
| 1. Venue and market registration | Add Lighter connection representation, capabilities, catalog and UI/API pair selection. Apply additive schema changes if needed. | Correct Lighter USDC market filtering across admin and investor screens. Existing rows and venue settings continue to load and validate. |
| 2. Public data and holdings display | Wire Lighter feed, snapshots, candle backfill, stale handling, chart overlays and UI updates. | Bid/ask, last and mark traced from Lighter through the backend to the UI. Reconnect and fresh/stale behavior verified. |
| 3. Explicit routing and paper execution | Add approved route links, Supertrend and optional Lighter EMA, sizing, paper positions and all exit paths through the normal webhook. | Known alerts reach only approved blocks. Two investors can process the same signal independently. Duplicate and replay tests prove no duplicate live submissions. |
| 4. Private adapter and protection | Implement signed operations and reconciliation in the approved isolated environment. Verify trade capabilities and failure paths. | Evidence for native entry protection, partial/unknown orders, reduce-only closes, restart, external close, fees and funding. Live entries remain gated until these are proven for the target. |
| 5. Release and operations | Run full regressions and enable the verified XAU route for the approved pilot account and market. Publish the runbook and health checks. | Explicit pilot activation with agreed size and controls. Compare submitted orders, fills, positions and stop coverage with Lighter. Roll back by halting new Lighter entries while keeping protection, closes and reconciliation running. |

Use the existing stack, exchange interfaces, route patterns, storage, risk logic and UI components wherever they fit. Use an official, pinned signer appropriate for the worker runtime. If a sidecar, dependency change, migration of current routes or shared-contract refactor is required, bring the concrete proposal and impact back for a decision.

## 7. Acceptance tests

1. **Discovery and UI.** Lighter appears in every applicable selector and edit flow. A USDT, spot, inactive or wrong-network instrument fails validation. New XAU blocks show USDC anywhere funds or P&L are displayed. Existing MEXC and Bitunix blocks and history load correctly.
2. **Routing and privacy.** One confirmed MEXC or approved Bitunix alert follows the configured Lighter route for 5m and 15m. An unknown or conflicting alert cannot trade. Duplicate deliveries and worker restarts create at most one eligible intent per investor and destination. Two investors’ private credentials, orders and balances stay isolated.
3. **Price integrity.** Simulate TradingView and Lighter prices on opposite sides of the same threshold. Only the configured Lighter trigger can fire a Lighter exit. Verify the chart and live prices update without refresh. A stale stream or gap blocks entries without removing native stops. Test EMA Off, valid aligned data, equality, missing history and an unclosed candle.
4. **Sizing and funds.** Verify USDC rounding, minimums, collateral reservations, leverage and fee assumptions, both sides, insufficient funds, concurrent orders and release after confirmed failure. Check UI P&L, liquidation, fees and applied funding against Lighter records.
5. **Protection and exit.** Verify native opening SL on full and partial fills, correct Long/Short stop and TP behavior, Target Close, market-close bounds, residual size, signal and manual closes, reversal only after confirmed flat, and concurrent SL/TP protection. Test stop expiry, gaps and failure recovery under controlled conditions. Validate pause, weekdays and entry halt while exits remain available.
6. **Recovery and release.** Simulate lost acknowledgements, signer nonce collisions, partial closes, worker restart, stale private data and manual exchange closure. Confirm no duplicate entry, cross-user data exposure, stale funds lock or orphan stop left unresolved. Prove Paper, Demo and replay cannot submit live. Run targeted MEXC and Bitunix regressions, full tests, typecheck and lint, using the repository’s normal commands.

## 8. Decisions to record before live activation

| Decision | Evidence or input needed |
| --- | --- |
| Initial venue and source | Verify Ethereum-based Lighter XAU USDC perp market ID and market rules. Start with the MEXC TradingView chart if the alert payload matches, or approve a verified Bitunix chart. |
| Entry and exit behavior | Confirm supported position and margin modes, native stop activation/expiry, and tested handling of partial fills. Confirm Target Close semantics from the deployed settings or user decision. |
| Guard values | Reuse approved values where appropriate. Record Lighter limits for spread, slippage, signal/feed age, cross-venue deviation and the quote comparison policy, emergency close, and pilot exposure. Avoid inventing defaults for live routing. |
| Migration and rollout | Confirm route cardinality, current storage keys, supported signer runtime, test environment coverage, pilot account and rollback owner. Public documentation establishes candidate API capabilities. Staged evidence establishes readiness. |

## 9. Instructions for Claude Code during implementation

Each future prompt authorizes one numbered step. Follow the step’s stated files or components, behavior, acceptance checks and stopping point. Read the applicable repository instructions and existing implementation first. Apply the minimum changes needed to meet that step.

When the step exposes an ambiguity, missing capability, cross-step dependency or needed behavior change, document the exact file, observed behavior and smallest proposed decision. Stop the affected work for review and continue only independent tasks already authorized for that step. Scope additions, new defaults, architecture changes, commits, deployment and live orders require explicit instruction for the applicable step.

Before stopping, report the files changed, the checks run and their results, observed end-to-end behavior, and unresolved items. Report unverified behavior as such. Finish at the current step and wait for the next prompt.

## References

- [TrendPilot Software Requirements Specification](https://chatgpt.com/library?file_id=libfile_44c2348a99508191b189b243d1e7085b&account_id=personal)
- [TrendPilot Auto Trading Platform Requirements](https://chatgpt.com/library?file_id=libfile_2ef1937f10688191bf7a585c6b53078d&account_id=personal)
- [Lighter documentation](https://docs.lighter.xyz/) · [Lighter mainnet market catalog](https://mainnet.zklighter.elliot.ai/api/v1/orderBooks) · [Official Lighter signer SDK](https://github.com/elliottech/lighter-python/blob/main/lighter/signer_client.py) · [Lighter funding](https://docs.lighter.xyz/trading/funding)
- [TradingView MEXC XAUUSDT.P chart](https://www.tradingview.com/symbols/XAUUSDT.P/?exchange=MEXC) · [TradingView webhook configuration](https://www.tradingview.com/support/solutions/43000529348-how-to-configure-webhook-alerts/) · [TradingView alert behavior and placeholders](https://www.tradingview.com/pine-script-docs/concepts/alerts/)
