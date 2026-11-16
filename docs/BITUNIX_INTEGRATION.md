# Bitunix USDT-M Futures integration

Bitunix is a second exchange next to MEXC. Feature parity with MEXC is the goal across the steps
below.
- Steps 1 and 2 are read-only at the exchange.
- Step 3 adds the Hedge-mode order path behind every existing Live gate. It has been verified with
  fixtures only.
- In every step so far, TrendPilot never changes position mode, leverage or margin mode, and no
  TradingView signal reaches a Bitunix block unless an administrator routes it explicitly (Step 4).

- Step 1: connectivity: connection check, contract discovery, public prices.
- Step 2: read-only account sync: REST reconciliation, the authenticated private WebSocket, and an
  exchange account mirror. See "Step 2" below.
- Step 3: Live account per exchange, Bitunix instruments and quotes, Hedge-mode market orders with
  the stop loss at entry, closes by positionId, and outcome reconciliation. See "Step 3" below.
- Step 4: TradingView routing to Bitunix blocks, Bitunix EMA 200 candles, exits and exchange-side
  closes on Bitunix positions. See "Step 4" below.

No TrendPilot Bitunix starter was available on the build workstation. Signing, WebSocket messages
and fixtures come from the official docs (links below, read 2026-11-16) and from frames and
responses captured from the live public API on the same day.

## Step 1: what exists

| Area | Code | Notes |
| --- | --- | --- |
| Exchange identity, symbols | `packages/domain/src/exchange.ts` | `EXCHANGES = MEXC, BITUNIX`. `bitunixSymbolFor` maps a TradingView source symbol (`BITUNIX:BTCUSDT.P`) to the execution symbol (`BTCUSDT`). The source symbol on signal routes is never rewritten. `marketKey(exchange, symbol)` is the cache key. |
| Signed REST client | `packages/db/src/live/bitunixPrivate.ts` | See "Signing" below. **Read-only transport only:** two allowlisted GETs; everything else is refused before signing. `HTTP` errors (status) are distinct from `API` errors (Bitunix `code`, HTTP 200). Logs and errors never carry the key, nonce or signature (`redactBitunixHeaders`). |
| Read-only connection check | `bitunixReadOnlyCheck`, `packages/db/src/live/bitunixConnection.ts` | `GET /api/v1/futures/account/position_mode` + `GET /api/v1/futures/account?marginCoin=USDT`. Reports the exchange-reported mode verbatim. It never changes it. |
| Connection model | `exchange_connections` (migration `0027`) | One row per (investor, exchange). Existing rows are `MEXC` and unchanged. `connectionFor(db, owner, exchange = 'MEXC')`: every existing Live path (orders, sync, halt, activation, preflight CLIs) still reads only the MEXC row. A Bitunix row cannot be approved, activated, halted or synced (409). Its USDT balance stays in `verification` and is **not** applied to the Live account or ledger. |
| Investor API | `PUT/GET/DELETE /v1/me/exchange-connection[?exchange=BITUNIX]`, `POST /v1/me/exchange-connection/verify[?exchange=BITUNIX]` | No `exchange` given means MEXC (existing clients unchanged). An unknown exchange returns 400. `GET /v1/me/live` adds `bitunix`. UI: Live Trading → "Bitunix Futures connection (Read-only)". |
| Contract discovery | `packages/db/src/market/bitunixPublic.ts` | `trading_pairs` → precision (`basePrecision` → qty step, `quotePrecision` → tick), `minTradeVolume`, `maxMarketOrderVolume`, `maxLimitOrderVolume`, leverage min/max/default, `symbolStatus`, `isApiSupported`, launch/delist time. A contract is eligible when it is USDT, `OPEN`, API-enabled, launched and not delisted. |
| Public WebSocket | `packages/db/src/market/bitunixWs.ts` on `publicStream.ts` | `tickers` (bid / ask / last) and `price` (mark / index / funding) are subscribed and delivered **separately**. Subscribes are batched into one message (Bitunix limit: 5 messages/s, 300 channels per connection). Ping every 15 s; each pong's `ts` gives a clock sample. An empty push is reported as an unsupported symbol. |
| Shared socket lifecycle | `packages/db/src/market/publicStream.ts` | Extracted from `MexcTickerStream`, which now extends it with unchanged messages and logs: connect timeout, silence detection, jittered exponential reconnect, resubscription, confirmation. |
| Market-data cache | `packages/db/src/market/priceCache.ts` | `ExchangePriceCache` keyed `BITUNIX:BTCUSDT` / `MEXC:BTC_USDT`. Book and mark sides are stored apart. A quote is `FRESH` only when both sides are newer than `FEED_POLICY.maxQuoteAgeMs` (the entry limit) and the book is valid. Older exchange timestamps never overwrite newer ones. The MEXC `MarketFeed` now covers `exchange = 'MEXC'` instruments only. |
| Feed process | `apps/worker/src/feed.ts` | `BITUNIX_PUBLIC_WS=on` (default off) runs the Bitunix stream next to MEXC. Prices go to the cache and the `market-feed` heartbeat only; nothing is written to `market_quotes`. |
| Ops check | `npm run ops:bitunix-check -- [--symbols …] [--ws-seconds 15] [--drill] [--public-only]` | Public contracts, public WebSocket (optionally with a reconnect drill), then the private read-only check **only** if `BITUNIX_READONLY_API_KEY` / `BITUNIX_READONLY_SECRET_KEY` are set in the shell. |

