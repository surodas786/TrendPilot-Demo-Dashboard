import React, { useMemo } from 'react';
import { usePlatform } from '../../contexts/PlatformContext';
import { buildAlert } from '../../utils/platformText';
import { simNow } from '../../utils/clock';
import { CopyButton } from '../ui/CopyButton';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { ModalHeader } from '../ui/ModalHeader';

export function AlertPreviewModal({ open, onClose }: {open: boolean;onClose: () => void;}) {
  return (
    <Modal open={open} onClose={onClose} labelledBy="alert-preview-title">
      <AlertPreviewBody onClose={onClose} />
    </Modal>);

}

function AlertPreviewBody({ onClose }: {onClose: () => void;}) {
  const { platform } = usePlatform();
  const symbol = platform.pairs.find((p) => p.enabled)?.symbol ?? platform.pairs[0]?.symbol ?? 'BTCUSDT';
  const json = useMemo(() => JSON.stringify(buildAlert(symbol, 'LONG', simNow()), null, 2), [symbol]);
  return (
    <>
      <ModalHeader id="alert-preview-title" title="Alert message preview" description="TrendPilot’s proposed demo message format — not an exchange API format." onClose={onClose} />
      <div className="space-y-3 px-5 py-5 sm:px-6">
        <pre className="scrollbar-thin overflow-x-auto rounded-lg border border-line bg-inset p-3 font-mono text-xs text-ink">{json}</pre>
        <p className="text-xs text-subtle">action is LONG or SHORT. interval is TradingView’s {'{{interval}}'} — 5 or 5m, 15 or 15m. Example generated for {symbol} at the current demo time.</p>
      </div>
      <footer className="flex flex-col-reverse gap-2 border-t border-line px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
        <Button onClick={onClose}>Close</Button>
        <CopyButton text={json} label="Copy JSON" size="md" />
      </footer>
    </>);

}