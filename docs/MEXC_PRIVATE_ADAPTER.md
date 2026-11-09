# MEXC Futures private adapter (Step 11) — pilot handoff

**Live order submission is disabled.** `openLiveOrderTransport()` refuses in every environment of this build (`LIVE_ACTIVATION_ALLOWED_IN_THIS_BUILD = false`), and `venueForMode('LIVE')` refuses before any adapter is built. No real order was submitted and no credentials exist in the repository. Docs read on **2026-11-09** from the official MEXC Futures API documentation.

Code: `packages/db/src/live/mexcPrivate.ts` (signing, transports, normalization), `packages/db/src/live/mexcVenue.ts` (the `ExecutionVenue` implementation), `packages/db/src/live/capabilities.ts` (capability registry and gate), `packages/db/src/venue/*` (the exchange interface shared with the paper simulator), `packages/db/src/cli/mexc-readonly-check.ts` (read-only account check).

## 1. Account eligibility (blocker for any live order)

| Source | What it says |
| --- | --- |
| [Integration guide](https://www.mexc.com/api-docs/futures/integration-guide) | "To create/enable futures order placement permissions, the account must first complete KYC verification." |
| [Update log](https://www.mexc.com/api-docs/futures/update-log) | Order placement/cancellation paused from 2022-07-25; "Futures Trading API maintenance ended; trading access reopened" (2026-03-31). Base domain changed to `https://api.mexc.com` (2026-01-19). |
| [Announcement, 2026-05-26](https://www.mexc.com/announcements/17827791531135) | "API access applications are primarily available to institutional users"; restricts "API abuse, bot trading, or algorithmic trading"; violations: "the account will be frozen immediately". Institutional route: KYB + qualification review (institution@mexc.com). |

**Not established by the docs:** whether a retail investor account may run TrendPilot's automated, signal-driven orders. Written confirmation from MEXC for the pilot account and use is required before Step 12 sends any order.

## 2. Signing (documented, implemented, mock-verified)

`Signature = hex(HMAC-SHA256(secretKey, accessKey + Request-Time + parameterString))`; headers `ApiKey`, `Request-Time` (ms string), `Signature`, optional `Recv-Window` (≤ 60 s; default window 10 s), and `Content-Type: application/json` for POST. GET/DELETE parameter string: business parameters sorted by name, `k=v` joined with `&`, nulls omitted; POST: the exact JSON body string; no parameters: `""`. Credentials stay in the transport; errors and logs carry path and MEXC code only (`redactHeaders`).

## 3. Operations

| Operation | Endpoint | Request fields used | Normalized to | Not established by the docs |
| --- | --- | --- | --- | --- |
| Balances | `GET /api/v1/private/account/assets` | — | currency, equity, available, availableOpen, positionMargin, frozen, unrealized, bonus | — |
| Positions | `GET /api/v1/private/position/open_positions` | `symbol` | positionId, side (positionType 1/2), contracts (holdVol), avg entry, liquidation (isolated), leverage, margin mode, margin, realized, funding | Undocumented sample fields |
| Position mode | `GET /api/v1/private/position/position_mode` | — | `HEDGE` (1) / `ONE_WAY` (2) | Order create defaults to hedge when `positionMode` is omitted; the adapter always sends it |
| Open + stop | `POST /api/v1/private/order/create` | `symbol`, `price` (executable quote; marked required), `vol` (contracts), `leverage` (required to open), `side` 1 open long / 3 open short, `type` 5 market, `openType` 1 isolated / 2 cross, `externalOid` (= client order ID), `stopLossPrice`, `lossTrend` 1 last / 2 fair (mark) / 3 index, `positionMode` | `SimResult` (FILLED with fill + stop, or REJECTED) | Whether the attached stop is created atomically, for the filled quantity on a partial fill, and appears in `stoporder/open_orders`. Rate limit 4 / 2 s |
| Close (TP, signal, manual, reversal) | `POST /api/v1/private/order/create` | `side` 4 close long / 2 close short, `type` 5, `vol` ≤ venue position, `positionId`, `reduceOnly: true` in one-way mode, `externalOid`, `positionMode` | `CloseResult` (FILLED / PARTIAL / REJECTED) | `reduceOnly` "applies only in one-way mode"; hedge-mode close sides are relied on not to open the opposite side (not stated). No documented code for "reduce-only would increase position" |
| Order by client ID | `GET /api/v1/private/order/external/{symbol}/{externalOid}` | — | state 1 pending, 2 unfilled, 3 filled, 4 canceled, 5 invalid; dealVol, dealAvgPrice, fees | Response for an unknown ID (adapter treats error **2040** "order not exist" as absent); read-after-write delay |
| Fills | `GET /api/v1/private/order/deal_details/{orderId}` | — | deals de-duplicated by deal `id`; fee positive = paid | Pagination; `isTaker` vs `taker` |
| Stops (read) | `GET /api/v1/private/stoporder/open_orders` | `symbol` | stopId, orderId, positionId, side, stopLossPrice, basis (lossTrend), vol, state (1 untriggered … 5 failed) | Whether order-attached stops are listed, and whether their `vol` tracks partial closes |
| Stop resize | `POST /api/v1/private/stoporder/cancel` then `POST /api/v1/private/stoporder/place` | cancel `{orders:[{stopPlanOrderId}]}`; place `positionId`, `vol`, `volType` 1, `stopLossPrice` (same trigger), `lossTrend`, `profitTrend`, `stopLossType` 0 | new stop reference | Whether position stops shrink automatically; place-before-cancel can exceed "closable quantity", so cancel-then-place leaves a short unprotected gap |
| Leverage, risk limits | `GET /api/v1/private/position/leverage`, `GET /api/v1/private/account/risk_limit` | `symbol` | read-only check only | — |

Relevant error codes (official error-code page): 401/402 auth, **602** signature, **406** IP not whitelisted, 511 no permission, **510** rate limit (also seen on public endpoints in Step 10), 2037/2036 order frequency/daily cap, 2005 balance, **2040** order not exist, 2008 insufficient closable, 2009 position not exist, 2015 precision, 2006 leverage, 3009/3004/5001/9075 stop price, 6001/6002 trading forbidden, **604/801/11444 maintenance**, 500/501 (outcome may be unknown).

## 4. Execution rules implemented

- **Exchange interface:** the entry submit, exits and reversal flows call `ExecutionVenue` only; Paper uses the simulator (`paperVenue`), Live the adapter (`mexcVenue`). Durable `order_intents` and the existing worker drive both.
- **Capability gate:** an order is sent only when every capability it needs is `VERIFIED` on a live pilot. Today nothing is, so the adapter returns `REJECTED CAPABILITY_UNVERIFIED:OPEN_WITH_ATTACHED_STOP` (or `…:REDUCE_ONLY_CLOSE`) without contacting MEXC.
- **Stop in the same request:** an opening order without `stopLossPrice` is refused locally (`STOP_REQUIRED`).
- **Stop verification:** after a fill the stop must be listed `ACTIVE`, on the opposite side, for the filled contracts, on the right side of the entry. Otherwise the position is `UNPROTECTED` and an **emergency close** (`PROTECTION_FAILURE`) is queued immediately (OPS-03).
- **Uncertain submission:** on timeout, network error or 5xx the adapter only looks the order up by `externalOid`; it never resends. If MEXC has not acknowledged it, the intent stays `SUBMITTING`; the next attempt reconciles first and resubmits only after `reconcileGraceMs` (30 s) with the order still absent. A failing lookup keeps the intent unresolved (no resubmission).
- **Closes cannot flip:** volume is capped at the venue position on that side; close sides 4/2; `reduceOnly` in one-way mode; hedge-mode accounts holding both sides are refused.
- **Partial close:** the stop is resized to exactly the remainder at the same trigger and re-verified; an auto-shrunk stop is accepted as-is.
- **Duplicates:** fills are keyed `mexc:<orderId>` and deals de-duplicated by deal ID, so a re-delivered deal or a repeated reconciliation books once.

## 5. Capability matrix

`documented` = official docs establish the endpoint and fields · `mock` = exercised by the adapter tests against mocked responses · `read-only` = checked on an explicitly authorized read-only account · `live pilot` = observed on an authorized live pilot (Step 12).

| Capability | Documented | Mock | Read-only account | Live pilot |
| --- | --- | --- | --- | --- |
| Signed requests | Yes | Verified | Pending | Pending |
| Read balances | Yes | Verified | Pending | Pending |
| Read positions | Yes | Verified | Pending | Pending |
| Read position mode | Yes | Verified | Pending | Pending |
| Read order by client order ID | Partial (unknown-ID response) | Verified | Pending | Pending |
| Read fills | Partial (pagination) | Verified | Pending | Pending |
| Read stop orders | Partial (attached stops listed?) | Verified | Pending | Pending |
| Open with attached stop | Partial (fields only) | Verified | n/a | **Pending — entry blocked** |
| Reduce-only close | Partial (hedge mode) | Verified | n/a | **Pending — closes blocked** |
| Stop resize after partial close | Partial | Verified | n/a | **Pending — resize refused** |
| Cancel stop | Yes | Verified | n/a | Pending |
| Client order ID idempotency | **No** | Verified (adapter never resends blind) | n/a | Pending |
| Account eligibility (KYC, automated use) | Partial | n/a | Pending | **Pending — MEXC confirmation required** |

Read-only account check: **pending** — no explicitly authorized read-only account is configured for this project (`MEXC_READONLY_API_KEY` is not set). Run when one is: see §6.

## 6. Read-only account check (when authorized)

Create an API key with **only** "View Account Details" and "View Order Details" permissions (no "Order Placing"), IP-whitelisted to the operator host. Then, outside the repository:
```sh
MEXC_READONLY_API_KEY=… MEXC_READONLY_SECRET_KEY=… npm run ops:mexc-readonly-check -- --symbol BTC_USDT
```
It uses the READ_ONLY transport (allowlisted GETs only; it cannot send an order) and prints: position mode, balances, open positions, current stop orders, leverage and risk limit for the contract, and compares the public contract spec with the platform instrument. Keys are read from the environment only and never printed.

## 7. What Step 12 must verify before expanding live access

1. **Eligibility:** written confirmation from MEXC that the pilot account may place automated futures orders for this use; KYC complete; API key permissions and IP whitelist as required.
2. **Read-only check** (§6) passes on the pilot account: position mode (prefer one-way to match TrendPilot's one-way exposure, or confirm hedge-mode close behaviour), isolated margin, leverage within the block, contract spec equals the platform instrument.
3. **Attached stop**, with the smallest size on the pilot contract: open Long and Short with `stopLossPrice`; confirm the stop is listed in `stoporder/open_orders`, its `orderId`/`positionId`, `vol` = filled contracts, `lossTrend` honoured, and the stop is close-only. Repeat on a partial fill if one can be produced safely.
4. **Unknown order ID:** confirm the exact response of `order/external/{symbol}/{id}` for an ID that was never submitted (expected 2040), and the read-after-write delay after `order/create`.
5. **Duplicate externalOid:** confirm whether MEXC rejects a second order with the same `externalOid` (the adapter does not rely on it).
6. **Closes:** reduce-only partial close, then full close: no opposite position opens; `vol` above the position is rejected (2008); behaviour of the position stop after the partial close (auto-shrink vs. explicit resize) and the size of any unprotected gap during cancel-then-place.
7. **Fills and fees:** deal records, fee sign and currency, funding (`holdFee`) against the platform ledger.
8. **Rate limits and outages:** 4 orders / 2 s on create; behaviour on 510 and maintenance codes (604/801/11444): entries halt, protection and closes stay available.
9. Only then set the capability's `livePilot` evidence to `VERIFIED` (with the observation recorded), change `LIVE_ACTIVATION_ALLOWED_IN_THIS_BUILD` under review, and enable `LIVE` mode for the pilot investor only.