### Signing (official sign page; vectors pinned in `packages/db/test/bitunixPrivate.test.ts`)

`digest = sha256hex(nonce + timestamp + apiKey + queryParams + body)`, `sign = sha256hex(digest + secretKey)`.

- Headers: `api-key`, `nonce`, `timestamp` and `sign`, plus `language: en-US` and `Content-Type: application/json`.
- `timestamp`: Unix **milliseconds**. It must be within 60 s of server time (error 10011). The doc's worked example uses `20241120123045`, which contradicts this; the header table wins.
- `nonce`: 32 random hex characters. The limit is under 64 (error 10010).
- `queryParams`: keys sorted in ASCII order, written as `key + value` with **no** separators (`id1uid200`).
- `body`: the exact bytes sent. The client serialises once with `JSON.stringify` (no whitespace), and signs and sends that same string. GET uses `""`.
- The doc prints no expected output. The reference vectors in the test were computed independently with Python `hashlib` from the doc's own inputs.

### Observed on the live API (2026-11-16), not in the docs

- `symbolStatus` also takes `PREVIEW` (listed, not launched yet).
- `launchTime` and `delistTime` are millisecond **strings**. `delistTime` is omitted when unset.
- `defaultMarginMode` is the string `"1"` or `"2"`.
- An unknown symbol in `trading_pairs?symbols=` fails the whole request with code **20015** ("this Futures is not allowed to trade."). Discovery then falls back to the full list.
- The catalogue includes USD-quoted contracts (`BTCUSD`) and 191 of 796 contracts with `isApiSupported: false`.
- WebSocket: the server sends `{"op":"connect"}` on open. **Subscribes are not acknowledged** (unsubscribes are). The ping reply is `{"op":"ping","ts":<ms>,"pong":<s>,"ping":<s>}`. An unknown symbol gets `data: {}` pushes, not an error. The single-symbol `ticker` channel has **no bid/ask**; `tickers` does (`bd` / `ak`).

## Step 1 verification status

