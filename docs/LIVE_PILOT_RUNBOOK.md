# TrendPilot live pilot — operator runbook (Step 12)

**Status: NOT READY for the first live trade. Live order submission is disabled in this build.** This runbook is the procedure for the first supervised pilot once the blockers in §1 are cleared in a separately reviewed release. It was rehearsed end to end with mocked MEXC responses (dry run, `apps/web/test/api/pilotRehearsal.test.ts`; transcript `test-results/pilot-rehearsal.md`). Do not place a real order until the operator approves the first trade in writing.

Related: `docs/MEXC_PRIVATE_ADAPTER.md` (endpoints, capability matrix), `docs/STAGING.md` (deployment, Operations view, backups), `docs/BUILD_CHECKPOINT.md` (status).

## 0. Pilot scope (fixed for the first pilot)

| Item | Value |
| --- | --- |
| Investors | **One** approved investor (allowlist; every other investor is refused `PILOT_INVESTOR_NOT_ALLOWLISTED`) |
| Exchange account | **One** verified MEXC Futures account, identified by a non-secret reference (UID suffix) |
| Contract | **One** approved contract (e.g. BTCUSDT → `BTC_USDT`) |
| Limits (operator-approved) | Max contracts per order, max notional per order (USDT), max leverage (≤ 20, recommended ≤ 5), max total exposure (USDT) |
| Adds | **Off** (database constraint; an entry while a position is open is refused `PILOT_ADDS_DISABLED`) |
| Automatic reversal | **Off** (database constraint; activation refused for a `CLOSE_AND_REVERSE` strategy version) |
| Authorization | Platform approval by an administrator **and** explicit activation by the investor, both audited |
| Stops | Every opening order carries `stopLossPrice` in the same request; a fill without a verified stop is closed immediately and halts entries |

Recommended first-pilot limits: 1–2 × the contract minimum per order, leverage ≤ 3x, exposure ≤ the per-order notional (no second position).

## 1. Preconditions (all must be PASS before the first trade)

Check: `GET /v1/admin/live-pilot` → `readiness.items` (stage `FIRST_TRADE`). Today:

| Item | Today | Who clears it |
| --- | --- | --- |
| Written MEXC confirmation that the account may place automated futures orders for this use (MEXC restricts "bot trading, or algorithmic trading"; API access "primarily available to institutional users") | **Missing** | Release owner with MEXC (institution@mexc.com) |
| KYC complete; API key with only the needed permissions; IP whitelist | **Missing** | Investor + operator |
| `npm run ops:mexc-readonly-check` passes on the pilot account | **Pending** (no read-only key) | Operator |
| Position mode recorded (one-way preferred) and matching the adapter | **Pending** | Operator |
| Contract spec equals the platform instrument | Pending (public spec matches BTC today) | Operator |
| Account flat at start (no position, no resting order) | Pending | Operator |
| Read capabilities verified on the account (signing, balances, positions, position mode) | Pending | Operator, via the read-only check |
| Encrypted, access-restricted storage for the pilot API key (OPS-01) | **Not built** | Engineering (reviewed release) |
| LIVE mode allowed for the pilot investor's order block | **Not built** (`ALLOWED_MODES` is PAPER only) | Engineering |
| `venueForMode('LIVE')` builds the pilot-guarded MEXC venue | **Not built** (fails closed by design) | Engineering |
| Build gate `LIVE_ACTIVATION_ALLOWED_IN_THIS_BUILD` | **Closed** | Engineering, under review |
| Operator tool to record an exchange-side manual close (drift) when TrendPilot cannot close | **Not built** | Engineering (see §7) |
| Operator approval of the first supervised trade | **Not given** | Operator, in writing |

## 2. Enable the approved pilot

All admin calls are authenticated admin API requests (or the equivalent admin screen once built); record evidence as references, never as credentials.

1. **Define the pilot**
   ```
   POST /v1/admin/live-pilot
   { "investorId": "<uuid>", "instrumentId": "<uuid>", "exchangeAccountRef": "MEXC UID …4821",
     "maxOrderContracts": "2", "maxOrderNotionalUsdt": "20", "maxLeverage": 3, "maxExposureUsdt": "20" }
   ```
   Refused if a pilot is already open, the investor is not active, the contract is not published with a MEXC symbol, or the limits are invalid.
