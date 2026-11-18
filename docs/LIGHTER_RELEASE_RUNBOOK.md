# Lighter release and activation runbook

Lighter Live is **off by default**. Nothing in this release sends a Lighter order until an operator
sets the Lighter Live scope (server `.env`) **and** records the order capabilities. Protection,
reduce-only closes and reconciliation never depend on the scope.

## 1. Deploy (Lighter orders stay disabled)

On the production server, from the repository root (plain checkout, `.env` holds `DATABASE_URL`):

```bash
git fetch origin && git checkout main && git pull --ff-only
git rev-parse HEAD                       # the revision being deployed
npm ci
npm run ops:lighter-readiness             # BEFORE migrating: lists pending migrations, then stops
npm run db:migrate                        # applies 0031–0033 if pending (additive)
npm run build
pm2 ls                                    # note the process names (web, worker, market:feed)
pm2 restart all --update-env
pm2 ls                                    # all online; exactly one market:feed
```

Keep these UNSET (or `off`) during the checks: `LIGHTER_MAINNET_ORDERS`, `LIGHTER_LIVE_CONNECTIONS`,
`LIGHTER_LIVE_MARKETS`, `LIGHTER_LIVE_ROUTES`.

The PM2 process names are not stored in this repository (no ecosystem file). The existing runbooks
use `pm2 restart all`, and `pm2 ls` should show web, worker and exactly one `market:feed`.

## 2. Post-deploy checks (read-only)

```bash
npm run ops:lighter-readiness             # revision, migrations, settings, capabilities, feeds,
                                          # Lighter connections, Lighter routes and their real alerts
npm run ops:lighter-sync -- --email <investor>   # authenticated Lighter Sync (reads only)
pm2 logs worker --lines 200 | grep -i lighter    # scheduled Lighter sync lines
```

Expect:

- `migrations: … pending: none`; `revision` = the commit you pulled.
- Settings table: `LIGHTER_MAINNET_ORDERS` → `orders disabled`; the price bounds and fee show the
  values you configured (or `INVALID/UNSET`).
- Published contracts: each MEXC, Bitunix and Lighter contract with `ownFeed = true` and a small
  `ageSeconds`.
- Lighter connections: `status VERIFIED`, `env MAINNET`, recent `lastSyncOkAgeS`, `drift 0`.
- Lighter routes: the XAU route, its latest **real** TradingView alerts, and the decision recorded
  for each Lighter block (Paper blocks: their simulated result; Live blocks: `EXCHANGE_NOT_ENABLED`
  with the scope reason while Lighter Live is off).

In the browser: Admin → Market Data shows each contract with its own exchange, price source and feed
status; the Lighter price changes without a page refresh.

## 3. Activation (only with exchange evidence or an explicit supervised-pilot decision)

**Open decision — price comparison.** The XAU route's TradingView reference is MEXC `XAUUSDT.P`
(USDT); the Lighter price is USDC. The 1:1 USDT/USDC comparison is approved for **Paper only**, so in
Live every such entry is refused with `PRICE_COMPARISON_UNAVAILABLE` (see `liveComparison` in
`ops:lighter-readiness`). A Live rule (for example 1:1 parity with a stated tolerance, or a USDC
reference chart) must be decided and implemented before any Lighter Live entry can fill.

1. Record the Lighter capabilities (Admin → Live Trading). `VERIFIED` is accepted **only** with
   `lighter-tx:<hash>` of a Lighter **mainnet** transaction TrendPilot recorded as `EXECUTED`, of the
   matching kind (open-with-stop, close or stop resize). `PILOT_ACCEPTED` is the operator's explicit
   decision to allow a supervised pilot without that evidence.
2. Set the scope in `.env`, then `pm2 restart all --update-env`:
   ```
   LIVE_ORDER_TRANSPORT=enabled
   LIGHTER_MAINNET_ORDERS=enabled
   LIGHTER_LIVE_CONNECTIONS=<connection id from ops:lighter-readiness>
   LIGHTER_LIVE_MARKETS=92
   LIGHTER_LIVE_ROUTES=<route id from ops:lighter-readiness>
   ```
3. Admin approves the Lighter connection with its limits; Admin adds the Lighter XAU contract to the
   Live allowlist; the investor activates Live (exchange Lighter) and activates the Live XAU block.
4. `npm run ops:lighter-readiness`: the per-block verdict for the next alert must read
   `WOULD BE ELIGIBLE`.

## 4. What a supervised mainnet verification must prove (market 92, XAU)

For the first live fill, compare TrendPilot with Lighter (account orders, trades, position):

| Capability | Evidence |
| --- | --- |
| Signed order accepted (`LIGHTER_SIGNER`, `LIGHTER_KEY_MATCH`) | `lighter_txs` row OPEN_WITH_STOP `EXECUTED` with nonce and tx hash; the same tx on Lighter |
| Linked native stop (`LIGHTER_OPEN_WITH_LINKED_STOP`) | child stop on Lighter: reduce-only, trigger price as planned, armed, size = filled size (also after a partial fill) |
| XAU execution (`LIGHTER_XAU_EXECUTION`) | fill price inside `LIGHTER_ENTRY_WORST_PRICE_PCT`; size ≥ market minimum (0.0015 XAU and 10 USDC) |
| Fills and fees (`LIGHTER_FILL_FEES`, `LIGHTER_ORDER_LOOKUP`) | TrendPilot fill and fee = Lighter trades for the order |
| Reduce-only close (`LIGHTER_REDUCE_ONLY_CLOSE`) | CLOSE `EXECUTED`, position flat on Lighter, stop gone, P&L booked once |
| Reconciliation | `ops:lighter-sync` after each step: `ok`, protection `PROTECTED` while open, drift empty, balance = Lighter |
| Stop expiry | stop expiry ≈ placement + 28 days recorded; `LIGHTER_STOP_RENEW_LEAD_HOURS` decided (renewal stays disabled) |

Then record each capability as `VERIFIED` with `lighter-tx:<hash>`.

## 5. Halt and rollback

- **Stop new Lighter entries, keep protection/closes/sync:** remove the account from
  `LIGHTER_LIVE_CONNECTIONS` (or the route from `LIGHTER_LIVE_ROUTES`) and restart, or halt entries
  for the account (Admin → Live Trading, or the investor's Halt). Stops stay on Lighter; closes and
  scheduled sync continue.
- **Stop every Lighter order (closes too):** unset `LIGHTER_MAINNET_ORDERS`. Use only when sending
  itself is suspect; native stops on Lighter keep protecting open positions.