| Check | How | Result |
| --- | --- | --- |
| Signature vs fixed vectors, query order, body bytes, redaction | fixtures (unit) | Pass |
| HTTP vs API error handling, timeouts, refused paths | fixtures (unit) | Pass |
| Position-mode and account parsing | fixtures (unit; doc example shapes) | Pass |
| Contract parsing and eligibility, unsupported symbols | fixtures **captured from the live API** | Pass |
| WebSocket parsing, ping/pong, reconnect and resubscribe, silence | captured frames + fake socket | Pass |
| Bitunix/MEXC cache separation | unit | Pass |
| Connection save, verify, isolation, MEXC records preserved, no Live approval | DB integration (`apps/web/test/api/bitunixConnection.test.ts`), mocked Bitunix | Pass |
| Public contracts BTCUSDT, XAUUSDT | **live Bitunix** (`ops:bitunix-check`) | Pass: both OPEN and API-enabled |
| Public WebSocket + reconnect drill | **live Bitunix** (`ops:bitunix-check --drill`) | Pass: both symbols FRESH; resubscribed after drop |
| Authenticated read-only check | live Bitunix | **Pending**: no Bitunix key is configured on this workstation. Run `ops:bitunix-check` with a read-only key in the shell. |

## Step 2: read-only account sync

| Area | Code | Notes |
| --- | --- | --- |
| Read endpoints | `bitunixPrivate.ts` (`BITUNIX_READ_ONLY_PATHS`), `bitunixAccount.ts` | Pending/history positions, pending/history orders, history trades (fills), order detail, pending/history TP/SL, account and position mode. **Queries only:** order, cancel, TP/SL placement, position-mode and leverage paths are not on the allowlist and are refused before signing. Requests are spaced at 110 ms (limit 10/s per UID). A read that fails transiently (10005/10006/10001, 429, 5xx, network, timeout) is retried twice with backoff. A Bitunix refusal (signature, IP, permission, parameter) is never retried. |
| Pagination, completeness | `readAllPages` | `skip` + `limit=100` until a short page or `skip >= total`. Beyond 100 pages the read raises **INCOMPLETE**. A missing list or a malformed row is a PARSE error. A snapshot is all-or-nothing (`takeBitunixSnapshot`). |
| Main account only | `readPendingPositions`, `isSubAccountRow` | Pending positions without `subAccountId` also return sub-accounts the key can reach. TrendPilot sends `includeSubAccounts=false` and drops any row with a non-empty `subAccountId` (the count is stored as `excludedSubAccountRows`). History endpoints return the main account only by default. |
| Schema (migration `0028`) | `exchange_positions`, `exchange_account_events`, `exchange_connections.account_state` / `stream_state` | Additive only. Positions are keyed by (connection, Bitunix positionId), so a symbol's LONG and SHORT legs coexist. Quantities and prices are unscaled `numeric` (exact). IDs are `text`. Events are deduplicated on (connection, dedup_key). Paper and the MEXC Live account never read these tables. |
| Reconciliation | `bitunixSync.ts` | See "Rules" below. |
| Private WebSocket | `bitunixPrivateWs.ts` | `wss://fapi.bitunix.com/private/`, one session per investor connection. Login `sign = sha256(sha256(nonce + unixSeconds + apiKey) + secret)`, separate from the REST signer (ms, sorted query + body). After login it sends one subscribe for `balance`, `order` and `position`; `tpsl` is pushed automatically. Ping every 15 s; a socket silent for 30 s is replaced; jittered backoff reconnect. A rejected login **stops** the session (no retry loop with a bad key). No login answer within 10 s means drop and retry. Pushes outside an authenticated session are ignored. Keys, signatures, nonces and login frames are never logged. |
| Worker | `bitunixSupervisor.ts`, `apps/worker/src/worker.ts` | `BITUNIX_PRIVATE_SYNC=on` (default; `off` disables). One session per VERIFIED Bitunix connection. Every push and every REST reconciliation for a connection runs on one serialized queue. A replaced key (credential rotation) restarts the session. A rejected login waits for a new key or 15 min. Private health goes to `exchange_connections.stream_state`, separate from the public feed heartbeat. |
| API and UI | `POST /v1/me/exchange-connection/sync?exchange=BITUNIX`, `GET /v1/me/exchange-connection?exchange=BITUNIX` (`account`), `GET /v1/me/live` (`bitunixAccount`), admin `…/connections/[id]/sync` | The Live Trading card shows private stream health, the exchange-reported position mode, the last successful sync, the last error, the balance and open positions (both legs). Its **Sync** button runs the read-only reconciliation for that connection only. |
| Ops check | `npm run ops:bitunix-check` | With a read-only key in the shell, it also takes a complete REST snapshot plus 24 h of history, and holds a private WebSocket login for `--private-ws-seconds`. |

