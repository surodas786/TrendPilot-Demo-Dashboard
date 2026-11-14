# Hedge-mode pilot (MEXC_SURODAS)

TrendPilot follows the position mode MEXC reports for each investor connection. One-way accounts
keep working as before. Nobody's MEXC mode is changed by TrendPilot.

## What Hedge mode does in TrendPilot

| | One-way (positionMode 2) | Hedge (positionMode 1) |
|---|---|---|
| Open | side 1 long / 3 short, stop attached | same, stop attached |
| Close | side 4 long / 2 short, `reduceOnly: true` | side 4 long / 2 short, **no** `reduceOnly` |
| Close binding | MEXC `positionId` of the matched leg | MEXC `positionId` of the matched leg (Long and Short are separate legs) |
| Close size | ≤ holdVol − frozenVol of that leg | same |
| Margin mode | `openType` of the MEXC position | same |

* **Mode checks.** The mode is read from MEXC at Save and check, on every sync, and right before every
  order. If it differs from the verified mode, nothing is sent (`POSITION_MODE_MISMATCH:<mode>`).
  The sync records the new mode, reports `POSITION_MODE_CHANGED` drift and halts new entries.
* **One leg at a time.** TrendPilot manages at most one leg per investor and contract. An opposite
  signal under KEEP_OPEN keeps holding.
* **Reversals.** A reversal opens the opposite leg only after MEXC reports the original leg flat
  and its stop gone.
* **An opposite leg that already exists.** If MEXC already holds an opposite leg, the block's
  "add to position" rule decides; with adds off, the reversal is withheld
  (`REVERSAL_OPPOSITE_LEG_EXISTS`).
* **Legs TrendPilot didn't open.** A leg opened directly on MEXC is reported as drift (entries
  halted) and is never closed, resized or cancelled by TrendPilot.

## Switch-over (you change the mode on MEXC)

1. Deploy, then confirm the revisions:
   ```
   git pull && npm ci && npm run db:migrate && npm run build && pm2 ls    # restart web and worker
   psql "$DATABASE_URL" -c "select instance, started_at, detail->>'revision' from service_heartbeats where service='worker' order by last_seen_at desc limit 3"
   ```
   The web revision is `webRevision` in Admin → Operations (`GET /v1/admin/operations`).
2. Keep MEXC_SURODAS's investor halt on.
3. MEXC does not allow changing the mode with open positions or orders: the account must be flat
   on all contracts.
4. Switch the MEXC Futures account to Hedge.
5. Run the read-only checks:
   ```
   npm run ops:live-sync -- --email <investor>                # records HEDGE, POSITION_MODE_CHANGED drift (entries stay halted)
   npm run ops:live-sync -- --email <investor>                # second run: no mode drift
   npm run ops:live-preflight -- --email <investor> --symbol XAU_USDT --side LONG --mexc
   npm run ops:live-preflight -- --email <investor> --symbol XAU_USDT --side SHORT --mexc
   npm run ops:live-position-check -- --email <investor> --symbol XAU_USDT
   ```
   Expect `mexc.positionMode` and `storedPositionMode` to both read `HEDGE`, and no
   `mexc: position mode` blocker. The only remaining blocker should be the investor halt, which
   you lift yourself.
