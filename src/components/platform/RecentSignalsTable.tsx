import React, { useState } from 'react';
import { ChevronDownIcon, RadioTowerIcon, RepeatIcon } from 'lucide-react';
import { toast } from 'sonner';
import { usePlatform } from '../../contexts/PlatformContext';
import { useDemo } from '../../contexts/DemoContext';
import { formatClock } from '../../utils/clock';
import { cn } from '../../utils/cn';
import { normalizeInterval } from '../../utils/platformText';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { StatusPill } from '../ui/StatusPill';
import type { CommonSignal } from '../../types/platform';

const OUTCOME: Record<CommonSignal['outcome'], {label: string;tone: 'gain' | 'warn' | 'loss';}> = {
  accepted: { label: 'Accepted', tone: 'gain' },
  duplicate: { label: 'Duplicate', tone: 'warn' },
  rejected: { label: 'Rejected', tone: 'loss' }
};

/** Compact per-signal processing outcome across subscriber token blocks. */
function ProcessingSummary({ receiptId, accepted }: {receiptId: string;accepted: boolean;}) {
  const { platform } = usePlatform();
  const { state } = useDemo();
  if (!accepted) return <p className="mt-2 text-xs text-subtle">Not processed — only newly accepted signals reach subscriber token blocks.</p>;
  const r = platform.processing.find((x) => x.receiptId === receiptId);
  if (!r) return <p className="mt-2 text-xs text-subtle">No processing record.</p>;
  const name = (id: string) => state.users.find((u) => u.id === id)?.name ?? 'Unknown subscriber';
  return (
    <div className="mt-2 rounded-lg border border-line bg-surface p-3 text-xs">
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-ink">
        <span>Entries opened: <strong>{r.opened.length}</strong></span>
        <span>Positions closed: <strong>{r.closed.length}</strong></span>
        <span>Blocks skipped: <strong>{r.skipped.length}</strong></span>
      </p>
      {r.opened.length === 0 && r.closed.length === 0 && <p className="mt-1 text-subtle">Accepted signals can legitimately produce no trades.</p>}
      {r.skipped.length > 0 &&
      <ul className="mt-2 space-y-0.5 text-muted">
          {r.skipped.map((k) =>
        <li key={k.blockId}>
              <span className="text-ink">{name(k.subscriberId)}</span> · {k.mode === 'live' ? 'Live — simulated' : 'Paper'}: {k.reason}
            </li>
        )}
        </ul>
      }
      {r.notes.map((n) =>
      <p key={n} className="mt-1 text-subtle">{n}</p>
      )}
    </div>);

}

export function RecentSignalsTable() {
  const { platform, receiveSignal } = usePlatform();
  const [open, setOpen] = useState<string | null>(null);

  if (platform.signals.length === 0) {
    return <EmptyState icon={RadioTowerIcon} title="No signals received yet" body="Use Simulate Signal to send a demo message to the common webhook." />;
  }

  const replay = (s: CommonSignal) => {
    receiveSignal(s.message);
    toast('Signal replayed', { description: `${s.message.signal_id} sent again with the same ID.` });
  };

  return (
    <div className="scrollbar-thin overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="text-left text-xs text-subtle">
          <tr className="border-b border-line">
            <th scope="col" className="w-8 px-2 py-2.5"><span className="sr-only">Details</span></th>
            <th scope="col" className="px-3 py-2.5 font-medium">Received (Asia/Dhaka)</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Signal ID</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Pair</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Action</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Result</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {platform.signals.map((s) => {
            const expanded = open === s.id;
            const o = OUTCOME[s.outcome];
            return (
              <React.Fragment key={s.id}>
                <tr>
                  <td className="px-2 py-2">
                    <button type="button" onClick={() => setOpen(expanded ? null : s.id)} aria-expanded={expanded} aria-label={`${expanded ? 'Hide' : 'Show'} message details for ${s.message.signal_id}`} className="flex h-8 w-8 items-center justify-center rounded-md text-subtle hover:bg-inset hover:text-ink">
                      <ChevronDownIcon className={cn('h-4 w-4 transition-transform duration-150', expanded && 'rotate-180')} aria-hidden />
                    </button>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs tabular-nums text-muted">{formatClock(s.receivedAt)}</td>
                  <td className="max-w-[220px] truncate px-3 py-2 font-mono text-xs text-ink">{s.message.signal_id}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-ink">{s.message.symbol}</td>
                  <td className="px-3 py-2">
                    <StatusPill tone={s.message.action === 'LONG' ? 'gain' : 'loss'}>{s.message.action}</StatusPill>
                    <span className="ml-1.5 text-xs text-muted">{normalizeInterval(s.message.interval).timeframe ?? s.message.interval ?? 'no interval'}</span>
                  </td>
                  <td className="px-3 py-2">
                    <StatusPill tone={o.tone}>{o.label}</StatusPill>
                    {s.outcome !== 'accepted' && <p className="mt-1 max-w-[240px] text-xs text-subtle">{s.reason}</p>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button size="sm" variant="ghost" icon={RepeatIcon} onClick={() => replay(s)}>
                      Replay Signal
                    </Button>
                  </td>
                </tr>
                {expanded &&
                <tr className="bg-inset/50">
                    <td />
                    <td colSpan={6} className="px-3 pb-3 pt-1">
                      <p className="text-xs text-muted">{s.reason}</p>
                      <ProcessingSummary receiptId={s.id} accepted={s.outcome === 'accepted'} />
                      <pre className="scrollbar-thin mt-2 overflow-x-auto rounded-lg border border-line bg-inset p-3 font-mono text-xs text-ink">{JSON.stringify(s.message, null, 2)}</pre>
                    </td>
                  </tr>
                }
              </React.Fragment>);

          })}
        </tbody>
      </table>
    </div>);

}