### Rules

- **Ordering.** Each position row keeps the exchange time of the state it holds: REST `mtime`, or the push `ts` for position pushes (which carry no modify time; `ts` is gateway time and is used only there). An older update is ignored. A REST snapshot never rolls back a newer push. The balance is replaced only by a newer snapshot or push.
- **Pushes during a snapshot** wait on the connection's queue and are applied after it, with the same time check.
- **Reconnect gap.** Every successful login, at startup and on each reconnect, triggers a full REST reconciliation.
- **Closes.**
  - None of these closes a position; each only sets `close_check = PENDING` and keeps the position OPEN:
    - the position missing from a complete snapshot;
    - a position `CLOSE` push;
    - a quantity of 0.
  - Only a row in **position history** confirms the close. It records the close price, the time, and the settled fee/funding/realized P&L exactly as reported.
  - A failed or incomplete snapshot changes nothing.
  - A smaller quantity is a partial close (`POSITION_REDUCED`, with the exact remaining size).
- **TP/SL.** A `CLOSE`+`FILLED` push is recorded as `TPSL_TRIGGERED` with `execution: PENDING`: the child order was placed. Execution is confirmed only by fills on that position since the trigger (`TPSL_EXECUTED`, with trade IDs and the remaining size). Without fills, nothing about the position changes.
- **Origin.** Client IDs `tp-…`/`tpx-…` are TRENDPILOT. Everything else, and every position change in this release, is EXCHANGE.
- **Fees and funding.** The open position's cumulative values are stored as *reported*. Settlement amounts come only from history; when history omits them they stay null (unknown).
- **Key replacement.** OPEN mirrored positions become DETACHED (no longer read, never reported closed). The account state starts over.

### Observed on the live private endpoint (invalid key, 2026-11-16)

- The server sends `{"op":"connect","data":{"result":true}}` on open.
- The private pong carries no millisecond `ts`, so no clock sample is taken from it.
- A failed login answers `{"op":"login","data":{"result":false,"msg":"invalid params，Authorize: Token invalid",…}}` and the server keeps the socket open.
- Subscribes sent before login are ignored.
- The success frame shape (`result:true`) is inferred and has not been observed: no key was available.

### Step 2 verification status

| Check | How | Result |
| --- | --- | --- |
| WS login signature vs reference vector (Python), seconds vs REST ms | unit | Pass |
| Login failure (captured frame), login timeout, reconnect + re-login, silence | unit, fake socket | Pass |
| Pagination, INCOMPLETE, malformed responses, sub-account exclusion, retries | unit | Pass |
| Both legs, partial and manual closes, history confirmation, incomplete snapshot | DB integration, mocked Bitunix | Pass |
| Duplicate / out-of-order pushes, pushes during snapshot, reconnect gap | DB integration, supervisor with fake stream | Pass |
| Triggered TP/SL with unfilled child, then confirmed by fills | DB integration | Pass |
| Auth failure, credential rotation, investor and exchange isolation | DB integration | Pass |
| Private endpoint reachability + failure frame | live Bitunix, invalid key | Pass |
| Signed REST snapshot, private login + subscribe with a real key | live Bitunix | **Pending**: no read-only key configured |
| Live position events (open / partial / close / TP-SL pushes) | live Bitunix | **Pending**: needs an account with activity |

## Step 3: Hedge-mode execution

**Status:** implemented and verified against a mocked Bitunix exchange. **No real Bitunix order has been sent.** It needs the same gates as MEXC:
- `LIVE_ORDER_TRANSPORT=enabled` in production;
- the platform Live switch;
- the Bitunix capabilities recorded as `VERIFIED` or `PILOT_ACCEPTED`;
- an approved Bitunix connection in Hedge mode;
- the investor's own Bitunix activation;
- the contract on the Live allowlist.