2. **Run the read-only check** on the pilot account from the operator host (key exported in the shell only, never in a file under the repository):
   ```sh
   MEXC_READONLY_API_KEY=… MEXC_READONLY_SECRET_KEY=… npm run ops:mexc-readonly-check -- --symbol BTC_USDT
   ```
   Every line must be `OK`; position mode recorded; open positions `none`; stop orders `none`; contract spec `matches`.
3. **Record the six checks with evidence** (one call each):
   ```
   POST /v1/admin/live-pilot/checks  { "check": "ELIGIBILITY_CONFIRMED", "passed": true, "evidence": "MEXC email ref …, 2026-…" }
   ```
   `ELIGIBILITY_CONFIRMED`, `KYC_AND_KEY_PERMISSIONS`, `READ_ONLY_CHECK`, `POSITION_MODE`, `CONTRACT_SPEC_MATCH`, `ACCOUNT_FLAT_AT_START`.
4. **Platform authorization:** `POST /v1/admin/live-pilot/approve` (refused until all six are passed).
5. **Investor activation:** the investor signs in and calls `POST /v1/me/live-pilot/activate` (refused for any other investor, before approval, or if the order block has adds on, a reversing strategy, leverage above the limit, or another contract).
6. **Reviewed live release** (engineering, not an operator switch): credential store, LIVE mode for the pilot block, live venue wiring through `pilotGuardedVenue(mexcVenue(…))`, and the build gate. Deploy it to the pilot environment only.
7. **First-trade approval:** the operator approves the first trade in writing (date, contract, max size). Until then the readiness item `FIRST_TRADE_APPROVAL` stays MISSING.

## 3. Verify the first fill and its attached stop on MEXC

Have both screens open before the alert: TrendPilot *Operations*, *My Trades → trade detail* (investor) and the MEXC Futures web UI for the pilot account (*Positions*, *Open orders → TP/SL*, *Order history*, *Trade history*).

Within **60 seconds** of the fill, confirm all of the following; any mismatch → abort (§5):

| Check | TrendPilot | MEXC |
| --- | --- | --- |
| Position side and size | Trade detail: side, *Remaining contracts* | *Positions*: direction, quantity (contracts) |
| Average entry | *Average entry* | *Positions*: entry price |
| Stop exists, close-only, right side of entry | *Stop loss*: price, basis; *Protected · covers N* | *Open orders → TP/SL*: stop-loss trigger price, trigger type (**Fair/Mark** or **Last** as configured), quantity |
| Stop covers the filled quantity (also on a partial fill) | *covers N* = remaining contracts | TP/SL quantity = position quantity |
| Order and fills | *Fills*: one fill, fee | *Order history*: one order with the client order ID (`tp-…`), *Trade history*: deals and fees |
| No other orders or positions | Operations: no alerts | No other position or order on any contract |

Also run `npm run ops:mexc-readonly-check -- --symbol BTC_USDT` and compare: one position, one stop order with the expected `SL` price, basis and `vol`.

Record the observations (screenshots, order IDs) against the capabilities in `docs/MEXC_PRIVATE_ADAPTER.md` §5 (`OPEN_WITH_ATTACHED_STOP`, `READ_STOP_ORDERS`, `READ_ORDER_BY_CLIENT_ID`, `READ_FILLS`).

## 4. Halt new entries

Any of these stops new entries at once; protection, stop resizing and every close (take profit, close on signal, manual close, emergency close) keep working:

- Operator: `POST /v1/admin/live-pilot/halt { "reason": "…" }`
- Investor: `POST /v1/me/live-pilot/halt` (only an operator can resume)
- Automatic: a fill without a verified stop (`PROTECTION_FAILURE …`) or an uncertain submission (`UNCERTAIN_ORDER …`) halts the pilot by itself.
- Investor withdrawal: `POST /v1/me/live-pilot/deactivate` (no new entries; closing stays available).

Resume (operator only): `POST /v1/admin/live-pilot/resume { "note": "…" }` — refused while any order is unresolved or an open position is not protected.

## 5. Abort criteria

Halt entries (§4) and, unless the position is verified protected and correct, close it (§6) when any of these occurs:

- The stop is not visible at MEXC within 60 s of the fill, its quantity differs from the position, its price or trigger type is wrong, or it is not close-only.
- TrendPilot shows `UNPROTECTED`, an emergency close (`PROTECTION_FAILURE`), or an order stuck `SUBMITTING` for more than 2 minutes.
- MEXC and TrendPilot disagree on position side, size or entry, or an unexpected order, position or opposite-side exposure appears.
- MEXC returns signature/permission errors (602, 406, 511), maintenance (604, 801, 11444), repeated rate limits (510, 2037), or any account restriction or freeze notice.
- The Operations view shows the worker or feed not reporting, a DEAD job, or stale prices while a position is open.
- Fill price differs from the alert reference by more than the strategy's price-deviation limit.
- The investor or operator asks to stop.

## 6. Restore protection or close when TrendPilot cannot

Prefer TrendPilot's own close first (*My Trades → Close position*, or the admin halt plus a close-on-signal). If TrendPilot cannot act (worker down, uncertain state, API errors), act directly on MEXC — **close first, restore second**:

1. **Close the position at market (preferred):** MEXC Futures → *Positions* → the pilot contract → *Close* → *Market* → full quantity. Confirm *Positions* is empty and no TP/SL or order remains (*Open orders*: cancel any).
2. **Or restore the stop** (only if keeping the position is explicitly intended): *Positions* → *TP/SL* → stop-loss at the recorded TrendPilot stop price, trigger type matching the plan (Fair/Mark or Last), quantity = full position, market execution. Confirm it appears in *Open orders → TP/SL*.
3. **Stop all API activity if anything is unexplained:** in MEXC → *API Management*, delete (or disable) the pilot API key. This also blocks TrendPilot.
4. **Record it:** halt the pilot (§4) with the reason, note the MEXC order IDs and times. TrendPilot does not yet sync private account state, so an exchange-side close leaves the platform position `OPEN` (drift) — keep the pilot halted and end it (`POST /v1/admin/live-pilot/end`) until the operator drift tool (§1) exists.

## 7. End of pilot: confirm flat

1. Halt entries (§4), then ensure every TrendPilot position on the contract is `CLOSED` (*My Trades*).
2. MEXC UI: *Positions* empty for the account; *Open orders* and *TP/SL* empty.
3. Read-only check: `open positions: none`, `stop orders: none`.
4. Compare TrendPilot fills, fees and realized P&L with MEXC *Trade history* (same order IDs, deal quantities, fee sign and currency); record differences.
5. Investor `POST /v1/me/live-pilot/deactivate`; operator `POST /v1/admin/live-pilot/end`.
6. Optionally delete the API key in MEXC.

## 8. Dry run vs. real pilot

| Check | Dry run (mocked MEXC) | Needs the real pilot |
| --- | --- | --- |
| Pilot allowlist, approval + activation, roles, audit | **Passed** | — |
| Opening request carries the stop (redacted request shown) | **Passed** | MEXC creates the stop atomically and lists it |
| Stop coverage = confirmed fill, incl. partial fill | **Passed** (mock attaches for the filled quantity) | Real partial-fill stop behaviour |
| Take profit and close on signal: reduce-only market closes that cannot flip | **Passed** | `reduceOnly` / close-side behaviour in the account's position mode |
| Final position, fees, P&L reconcile with exchange records | **Passed** (against mock deals) | Fee sign/currency, deal records, funding |
| Missing stop → emergency close + entries halted | **Passed** | How a real attachment failure is reported |
| Timeout after submission → halt, reconcile before any retry | **Passed** | Real read-after-write delay; unknown-ID response (2040?) |
| Worker restart after fill → reconciled once | **Passed** | — (platform behaviour) |
| Limits refuse oversize, over-leveraged and add entries | **Passed** | — |
| Closing available while entries are halted | **Passed** | — |
| Account eligibility, key permissions, IP whitelist | n/a | **Required** |
| Read-only account check | n/a (pending) | **Required** |
| Duplicate `externalOid` rejected by MEXC | n/a | Observe (not relied on) |
| Stop resize after partial close at MEXC (auto-shrink vs re-place, gap length) | Passed (both modelled) | **Required** |
| Rate limits and maintenance behaviour | Partly (codes mapped) | Observe |
