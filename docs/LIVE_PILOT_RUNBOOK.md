# TrendPilot Live — operator runbook

**Status (2026-11-12): the Live path is implemented and ships switched OFF.** Every gate below defaults to Off. No real order has ever been sent. Real-order testing is a separate, operator-led pilot that starts only after the owner has reviewed several days of Paper results and approved it in writing.

Related: `docs/MEXC_PRIVATE_ADAPTER.md` (endpoints, docs review, capability matrix), `docs/STAGING.md` (deployment and backups), `docs/BUILD_CHECKPOINT.md` (status and evidence).

## 0. How Live works and what stops it

Paper and Live are one application. The same TradingView alert, strategy rules, public MEXC price feed, durable order intents and worker drive both. Each investor has a **separate Live account** in TrendPilot: its own balance (synced from MEXC), orders, fills, positions and ledger. Live orders go to the investor's **own** MEXC Futures account through the signed private API.

A Live **opening** order (new entry, or the opening leg of a reversal) is sent only if ALL of these hold, checked when the signal is evaluated and again in the worker right before sending:

| # | Gate | Default | Who controls it |
| --- | --- | --- | --- |
| 1 | `LIVE_ORDER_TRANSPORT=enabled` on the server (production process only) | `disabled` | Server operator (env + restart) |
| 2 | Platform Live switch on, platform entries not halted | Off | Admin → Live Trading |
| 3 | The four order capabilities recorded `VERIFIED` or `PILOT_ACCEPTED` (needed to switch 2 on) | none recorded | Admin → Live Trading |
| 4 | Investor's MEXC connection `VERIFIED` (read-only checks passed) | not connected | Investor → Live Trading |
| 5 | Account approved by an admin, with limits: max contracts/order, max notional/order, max leverage, max total exposure | not approved | Admin → Live Trading |
| 6 | Investor activated Live, account entries not halted | Off | Investor → Live Trading |
| 7 | Contract on the Live allowlist (published, validated against MEXC, not fixture metadata) | none | Admin → Live Trading |
| 8 | Investor's Live order block is Active; trading days / trading window allow it | Paused | Investor → Trade Settings |
| 9 | Order carries its stop loss; size, notional, leverage, exposure within the limits (exposure uses MEXC's position) | — | Enforced by the worker |

**Never gated:** stop resize, take profit, trailing take profit, close on signal, manual close, emergency close. Halting or switching Live off stops new entries only.

**Automatic protection:**
- The stop loss is attached to the opening request (`stopLossPrice`, `lossTrend`). After the fill TrendPilot verifies, at MEXC, an ACTIVE, non-reversing stop covering exactly the filled contracts on the correct side of the entry. Otherwise it closes the position at market at once (`PROTECTION_FAILURE`) and halts that account's entries.
- Timeouts, network errors and 5xx responses are uncertain. TrendPilot never resends blindly. It looks the order up by client order ID (`tp-…`), halts the account's entries (`UNCERTAIN_ORDER`), and only treats the order as absent after 30 s.
- The private sync runs every 30 s (`LIVE_SYNC_MS`) for each Live account. It:
  - matches the wallet to MEXC;
  - stores the liquidation price and funding;
  - books exchange-side closes (a triggered stop as `STOP_LOSS`; a manual MEXC close as `EXTERNAL_CLOSE`);
  - re-verifies stop coverage;
  - records **drift**, meaning MEXC and TrendPilot disagree. Drift halts the account's entries until an admin reviews it.

## 1. Before activation (all must be true)

| Item | State on 2026-11-12 | Who |
| --- | --- | --- |
| Owner reviewed several days of Paper results and approved a supervised Live pilot in writing (date, investor, contract, max size) | **Pending** | Owner |
| Written MEXC confirmation that the account may place automated futures orders for this use (MEXC restricts "bot trading, or algorithmic trading"; API access is "primarily available to institutional users") | **Pending** | Owner with MEXC (institution@mexc.com) |
| Investor account: KYC complete; one-way position mode; API key with View Account Details + View Order Details + Order Placing only (never withdrawal), IP-whitelisted to the server's public IP | **Pending** | Investor |
| Read-only check on that account passes (`npm run ops:mexc-readonly-check`, or *Save and check* on the Live Trading page) | **Pending** (no key) | Operator |
| `DATA_ENCRYPTION_KEY` set on the server (32 bytes, base64). It seals API keys at rest; losing it means re-entering keys | Required in production; check the server | Operator |
| Server migrated to `0020_m10_live_mode` and running this release | **Not deployed yet** | Operator |
| Server can reach `https://api.mexc.com` (and its public IP is the one whitelisted on the key) | Check | Operator |

## 2. Deploy the release (Live stays Off)

On the server (`192.168.91.16`, PM2):
```sh
git fetch && git checkout <release commit>
npm ci && npm run db:migrate && npm run build
pm2 restart all
curl -s http://localhost:3000/v1/health
#   {"status":"ok",...,"mode":"PAPER","liveOrderTransport":"disabled"}
```
`LIVE_ORDER_TRANSPORT` must still be `disabled` in the server's `.env`. Paper keeps running unchanged.

## 3. Set up one pilot account (still no orders possible)

1. **Contract.** In Admin → Trading Pairs, validate and publish the contract against MEXC (e.g. BTCUSDT → `BTC_USDT`). Then go to Admin → Live Trading → *Contracts allowed for Live* and allow it. Fixture-only contracts cannot be allowed.
2. **Investor connects.** The investor opens **Live Trading** in the sidebar and enters:
   - an account reference (UID suffix, never a key);
   - the API key;
   - the secret.

   Then they press **Save and check**.
   - TrendPilot seals both values with AES-256-GCM and runs read-only calls: position mode, balances, open positions and stops.
   - The connection becomes `VERIFIED` (or `FAILED`, with the MEXC code).
   - The key is never shown again; only `…1234` is displayed.
3. **Admin approves with limits.** Admin → Live Trading → *Investor MEXC accounts* → enter the limits → **Approve with these limits**.
   - Recommended first pilot: 1–2 × the contract minimum per order, notional ≤ 20 USDT, leverage ≤ 3x, exposure = per-order notional.
4. **Investor creates a Live order block.** Trade Settings → Add → Trading mode **Live (MEXC)**. The settings are the same as for Paper, and Paper blocks stay separate. Save it **paused** for now.
5. **Capability evidence.** Admin → Live Trading → *MEXC order capabilities*. With an operator note (e.g. "Supervised pilot approved by owner 2026-11-xx, ref …"), press **Pilot** on:
   - `OPEN_WITH_ATTACHED_STOP`
   - `REDUCE_ONLY_CLOSE`
   - `STOP_RESIZE_AFTER_PARTIAL_CLOSE`
   - `CANCEL_STOP`

   After the pilot proves each one on MEXC, re-record it as **Verified** with the order IDs.

## 4. Activate (owner decision; supervised)

Do these in order, with the operator watching:
1. **Server transport.** Set `LIVE_ORDER_TRANSPORT=enabled` in the server `.env`, then run `pm2 restart all --update-env`.
   - `/v1/health` must show `"liveOrderTransport":"enabled"`.
   - Worker log: `live order transport enabled`.
2. **Platform switch.** Admin → Live Trading → enter a note → **Switch Live on**.
3. **Investor activation.** Investor → Live Trading → **Activate Live trading** (with confirmation).
4. **Resume the block.** Investor → Trade Settings → resume the Live order block.
5. Investor → Live Trading should now read "New Live entries are allowed…".

Nothing is sent until the next matching TradingView alert passes every Paper rule and every Live gate.

### First fill: verify within 60 seconds (any mismatch → §6)

| Check | TrendPilot | MEXC web UI |
| --- | --- | --- |
| Side and size | My Holdings → **Live** tab → position | Positions: direction, quantity |
| Average entry | Holding detail | Positions: entry price |
| Stop exists, close-only, right side, covers the position (also after a partial fill) | Holding: *Protected · covers N* | Open orders → TP/SL: SL price, trigger type (Fair/Mark or Last), quantity = position, not reversing |
| One order with the client ID | My Trades → **Live** → trade → fills | Order history: one order `tp-…`; Trade history: deals, fee |
| Nothing else open | Admin → Operations: no Live alerts | No other position/order on any contract |

Record the order IDs against the capabilities (§3.5) and in `docs/MEXC_PRIVATE_ADAPTER.md` §5.

## 5. Monitoring

- **Admin → Operations:** Live alerts appear here. They cover:
  - open Live positions while the transport is off;
  - unprotected Live positions;
  - drift per account;
  - halted accounts;
  - sync errors;
  - stale feed;
  - DEAD jobs.
- **Admin → Live Trading:**
  - the switch and halt state;
  - each account's status, last sync and drift details;
  - **Sync now**, which runs the private sync on demand.
- **Worker log:** `pm2 logs worker | grep -E "live sync|paper order|paper close"`. Lines for Live orders contain `LIVE_REFUSED:` (gate refusals), `UNCERTAIN_ORDER` and `PROTECTION_FAILURE`. Sync lines read `live sync <owner>: exitsRecorded=… protectionFailures=… drift=…`.
- **Feed:** Market Data Feed must stay HEALTHY on WebSocket with REST ticker = 0 (Live and Paper share it).
- **Health:** `/v1/health` → `liveOrderTransport` and `mode` (`PAPER_AND_LIVE` when the transport and platform switch are both on).

## 6. Halt, emergency close, restore

**Stop new entries (closes keep working). Use the narrowest control that fits:**
- One account: Admin → Live Trading → account → **Halt entries**, or the investor presses **Halt new entries**.
- Everyone: Admin → Live Trading → **Halt all new Live entries** (note required).
- Investor withdraws: **Turn Live off**.
- Resume is admin-only and needs a note. It is refused while an order is unresolved, a Live position is unprotected, or drift is open.

**Close a position:**
1. Prefer TrendPilot: My Trades → **Live** → trade → **Close position**. This sends a reduce-only market close capped at the MEXC position.
2. If TrendPilot cannot act (worker down, errors), close on MEXC: Positions → contract → **Close** → **Market** → full quantity. Then cancel any leftover TP/SL under Open orders.
   - The next sync books the exchange close (`EXTERNAL_CLOSE`, or `STOP_LOSS` if the stop fired). No manual bookkeeping is needed.
   - Check Admin → Live Trading: no drift. If there is drift, review it, then **Clear reviewed drift** with a note.
3. If the position must stay open but is unprotected (only when keeping it is intended), restore the stop on MEXC: Positions → TP/SL → SL at the recorded TrendPilot stop price, same trigger type, full quantity, market. Then run **Sync now**.

**Last resort, everything stops:**
- Delete the API key in MEXC → API Management. This stops TrendPilot reaching the account at all.
- Or set `LIVE_ORDER_TRANSPORT=disabled` and run `pm2 restart all --update-env`.
- Both also stop TrendPilot's closes. The MEXC stops stay at the exchange and keep protecting open positions. Close manually on MEXC if needed.

**Abort triggers:**
- the stop is not visible at MEXC within 60 s of a fill, or its quantity or price is wrong;
- an order stays `SUBMITTING` for more than 2 minutes;
- MEXC and TrendPilot disagree (drift);
- signature or permission errors (602, 406, 511);
- maintenance (604, 801, 11444), or repeated rate limits (510, 2037);
- the worker or feed stops reporting while a position is open;
- the investor or operator asks to stop.

## 7. End the pilot / deactivate

1. Halt entries (§6) and close Live positions. Confirm My Trades → **Live** shows none open and MEXC shows no positions or orders.
2. Investor: **Turn Live off**. Admin: **Switch Live off** (note). Optionally **Remove approval**.
3. Set `LIVE_ORDER_TRANSPORT=disabled` and restart, if Live will not be used for a while.
4. Optionally the investor removes the key on the Live Trading page (refused while Live exposure remains), and deletes it on MEXC.
5. Compare TrendPilot Live fills, fees and realized P&L (Dashboard → **Live**, reconciliation) with MEXC Trade history.

## 8. Evidence: mock vs read-only vs live pilot

| Behaviour | Mock (automated, this repo) | Read-only account | Live pilot |
| --- | --- | --- | --- |
| Gates: transport, platform switch/halt, approval, activation, allowlist, limits, ownership | **Passed** (`liveMode.test.ts`, `live.test.ts`) | — | — |
| Credentials sealed at rest, never returned by any API | **Passed** | — | — |
| Opening order with `stopLossPrice` in the same request; stop covers the confirmed (partial) fill | **Passed** | — | **Pending** (atomicity, listing under `orderId`) |
| Reduce-only market close (`side 4/2`, `reduceOnly`, `positionId`) for manual close and TP | **Passed** | — | **Pending** |
| Stop resized to the remainder after a partial TP (cancel + place, `stopLossReverse: 2`) | **Passed** | — | **Pending** (auto-shrink vs re-place, gap) |
| Missing stop → emergency close + account halt | **Passed** | — | Observe |
| Timeout after accept → halt, reconcile by client ID, one order; still invisible after grace → no resend, drift flagged | **Passed** | — | **Pending** (real visibility delay, unknown-ID code 2040) |
| Exchange-side stop / manual close booked once by the sync; wallet = MEXC balance; liquidation + funding stored | **Passed** | Pending | **Pending** (deal history shape, `holdFee` sign) |
| Unknown exposure → drift → halt until reviewed | **Passed** | — | — |
| Two investors on the same contract: separate exchange accounts and records | **Passed** | — | — |
| Signing, position mode, balances, positions, stops read | Passed (mock) | **Pending** (no key configured) | — |
| Account eligibility for automated orders | — | — | **Pending — MEXC written confirmation** |