| Area | Code | Notes |
| --- | --- | --- |
| Live account per exchange | `paper_accounts.exchange` (migration `0029`), `lockPaperAccount(…, exchange)`, `accountExchangeFor` | One account per (investor, mode, exchange). Existing rows read as MEXC with unchanged ids and values (tested on a scratch database upgraded from 0028). Paper stays MEXC-only. A Live order uses the account of its instrument's exchange. Bitunix sync applies the Bitunix balance to the Bitunix Live account (available-to-open = available + negative cross unrealized P&L). |
| Resolution | `resolveAccountVenue`, `liveEntryEligibility`, `liveGuardedVenue` | Order → account → exchange → that investor's connection for that exchange → venue. The Live guard re-checks gates, limits (counting the leg being opened), halts and the position mode per exchange. A Bitunix intent can never reach the MEXC venue (`LIVE_EXCHANGE_MISMATCH`). |
| Instruments and prices | `bitunixInstruments.ts`, `POST /v1/admin/instruments/bitunix`, `bitunixQuotes.ts`, feed process | Bitunix contracts become separate instruments (exchange `BITUNIX`, contract multiplier 1, base-coin step 10^-basePrecision, minimum opening quantity, maximum market quantity, price tick, leverage choices). They start DISABLED and not allowed for Live. Fresh joined Bitunix quotes (book + mark) are stored as `BITUNIX_PUBLIC` (channel WS), at most once per second, and only for Bitunix instruments. **`BITUNIX_PUBLIC_WS=on` is required in the feed process**; without it Bitunix entries expire as `FEED_STALE` and the feed logs a warning. |
| Sizing | existing `evaluatePaperEntry` | Unchanged cost-based sizing on the instrument row: quantity = cost × leverage / executable price, floored to the base-coin step, checked against min/max. The venue rounds down again, then re-checks min/max and **available margin from Bitunix** before sending. |
| Settings | `checkTradingSettings` (`GET account/trading_settings`) | Margin mode (ISOLATION/CROSS) and the leg's leverage (`longLeverage` / `shortLeverage`) must equal the order's. A mismatch is refused (`BITUNIX_SETTINGS_MISMATCH:…`). TrendPilot never calls change-leverage, change-margin-mode or change-position-mode. |
| Order transport | `BitunixOrderTransport` | Exactly one order path (`trade/place_order`) plus the read allowlist. It is gated by `openLiveOrderTransport` at construction and on every POST. A POST is never retried. Cancel, flash-close, close-all, TP/SL modify and every account-setting change are refused before signing. The read-only check and sync keep using the read-only transport. |
| Payloads | `buildBitunixOpenOrder`, `buildBitunixCloseOrder` | Open long `BUY`+`OPEN`; open short `SELL`+`OPEN`; close long `BUY`+`CLOSE`+long positionId; close short `SELL`+`CLOSE`+short positionId. All are `MARKET` with `clientId` = the intent's stored client order ID. Entries carry `slPrice` (rounded to the tick without widening, and checked against the side), `slStopType` (MARK → MARK_PRICE, LAST → LAST_PRICE; INDEX is refused) and `slOrderType=MARKET`. |
| Hedge mode | `bitunixVenue` | `position_mode` is read before every open and close. Anything but HEDGE is refused (`POSITION_MODE_MISMATCH:<mode>`), recorded on the connection, and halts entries. |
| Closes | `placeReduceOnlyClose` | Before sending, the leg is re-read: it must be the stored positionId (a stale or closed ID sends nothing, and a newer leg is never closed in its place) and the right side. The quantity is capped at what the leg holds now. One unresolved order per (account, contract) (existing unique index) serializes a manual close against a stop or target exit. A close is recorded only when the venue confirms the leg flat (existing `recordExitFill`). |
| Outcome | `getOrder` by clientId, `fillOf`, `attachedStop` | Fills come from trade history for the order (`bitunix:<orderId>`), so a partial fill opens exactly the filled quantity. Protection is the leg's pending TP/SL, polled because it may appear late; one without `slQty` covers the whole leg. Missing protection leaves the position UNPROTECTED, queues the emergency close and halts entries (existing policy). On a timeout, network error, 5xx or duplicate clientId (30042), the order is looked up by clientId: if found it is reconciled; if not it stays SUBMITTING with its reservation (`UncertainSubmissionError`), and entries halt. After the 30 s grace period, an order still absent is refused by the halted guard and the reservation is released (outcome: never accepted). |

