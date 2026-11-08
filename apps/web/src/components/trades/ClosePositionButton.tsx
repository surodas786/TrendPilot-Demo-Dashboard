'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { XCircleIcon } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { api } from '@/lib/api';

/**
 * EXT-07 manual close: asks for confirmation, then requests a simulated reduce-only market close
 * for the confirmed remaining quantity. One idempotency key per confirmation, reused on retry, so a
 * double click or a resent request maps to the same close command.
 */
export function ClosePositionButton({ positionId, symbol, side, contracts }: { positionId: string; symbol: string; side: string; contracts: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const key = useRef<string | null>(null);

  async function confirm() {
    key.current ??= crypto.randomUUID();
    setBusy(true);
    const r = await api.closePosition(positionId, key.current);
    setBusy(false);
    setOpen(false);
    if (r.ok) {
      key.current = null;
      setMessage({ tone: 'ok', text: 'Close requested. The worker submits the simulated market close; refresh to see the fill.' });
      router.refresh();
    } else {
      if (r.status !== 0) key.current = null; // network failure: keep the key so a retry replays
      setMessage({ tone: 'err', text: r.message });
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button size="sm" variant="danger" icon={XCircleIcon} loading={busy} onClick={() => setOpen(true)} data-testid="close-position">
        Close at market
      </Button>
      {message && (
        <span role="status" className={message.tone === 'ok' ? 'text-xs text-muted' : 'text-xs text-loss'} data-testid="close-message">
          {message.text}
        </span>
      )}
      <ConfirmDialog
        open={open}
        title={`Close ${symbol} ${side === 'LONG' ? 'Long' : 'Short'}?`}
        description={`A simulated reduce-only market order closes the remaining ${contracts} contracts at the current paper price. Paper only — no real exchange order is sent.`}
        confirmLabel="Close at market"
        tone="danger"
        onConfirm={confirm}
        onCancel={() => setOpen(false)}
      />
    </span>
  );
}
