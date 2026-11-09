import Link from 'next/link';
import { ActivityIcon, AlertTriangleIcon, FlaskConicalIcon } from 'lucide-react';
import { getDb, getMyDashboard, listLatestQuotes } from '@trendpilot/db';
import { isIsoDate } from '@trendpilot/domain';
import { PageContainer } from '@/components/layout/PageContainer';
import { LiveQuotesPanel } from '@/components/market/LiveQuotesPanel';
import { FUNDING_LABEL, fmtTime, pnlTone, usdtOrUnavailable } from '@/components/reporting/format';
import { StatusPill } from '@/components/ui/StatusPill';
import { now } from '@/server/clock';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

function Stat({ label, value, tone, testId, note }: { label: string; value: string; tone?: string; testId: string; note?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className={`mt-1 text-lg font-semibold ${tone ?? 'text-ink'}`} data-testid={testId}>
        {value}
      </dd>
      {note && <dd className="mt-1 text-xs text-muted">{note}</dd>}
    </div>
  );
}

/** UI-01 Dashboard: the signed-in investor's own paper totals for one reporting day. */
export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const { user } = await requirePageRole('INVESTOR');
  const { date } = await searchParams;
  const at = now();
  const [d, quotes] = await Promise.all([
    getMyDashboard(getDb(), { id: user.id, timezone: user.timezone }, { now: at, date: date && isIsoDate(date) ? date : undefined }),
    listLatestQuotes(getDb(), at, { publishedOnly: true })
  ]);
  const stale = d.freshness.stale;

  return (
    <PageContainer
      title="Dashboard"
      description="Your own paper balances and results. Daily figures use confirmed paper fills and booked funding for the selected day."
      scope={`${user.name} · My Account · Reporting day ${d.day.date} (${d.timezone})`}
      actions={
        <form className="flex items-end gap-2" method="get">
          <label className="text-xs text-subtle">
            Reporting day
            <input type="date" name="date" defaultValue={d.day.date} className="mt-1 block rounded-lg border border-line bg-inset px-2 py-1.5 text-sm text-ink" />
          </label>
          <button type="submit" className="h-9 rounded-lg border border-line px-3 text-sm font-semibold text-ink hover:bg-inset">
            Show
          </button>
        </form>
      }
    >
      <div className="flex flex-wrap items-center gap-2" data-testid="dashboard-status">
        <StatusPill tone="warn" icon={FlaskConicalIcon}>
          Paper
        </StatusPill>
        <span className="text-xs text-muted">{d.label}</span>
        {d.positions.open > 0 && (
          <StatusPill tone={stale ? 'warn' : 'gain'} icon={stale ? AlertTriangleIcon : ActivityIcon}>
            <span data-testid="price-freshness">{stale ? 'Prices stale or unavailable' : 'Prices fresh'}</span>
          </StatusPill>
        )}
        <span className="text-xs text-subtle" data-testid="last-price-update">
          Last price update: {fmtTime(d.freshness.lastPriceUpdate, d.timezone)}
        </span>
      </div>

      <LiveQuotesPanel initial={quotes} timezone={d.timezone} />

      {!d.account ? (
        <p className="rounded-xl border border-line bg-surface p-4 text-sm text-muted">Your paper account opens with your first paper evaluation.</p>
      ) : (
        <>
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Available balance" value={usdtOrUnavailable(d.account.availableUsdt)} testId="available" note={`Wallet ${usdtOrUnavailable(d.account.walletUsdt)}`} />
            <Stat label="Used margin" value={usdtOrUnavailable(d.account.usedMarginUsdt)} testId="used-margin" note={`Reserved for orders ${usdtOrUnavailable(d.account.orderReserveUsdt)}`} />
            <Stat
              label="Equity"
              value={usdtOrUnavailable(d.account.equityUsdt)}
              testId="equity"
              note={d.account.equityStatus === 'STALE' ? 'Includes stale prices' : d.account.equityStatus === 'UNAVAILABLE' ? 'A position has no price' : 'Wallet + unrealized'}
            />
            <Stat
              label="Unrealized P&L (mark)"
              value={d.unrealized.status === 'NONE' ? usdtOrUnavailable('0') : usdtOrUnavailable(d.unrealized.amountUsdt, true)}
              tone={pnlTone(d.unrealized.amountUsdt)}
              testId="unrealized"
              note={`${d.positions.open} open position${d.positions.open === 1 ? '' : 's'}${d.unrealized.status === 'STALE' ? ' · stale prices' : ''}`}
            />
          </dl>

          <section className="rounded-xl border border-line bg-surface p-4" aria-label="Daily realized P&L" data-testid="daily">
            <h3 className="text-sm font-semibold text-ink">
              Realized on {d.day.date} {d.day.isToday && <span className="text-xs font-normal text-subtle">(today)</span>}
            </h3>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
              <div>
                <dt className="text-xs text-subtle">Gross realized</dt>
                <dd className={pnlTone(d.daily.grossRealizedUsdt)} data-testid="daily-gross">
                  {usdtOrUnavailable(d.daily.grossRealizedUsdt, true)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-subtle">Fees</dt>
                <dd className="text-ink" data-testid="daily-fees">
                  {usdtOrUnavailable(d.daily.feesUsdt)}
                </dd>
                <dd className="text-xs text-muted">
                  entry {d.daily.entryFeesUsdt} · exit {d.daily.exitFeesUsdt}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-subtle">Funding (simulated)</dt>
                <dd className={pnlTone(d.daily.funding.amountUsdt)} data-testid="daily-funding" data-status={d.daily.funding.status}>
                  {usdtOrUnavailable(d.daily.funding.amountUsdt, true)} · {FUNDING_LABEL[d.daily.funding.status]}
                </dd>
                <dd className="text-xs text-muted">{d.daily.funding.statusText}</dd>
              </div>
              <div>
                <dt className="text-xs text-subtle">Net realized</dt>
                <dd className={`font-semibold ${pnlTone(d.daily.netRealizedUsdt)}`} data-testid="daily-net">
                  {usdtOrUnavailable(d.daily.netRealizedUsdt, true)}
                </dd>
                <dd className="text-xs text-muted">Gross − fees + booked funding</dd>
              </div>
              <div>
                <dt className="text-xs text-subtle">Fills</dt>
                <dd className="text-ink" data-testid="daily-fills">
                  {d.daily.entryFills} entry · {d.daily.exitFills} exit ({d.daily.partialExits} partial)
                </dd>
                <dd className="text-xs text-muted">{d.daily.positionsClosed} position(s) closed</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-subtle">
              Day {fmtTime(d.day.from, d.timezone)} to {fmtTime(d.day.to, d.timezone)}. Margin postings and releases are balance movements and are not P&amp;L.
            </p>
          </section>

          <section className="rounded-xl border border-line bg-surface p-4 text-xs text-muted" data-testid="reconciliation" data-ok={String(d.reconciliation.ok)}>
            <span className="font-semibold text-ink">Ledger check: </span>
            {d.reconciliation.ok ? 'Balances match the paper ledger, fills and funding.' : 'A balance does not match the ledger. Contact your administrator.'} Lifetime: opening{' '}
            {d.reconciliation.lifetime.openingBalanceUsdt} · realized {d.reconciliation.lifetime.realizedUsdt} · fees {d.reconciliation.lifetime.feesUsdt} · funding{' '}
            {d.reconciliation.lifetime.fundingUsdt} USDT.
          </section>

          <p className="text-sm">
            <Link href="/my-account#holdings" className="font-semibold text-accent hover:underline">
              Open positions in Holdings
            </Link>
            {' · '}
            <Link href="/my-trades" className="font-semibold text-accent hover:underline">
              My Trades
            </Link>
          </p>
        </>
      )}
    </PageContainer>
  );
}
