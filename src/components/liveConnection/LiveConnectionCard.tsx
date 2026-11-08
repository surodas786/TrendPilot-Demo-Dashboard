import React, { useEffect, useRef, useState } from 'react';
import { FlaskConicalIcon, PencilIcon, PlugIcon, PlugZapIcon, UnplugIcon } from 'lucide-react';
import { toast } from 'sonner';
import { usePlatform } from '../../contexts/PlatformContext';
import { formatClock } from '../../utils/clock';
import { formatUserDate } from '../../utils/userDirectory';
import { Button } from '../ui/Button';
import { StatusPill } from '../ui/StatusPill';
import type { ExchangeConnectionMeta } from '../../types/platform';

interface Props {
  conn: ExchangeConnectionMeta;
  onEdit: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
}

export function LiveConnectionCard({ conn, onEdit, onReconnect, onDisconnect }: Props) {
  const { recordConnectionTest } = usePlatform();
  const [testing, setTesting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const connected = conn.status === 'connected';

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  // Repeats a simulated check on saved metadata only — credentials are never retrieved.
  const test = () => {
    setTesting(true);
    setNote(null);
    timer.current = window.setTimeout(() => {
      recordConnectionTest(conn.subscriberId);
      setTesting(false);
      setNote('Demo metadata check passed. Saved credentials were not retrieved or re-sent.');
      toast.success('Demo connection check passed');
    }, 800);
  };

  return (
    <section aria-labelledby="conn-card-title" className="rounded-xl border border-line bg-surface p-4 lg:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-accent/40 bg-accent/10 text-accent">
            <PlugZapIcon className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h3 id="conn-card-title" className="truncate text-base font-semibold text-ink">
              {conn.name}
            </h3>
            <p className="text-sm text-muted">MEXC Futures</p>
          </div>
        </div>
        <StatusPill tone={connected ? 'gain' : 'neutral'} icon={connected ? PlugIcon : UnplugIcon}>
          {connected ? 'Connected — simulated' : 'Disconnected'}
        </StatusPill>
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-subtle">Demo API key</dt>
          <dd className="font-mono text-ink">{conn.maskedKey}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle">Last simulated test (Asia/Dhaka)</dt>
          <dd className="text-ink tabular-nums">{conn.lastTestAt ? `${formatUserDate(conn.lastTestAt)} · ${formatClock(conn.lastTestAt)}` : '—'}</dd>
        </div>
      </dl>

      {!connected && <p className="mt-3 text-xs text-muted">New simulated live entries using this connection are blocked. Existing positions remain open.</p>}
      {note &&
      <p role="status" className="mt-3 text-xs text-gain">
          {note}
        </p>
      }

      <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
        {connected ?
        <>
            <Button size="sm" icon={PencilIcon} onClick={onEdit}>
              Edit
            </Button>
            <Button size="sm" icon={FlaskConicalIcon} onClick={test} loading={testing}>
              Test Connection
            </Button>
            <Button size="sm" variant="ghost" icon={UnplugIcon} onClick={onDisconnect} className="text-loss hover:text-loss">
              Disconnect
            </Button>
          </> :

        <Button size="sm" variant="primary" icon={PlugIcon} onClick={onReconnect}>
            Reconnect
          </Button>
        }
      </div>
    </section>);

}