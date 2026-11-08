import React from "react";
import { ActivityIcon, LinkIcon, RadioIcon, RefreshCcwIcon, BoxIcon } from "lucide-react";
import { useDemo } from "../../contexts/DemoContext";
import { usePlatform } from "../../contexts/PlatformContext";
import { formatDateTime, formatSyncTime } from "../../utils/clock";
import { connectionHealth } from "../../utils/connectionHealth";
import { Card } from "../ui/Card";
import { HealthBadge } from "../connections/HealthBadge";
import { HealthDimension } from "../../types/trading";
interface Row {
  id: string;
  name: string;
  detail: string;
  icon: BoxIcon;
  dimension: HealthDimension;
  okLabel?: string;
  failedLabel?: string;
}
export function HealthPanel() {
  const {
    account,
    currentUser
  } = useDemo();
  const {
    connectionFor
  } = usePlatform();
  const health = connectionHealth(account);
  // Only a Live — simulated account has a (simulated) private exchange feed. Paper accounts never claim one.
  const conn = connectionFor(currentUser.id);
  const live = account.environment === 'live';
  const privateRow: Row = !live ? {
    id: 'private',
    name: 'Private account feed',
    detail: `Paper account simulation · ${account.name} · no exchange login`,
    icon: LinkIcon,
    dimension: 'ok',
    okLabel: 'Paper simulation'
  } : {
    id: 'private',
    name: 'Private account feed',
    detail: `${conn ? conn.name : 'No exchange connection'} · ${account.name}`,
    icon: LinkIcon,
    dimension: conn?.status === 'connected' ? health.privateFeed : 'failed',
    okLabel: 'Connected — simulated',
    failedLabel: conn ? 'Disconnected' : 'Not configured'
  };
  const rows: Row[] = [{
    id: 'public',
    name: 'Public market feed',
    detail: 'Public simulated prices — available without a connection',
    icon: ActivityIcon,
    dimension: health.publicFeed
  }, privateRow, {
    id: 'sync',
    name: 'Account synchronization',
    detail: 'Balances and positions reconciled',
    icon: RefreshCcwIcon,
    dimension: health.sync,
    okLabel: 'In sync',
    failedLabel: 'Failed'
  }, {
    id: 'signals',
    name: 'Central signal service',
    detail: 'Shared TradingView signals (simulated)',
    icon: RadioIcon,
    dimension: 'ok'
  }];
  return <Card className="flex flex-col p-4 lg:p-5" labelledBy="health-heading">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="health-heading" className="text-sm font-semibold text-ink">
          Connection & signal health
        </h2>
        <span className="text-xs text-subtle">Simulated statuses</span>
      </div>
      <ul className="mt-3 divide-y divide-line">
        {rows.map((row) => {
        const Icon = row.icon;
        return <li key={row.id} className="flex items-start justify-between gap-3 py-2.5">
              <div className="flex min-w-0 items-start gap-2.5">
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-subtle" aria-hidden />
                <div className="min-w-0">
                  <p className="text-sm text-ink">{row.name}</p>
                  <p className="truncate text-xs text-subtle">{row.detail}</p>
                </div>
              </div>
              <HealthBadge dimension={row.dimension} okLabel={row.okLabel} failedLabel={row.failedLabel} />
            </li>;
      })}
      </ul>
      <div className="mt-auto space-y-1 rounded-lg border border-line bg-inset px-3 py-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="text-subtle">Last successful sync</span>
          <span className="font-semibold tabular-nums text-ink">{formatSyncTime(account.lastSyncAt)}</span>
        </div>
        {account.lastSyncAttempt && !account.lastSyncAttempt.ok && <p className="text-loss">
            Last attempt failed {formatDateTime(account.lastSyncAttempt.at)} — {account.lastSyncAttempt.reason}
          </p>}
      </div>
    </Card>;
}