### Step 3 verification status

| Check | How | Result |
| --- | --- | --- |
| Four exact payloads, both legs on one symbol, close of one leg leaves the other untouched | venue tests + flow test (mocked exchange) | Pass |
| Stale or wrong positionId, close capped at the leg, competing closes serialized | venue + flow | Pass |
| One-Way refusal, leverage / margin mismatch (never changed), missing settings | venue + flow | Pass |
| Quantity rounding and min/max, stop rounding and side check, INDEX basis refused, margin check | venue | Pass |
| Stop loss in the entry request; protection verified; late protection found; missing → UNPROTECTED + emergency close + halt | venue + flow | Pass |
| Partial fill, duplicate clientId, timeout before / after acceptance, reservation kept until the outcome is known | venue + flow | Pass |
| Investor and exchange isolation (B's key, MEXC Live account, Paper untouched) | flow | Pass |
| Migration 0029 on existing MEXC Paper/Live accounts, ledger and connection | scratch database | Pass |
| Order transport gate and allowlist; signed body bytes | unit | Pass |
| Order submission on live Bitunix | — | Not attempted (fixtures only, as required) |
| Signed REST snapshot and private WebSocket with a real key | live | **Pending**: no read-only key configured |

## Step 4: signals, EMA 200 and exits on Bitunix

| Area | Code | Notes |
| --- | --- | --- |
| Routing | `signal_route_targets`, `signal_events.target_instrument_ids` (migration `0030`), `routeTargets.ts`, `PUT /v1/admin/signal-routes/[id]/bitunix-target` | The webhook and alert format are unchanged. A route keeps its MEXC instrument and can name **one** explicit Bitunix target: the same contract (same platform symbol), and Bitunix instruments only. Intake snapshots the enabled targets on the event, so a re-run dispatch reaches the same blocks. Dispatch serves the primary instrument plus the targets; a block belongs to one instrument (one exchange) and decisions are unique per (event, block, step), so each block is evaluated once. Without a target nothing changes. Admin → Signals shows each route's exchange and execution symbol, with *Also route to Bitunix* / *Pause* / *Remove*. |
| Signal logs | `assessEntry` | Same reason codes as MEXC, with context added: `exchange`, `executionSymbol`, `priceSource`, and for `FEED_STALE` either `feed: NO_PRICE_EVER` (feed off or not covering the contract) or `STALE` / `NO_RECENT_PRICE`. `PRICE_DEVIATION` keeps the 0.5 % tolerance against the block's own exchange price. A timeframe mismatch is `STRATEGY_MISMATCH` (screen) and is also refused when a route is configured. Missing routing: an alert without a route is `ROUTE_NOT_FOUND` (intake log), and the investor's editor warns *No TradingView route delivers signals to this contract*. |
| EMA 200 | `bitunixKlines.ts`, `MarketFeed({ exchange: 'BITUNIX' }).candleCycle()`, feed process | `GET /api/v1/futures/market/kline` (open time in ms, sent as a string; exclusive `endTime`; ≤ 200 per page; closed candles only; newest first on the live API), checked against the docs and the live API. The shared candle sync (backfill, gaps, late revisions) writes `BITUNIX_PUBLIC` candles on the Bitunix instrument. The EMA algorithm is unchanged and never mixes sources or instruments. A missing, stale or short history skips the entry with `EMA_UNAVAILABLE`; a block with EMA off is unaffected. |
| Exits | existing exit rules + Step 3 venue | Bitunix quotes create `market.tick` jobs, so per-side take profit, target close inside Trailing Take Profit, trailing, close-on-signal and close-and-reverse run unchanged and close via `BUY`/`SELL` + `CLOSE` on the current positionId and remaining size. The entry stop stays attached. Reversal refreshes the **Bitunix** balance and opens the new leg only after the closed leg is confirmed flat; a partial or uncertain close keeps it withheld (`REVERSAL_CLOSE_INCOMPLETE`). |
| Exchange-side closes | `bitunixPositionSync.ts` (run by every Bitunix sync) | Links the Step 2 mirror to TrendPilot positions by (connection, positionId). Each closing Bitunix order is booked once as `bitunix:<orderId>`, the same key TrendPilot's own closes use: manual (`EXTERNAL_CLOSE`), the exchange stop (`STOP_LOSS`, when a TP/SL trigger preceded it) and liquidation. A full close needs the history-confirmed mirror, so a TP/SL trigger alone closes nothing. Fills not yet listed leave the difference pending. After a partial close it reports protection as `WHOLE_LEG` (follows the leg) or `FIXED_QTY` (cannot be resized in this release: UNPROTECTED, existing recovery). |
| Investor UI | Trade Settings, Live Trading | The pair list labels Bitunix pairs; the editor shows exchange, execution symbol and TradingView sources; block rows show `Bitunix · BTCUSDT`. Live mode on a Bitunix pair needs the Bitunix connection (server and editor). |

### Step 4 verification status

| Check | How | Result |
| --- | --- | --- |
| Shared webhook → MEXC route only; then with an explicit Bitunix target, both; each block once; duplicate alert | DB e2e through the real webhook, mocked orders | Pass |
| Price gap and stale Bitunix price with exchange context | e2e | Pass |
| EMA on: missing Bitunix candles skip; after Bitunix backfill the filter passes; MEXC candles untouched. EMA off unaffected | e2e | Pass |
| Long and short: target close then trailing take profit through the Bitunix close path | e2e | Pass |
| Close-and-reverse: partial close withholds; full close then the new leg | e2e | Pass |
| Manual partial close on Bitunix (once, whole-leg protection, other leg untouched); TP/SL trigger alone closes nothing; stop execution closes once | e2e | Pass |
| Kline parsing and paging against live captures | unit | Pass |
| Public Bitunix prices and candles in the local feed (`BITUNIX_PUBLIC_WS=on`) | **live Bitunix**, local dev DB | Pass |
| Signed REST, private WebSocket, real orders | live | **Pending**: no read-only key; orders mocked by design |

## Remaining work

| Area | What remains |
| --- | --- |
| Live verification | Signed REST snapshot and private WebSocket with a read-only key; a supervised smallest-size pilot to record the two Bitunix capabilities. The pilot must confirm close long = `BUY`+`CLOSE`, how the attached TP/SL is listed, fill visibility delay, `clientId` limits and the private-login success frame. |
| TP/SL resize | A fixed-quantity Bitunix TP/SL cannot be modified (no order-changing TP/SL path); after a partial close such a position is UNPROTECTED (existing recovery policy). |
| Reporting | Holdings, trades and reconciliation views read the MEXC account; the Bitunix Live account needs its own views (liquidation price, fees and funding from Bitunix records). |
| Funding | Bitunix funding history is not read yet; Paper/MEXC funding is unchanged. |

Docs: [sign](https://www.bitunix.com/api-docs/futures/common/sign.html) ·
[position mode](https://www.bitunix.com/api-docs/futures/account/get_position_mode.html) ·
[single account](https://www.bitunix.com/api-docs/futures/account/get_single_account.html) ·
[trading pairs](https://www.bitunix.com/api-docs/futures/market/get_trading_pairs.html) ·
[WebSocket](https://www.bitunix.com/api-docs/futures/websocket/prepare/WebSocket.html)
