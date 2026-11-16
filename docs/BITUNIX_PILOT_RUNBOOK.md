# Bitunix supervised live pilot (runbook)

Goal: real-exchange evidence for the Bitunix order capabilities, with the smallest possible risk.
Scope: **one** investor, **one** approved contract, the **smallest exchange-valid quantity**, inside an
**operator-approved exposure limit**, with an operator watching the Bitunix account.

Nothing here runs automatically. The dry run sends no order. `--execute` sends exactly four market
orders (open long, open short, close long, close short), each open with its stop attached.

## 0. Before the pilot (read-only)

1. Deploy the release (git pull on the server; never edit on the server).
2. With a **read-only** Bitunix key (no trade or withdraw permission), on the server or locally:

   ```bash
   BITUNIX_READONLY_API_KEY=… BITUNIX_READONLY_SECRET_KEY=… npm run ops:bitunix-check -- --private-ws-seconds 30
   ```

   Expected output: public contracts and WebSocket OK, signed account / position mode / snapshot OK,
   private WebSocket login and channel frames. Keys, nonces and signatures are never printed. Keep
   the output as evidence for the read-only checks.

## 1. Preconditions (operator)

| Item | Where |
| --- | --- |
| Investor's Bitunix key with trade permission (no withdraw), IP-restricted if possible | Investor → Live Trading → Bitunix Futures connection |
| Bitunix account in **Hedge** mode; same leverage on both legs of the pilot contract; enough USDT for two minimum legs | Bitunix app (TrendPilot never changes account settings) |
| Connection approved with limits; max exposure ≥ the pilot cap | Admin → Live Trading → Connections → Approve |
| Instrument: Bitunix contract published, on the Live allowlist, not fixture | Admin → Instruments / Live Trading → Contracts |
| `BITUNIX_OPEN_WITH_ATTACHED_STOP` and `BITUNIX_HEDGE_CLOSE_BY_POSITION` recorded **PILOT_ACCEPTED** | Admin → Live Trading → Capabilities |
| Fresh Bitunix prices: feed with `BITUNIX_PUBLIC_WS=on` | feed process |
| Investor's Bitunix order blocks **paused** (no signal trading during the pilot) | Trade Settings |

## 2. Dry run (no orders)

```bash
npm run ops:bitunix-pilot -- --investor <investor email> --symbol BTCUSDT --max-exposure 20 --stop-pct 2 --basis MARK
```

Every precondition prints `OK` or `FAIL`. The plan shows the quantity (contract `minQty`), the
per-leg notional and margin, total exposure (both legs), both stops, and the four exact payloads:

1. open long `BUY` + `OPEN`, `slPrice`, `slStopType`, `slOrderType MARKET`
2. open short `SELL` + `OPEN` with its stop
3. close long `BUY` + `CLOSE` + the long `positionId`
4. close short `SELL` + `CLOSE` + the short `positionId`

Fix every `FAIL` before going on.

## 3. Execute (supervised)

On the production server (the order transport opens only with `NODE_ENV=production` and
`LIVE_ORDER_TRANSPORT=enabled`):

```bash
npm run ops:bitunix-pilot -- --investor <investor email> --symbol BTCUSDT --max-exposure 20 --execute --evidence-out bitunix-pilot-evidence.json
```

The run uses the same Bitunix venue as Live (capability gates, Hedge and settings checks, stop in
the entry, closes by positionId). It records, per step:

| Step | Evidence |
| --- | --- |
| open long / open short | order result, the stop **as Bitunix lists it** (id, trigger, position or fixed-quantity), protection `ACTIVE`, how long until the fill appears in trade history, and the order found again **by clientId** |
| both legs | two separate positionIds |
| close long | filled; the short leg's size **unchanged** |
| close short | filled; no leg left |

It stops at the first failed step. Whatever is still open keeps its attached stop. The operator
closes it on Bitunix (or with Close in TrendPilot) and checks the account is flat.

The command prints `bitunix-pilot:<sha256>`, the digest of the evidence file.

## 4. Record the result

1. Review `bitunix-pilot-evidence.json` (sanitized: no keys or signatures). Also confirm on Bitunix:
   - the `fee` sign in trade history (positive = paid?);
   - the `funding` sign on the position history;
   - whether the attached stop is a position TP/SL or a fixed-quantity TP/SL.
2. Admin → Live Trading → Capabilities: record `BITUNIX_OPEN_WITH_ATTACHED_STOP` and
   `BITUNIX_HEDGE_CLOSE_BY_POSITION` as **VERIFIED** with evidence
   `bitunix-pilot:<sha256> + reviewer note`. TrendPilot refuses VERIFIED for a Bitunix capability
   without such a reference.
3. `BITUNIX_TPSL_RESIZE` stays **PENDING** until a separate supervised check shows
   `tpsl/modify_order` keeps the stop and applies atomically. That check is a partial close of a leg
   with a fixed-quantity stop, then a re-read of the pending TP/SL.
4. Run a Bitunix sync for the investor. Holdings, the trade history and the dashboard
   (`/dashboard?mode=live&exchange=bitunix`) show the four fills and fees. Daily funding stays
   *Unknown*.
