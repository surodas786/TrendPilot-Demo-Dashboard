import React, { useState } from 'react';
import { FileJsonIcon, SendIcon } from 'lucide-react';
import { CopyButton } from '../ui/CopyButton';
import { Button } from '../ui/Button';
import { AlertPreviewModal } from './AlertPreviewModal';
import { SimulateSignalModal } from './SimulateSignalModal';
import { RecentSignalsTable } from './RecentSignalsTable';
import { FilterSelect } from '../ui/FilterSelect';
import { useDemo } from '../../contexts/DemoContext';
import { routeTriggerName, routeUsage, USAGE_LABELS } from '../../data/signalRoutes';
import { commonWebhookUrl, tradingViewAlertMessage } from '../../utils/signalPayload';

export function CommonSignalsTab() {
  const [preview, setPreview] = useState(false);
  const [simulate, setSimulate] = useState(false);
  const address = commonWebhookUrl();
  const { state } = useDemo();
  const [routeId, setRouteId] = useState(state.routes[0]?.id ?? '');
  const route = state.routes.find((r) => r.id === routeId) ?? state.routes[0];

  return (
    <div className="space-y-6">
      <section aria-labelledby="webhook-title" className="rounded-xl border border-line bg-surface p-4 lg:p-5">
        <h3 id="webhook-title" className="text-sm font-semibold text-ink">
          Common webhook
        </h3>
        <p className="mt-1 text-sm text-muted">Use one common webhook for TradingView or another signal provider. Subscriber settings determine which signals can trigger trades.</p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <label htmlFor="webhook-address" className="text-xs font-medium text-subtle">
              Demo endpoint — does not receive external requests
            </label>
            <input id="webhook-address" readOnly value={address} onFocus={(e) => e.currentTarget.select()} className="h-9 w-full rounded-lg border border-line bg-inset px-3 font-mono text-xs text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60" />
          </div>
          <CopyButton text={address} size="md" />
        </div>
        <div className="mt-4 space-y-2 border-t border-line pt-4">
          <div className="w-full max-w-sm">
            <FilterSelect label="Signal route" value={route?.id ?? ''} onChange={setRouteId} options={state.routes.map((r) => ({ value: r.id, label: `${r.label} · ${r.timeframe}` }))} />
          </div>
          {route &&
          <>
              <p className="text-xs text-muted">
                {routeTriggerName(route)} · {route.timeframe} · {USAGE_LABELS[routeUsage(route)]}. Paste-ready raw JSON with route_id <span className="font-mono text-ink">{route.id}</span>; TradingView placeholders stay as written. Both directions use the webhook above.
              </p>
              <div className="flex flex-wrap gap-2">
                <CopyButton text={tradingViewAlertMessage(route, 'LONG')} label="Copy LONG Alert Message" />
                <CopyButton text={tradingViewAlertMessage(route, 'SHORT')} label="Copy SHORT Alert Message" />
              </div>
            </>
          }
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button icon={FileJsonIcon} onClick={() => setPreview(true)}>
            Sample payload
          </Button>
          <Button variant="primary" icon={SendIcon} onClick={() => setSimulate(true)}>
            Simulate Signal
          </Button>
        </div>
      </section>

      <section aria-labelledby="recent-title" className="space-y-3">
        <div>
          <h3 id="recent-title" className="text-sm font-semibold text-ink">
            Recent signals
          </h3>
          <p className="text-xs text-subtle">Accepted means the message passed validation — it does not mean any subscriber trade was placed.</p>
        </div>
        <RecentSignalsTable />
      </section>

      <AlertPreviewModal open={preview} onClose={() => setPreview(false)} />
      <SimulateSignalModal open={simulate} onClose={() => setSimulate(false)} />
    </div>);

}