import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDownIcon, PlayIcon, RotateCcwIcon, StepForwardIcon } from 'lucide-react';
import { toast } from 'sonner';
import { useDemo } from '../contexts/DemoContext';
import { useDemoGuide } from '../contexts/DemoGuideContext';
import { PageContainer } from '../components/layout/PageContainer';
import { Button } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { SCENARIO_COMMON_SCOPE, signalScenarios } from '../data/signalScenarios';
import type { SignalScenarioMeta } from '../data/signalScenarios';
import { PRESENTATION_ASSUMPTIONS, PRESENTATION_NAME, PRESENTATION_PRICES, PRESENTATION_SCOPE } from '../data/presentation';
import { presentationHasExposure } from '../contexts/signals/presentation';
import { scenarioInputs } from '../utils/signalScenarios';
import { formatNumber } from '../utils/format';
import { simNow } from '../utils/clock';

const LIMITS = [
'Prices, signals, execution and funding are simulated.',
'No real money or credentials are required.',
'User and role previews do not provide production security.',
'Processing runs only while the demo is open.',
'Exchange liquidation information is unavailable.'];


/** Demonstration scenarios and reset. Each scenario states its scope and asks for confirmation. */
export function DemoCenter() {
  const { state, loadSignalScenario, loadPresentation, advancePresentation, setRole } = useDemo();
  const { requestReset } = useDemoGuide();
  const navigate = useNavigate();
  const [pending, setPending] = useState<SignalScenarioMeta | null>(null);
  const [presOpen, setPresOpen] = useState(false);
  const step = state.presentation?.step ?? null;
  const canAdvance = step !== null && step < PRESENTATION_PRICES.length - 1 && presentationHasExposure(state);

  const openComposer = () => {
    setRole('admin');
    // Role change returns to the Dashboard; navigate after it settles.
    window.setTimeout(() => navigate('/admin?section=compose'), 0);
  };

  const loadScenario = (s: SignalScenarioMeta) => {
    const { pre, prefill } = scenarioInputs(s.id, state.routes[0], state.paperPrices, simNow());
    loadSignalScenario(s.id, prefill, pre);
    setPending(null);
    toast.success('Scenario loaded', { description: 'The signal composer is pre-filled. Dispatch it to see the outcome.' });
    openComposer();
  };

  return (
    <PageContainer title="Demo Center" description="Explore shared trading signals, independent account settings, paper execution, protective exits and reporting.">
      <section className="rounded-xl border border-line bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-ink">{PRESENTATION_NAME}</h3>
            <p className="mt-0.5 text-xs text-muted">{step === null ? 'Not loaded.' : `Loaded · price update ${step + 1} of ${PRESENTATION_PRICES.length} (${formatNumber(PRESENTATION_PRICES[step], 0)} USDT)`}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button icon={PlayIcon} onClick={() => setPresOpen(true)}>
              {step === null ? 'Load scenario' : 'Restart scenario'}
            </Button>
            <Button onClick={openComposer} disabled={step === null}>
              Open signal composer
            </Button>
            <Button variant="primary" icon={StepForwardIcon} disabled={!canAdvance} onClick={() => step !== null && advancePresentation(step)}>
              Next price update
            </Button>
          </div>
        </div>
        <ol className="mt-3 flex flex-wrap gap-1.5 text-xs tabular-nums">
          {PRESENTATION_PRICES.map((p, i) =>
          <li key={i} className={`rounded-md border px-2 py-1 ${step !== null && i <= step ? 'border-accent/40 bg-accent/10 text-accent' : 'border-line text-subtle'}`}>
              {formatNumber(p, 0)}
            </li>
          )}
        </ol>
        <ul className="mt-3 list-disc space-y-0.5 pl-5 text-xs text-subtle">
          {PRESENTATION_ASSUMPTIONS.map((a) =>
          <li key={a}>{a}</li>
          )}
        </ul>
        <p className="mt-2 text-xs text-subtle">Next price update stays disabled until the signal has been dispatched and a position is open.</p>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-ink">Signal scenarios</h3>
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {signalScenarios.map((s) =>
          <li key={s.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{s.label}</p>
                <p className="text-xs text-muted">Expected: {s.expected}</p>
              </div>
              <Button size="sm" onClick={() => setPending(s)}>
                Load
              </Button>
            </li>
          )}
        </ul>
      </section>

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4">
        <div>
          <h3 className="text-sm font-semibold text-ink">Reset demo</h3>
          <p className="mt-0.5 text-xs text-muted">Restores the original demo users, settings and records after confirmation.</p>
        </div>
        <Button variant="danger" icon={RotateCcwIcon} onClick={requestReset}>
          Reset demo
        </Button>
      </section>

      <details className="group rounded-xl border border-line bg-surface p-4">
        <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold text-ink">
          About this demo
          <ChevronDownIcon className="h-4 w-4 text-subtle transition-transform duration-150 group-open:rotate-180" aria-hidden />
        </summary>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted">
          {LIMITS.map((l) =>
          <li key={l}>{l}</li>
          )}
        </ul>
      </details>

      <ConfirmDialog
        open={pending !== null}
        title={pending ? `Load “${pending.label}”?` : ''}
        description={pending ? [...SCENARIO_COMMON_SCOPE, ...pending.setup].join('. ') + '. Then opens the signal composer in Administrator preview.' : ''}
        confirmLabel="Load scenario"
        tone="danger"
        onConfirm={() => pending && loadScenario(pending)}
        onCancel={() => setPending(null)} />
      
      <ConfirmDialog
        open={presOpen}
        title={`Load “${PRESENTATION_NAME}”?`}
        description={`${PRESENTATION_SCOPE.join('. ')}. No signal is dispatched automatically.`}
        confirmLabel="Load scenario"
        tone="danger"
        onConfirm={() => {
          loadPresentation();
          setPresOpen(false);
          toast.success('Presentation scenario loaded');
        }}
        onCancel={() => setPresOpen(false)} />
      
    </PageContainer>);

}