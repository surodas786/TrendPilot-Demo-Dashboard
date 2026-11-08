import React, { useState } from 'react';
import { InfoIcon, PlugZapIcon, PlusIcon } from 'lucide-react';
import { toast } from 'sonner';
import { useDemo } from '../contexts/DemoContext';
import { usePlatform } from '../contexts/PlatformContext';
import { DEMO_NOTE } from '../utils/liveConnection';
import { PageContainer } from '../components/layout/PageContainer';
import { Button } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { EmptyState } from '../components/ui/EmptyState';
import { ConnectionFormModal } from '../components/liveConnection/ConnectionFormModal';
import { LiveConnectionCard } from '../components/liveConnection/LiveConnectionCard';
import type { FormMode } from '../components/liveConnection/ConnectionFormModal';

/** Subscriber's own simulated MEXC Futures connection (one per subscriber). */
export function ExchangeConnections() {
  const { currentUser } = useDemo();
  const { connectionFor, disconnectConnection } = usePlatform();
  const conn = connectionFor(currentUser.id);
  const [mode, setMode] = useState<FormMode | null>(null);
  const [confirming, setConfirming] = useState(false);

  return (
    <PageContainer title="Exchange Connections" description="Add and manage your own MEXC Futures connection." scope={`Connection for ${currentUser.name}`}>
      <p className="flex items-start gap-2 rounded-lg border border-line bg-inset px-3 py-2 text-xs text-muted">
        <InfoIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden />
        <span>
          {DEMO_NOTE} Paper trading stays available without an exchange connection.
        </span>
      </p>

      <div className="max-w-2xl">
        {conn ?
        <LiveConnectionCard conn={conn} onEdit={() => setMode('edit')} onReconnect={() => setMode('reconnect')} onDisconnect={() => setConfirming(true)} /> :

        <EmptyState icon={PlugZapIcon} title="No exchange connection" body="Connect your exchange to configure live trading.">
            <Button variant="primary" icon={PlusIcon} onClick={() => setMode('add')}>
              Add Exchange Connection
            </Button>
          </EmptyState>
        }
      </div>

      <ConnectionFormModal mode={mode} subscriberId={currentUser.id} existing={conn} onClose={() => setMode(null)} />
      <ConfirmDialog
        open={confirming}
        title="Disconnect connection?"
        description="Disconnect this demo connection? New simulated live entries using it will be blocked. Existing positions will remain open."
        confirmLabel="Disconnect"
        tone="danger"
        onConfirm={() => {
          disconnectConnection(currentUser.id);
          setConfirming(false);
          toast('Connection disconnected', { description: 'Metadata kept. Reconnect any time with a new demo test.' });
        }}
        onCancel={() => setConfirming(false)} />
      
    </PageContainer>);

}