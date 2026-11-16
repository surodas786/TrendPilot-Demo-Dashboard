# Bitunix USDT-M Futures integration

Bitunix is a second exchange next to MEXC. Feature parity with MEXC is the goal across the steps
below. **Step 1 (this change) is read-only connectivity:** no Bitunix order is placed, no position
mode or leverage is changed, and nothing is routed to Bitunix.

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

## MEXC dependencies, by later step

| Step | What depends on MEXC today and must change |
| --- | --- |
| 2. Instruments and market data | `instruments.exchange` is always `MEXC`. Pair validation (`contractCatalog.ts`, `normalizePairInput` → `BTC_USDT`) and `mexcFixtures.ts` are MEXC-only. **Bitunix quantities are in base coin**, with no contract multiplier: model as `contractMultiplier = 1`, `qtyStep = 10^-basePrecision`, `minQty = minTradeVolume`, `maxQty = maxMarketOrderVolume` (market orders). `MarketFeed` writes `market_quotes` / candles / funding with `source = 'MEXC_PUBLIC'`. A Bitunix feed needs its own source label, REST klines (5m/15m closed bars for EMA 200) and funding history. Its stream must persist through `ingestStreamTicker`'s rules once a Bitunix quote is a joined book + mark. `MARKET_SOURCES`, admin market-data and pairs pages. |
| 3. Account model and routing | `paper_accounts` is unique on (owner, mode): one LIVE account per investor, implicitly MEXC. A Bitunix Live account needs its own balance, ledger and positions (add `exchange` to the account key, or a per-connection account). `order_blocks` / signal routes pick an instrument, and the venue comes from the account. Per-investor routing to Bitunix needs instrument → exchange → that investor's connection. `resolveAccountVenue`, `liveGuardedVenue`, `liveAccountGate`, capability evidence (`live_control` is MEXC capabilities), `LIVE_EXCHANGE` in `liveMode.ts`. |
| 4. Orders | A `bitunixVenue` implementing `ExecutionVenue`: place with attached stop (Bitunix TP/SL fields), market close, reduce-only, `clientId` idempotency (30042 duplicate), position-mode-aware sides for One-way vs Hedge, leverage and margin mode set per symbol, rate limits (10005 / 10006 / 10009). An ORDERS transport gated by `openLiveOrderTransport`, as on MEXC. Position-mode change only as an explicit account action (20009 when positions exist). |
| 5. Exits, sync, reverse | `liveSync.ts` (MEXC positions, stops, deals, funding `holdFee`, drift), `closeRejection.ts` (MEXC codes), `SyncWithMexcButton`, close-and-reverse sequencing, trailing TP and target close against Bitunix closes, exchange-side close detection. |
| 6. Reporting | Holdings chart, liquidation price, fees and funding from Bitunix records. Labels that say "MEXC" across investor pages. |

Docs: [sign](https://www.bitunix.com/api-docs/futures/common/sign.html) ·
[position mode](https://www.bitunix.com/api-docs/futures/account/get_position_mode.html) ·
[single account](https://www.bitunix.com/api-docs/futures/account/get_single_account.html) ·
[trading pairs](https://www.bitunix.com/api-docs/futures/market/get_trading_pairs.html) ·
[WebSocket](https://www.bitunix.com/api-docs/futures/websocket/prepare/WebSocket.html)
