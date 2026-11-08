import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2Icon, SendIcon, XCircleIcon } from 'lucide-react';
import { toast } from 'sonner';
import { useDemo } from '../../contexts/DemoContext';
import { usePlatform } from '../../contexts/PlatformContext';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { CopyButton } from '../ui/CopyButton';
import { FilterSelect } from '../ui/FilterSelect';
import { ACTION_LABELS, ALL_ACTIONS, isEntryAction, routeTriggerName, routeUsage, USAGE_LABELS } from '../../data/signalRoutes';
import { buildPayload, commonWebhookUrl, defaultSignalInput, isoDhaka, tradingViewAlertMessage } from '../../utils/signalPayload';
import { validateSignal } from '../../utils/signalValidation';
import { normalizeInterval } from '../../utils/platformText';
import type { ValidationResult } from '../../utils/signalValidation';
import { simNow } from '../../utils/clock';
import { ownerOf } from '../../data/demoUsers';
import type { SignalAction, SignalInput, SignalRoute } from '../../types/signals';

/** Paper signal composer: validate only, or dispatch through the shared signal engine. */
export function SignalComposer() {
  const { state, submitSignal, setComposerDraft, executeTokenSignal } = useDemo();
  const { platform } = usePlatform();
  const fresh = (route: SignalRoute, pair: string, action: SignalAction) => defaultSignalInput(route, pair, action, state.paperPrices[pair] ?? 0, simNow());
  const [input, setInput] = useState<SignalInput>(() => {
    const r = state.routes[0];
    return state.composerDraft ?? fresh(r, Object.values(r.symbolMap)[0], 'open-long');
  });
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [emaClose, setEmaClose] = useState('');
  const [emaValue, setEmaValue] = useState('');
  const route = state.routes.find((r) => r.id === input.routeId) ?? state.routes[0];
  const pairs = Object.values(route.symbolMap);
  const usage = routeUsage(route);

  // A scenario loaded from Demo Center pre-fills the composer.
  useEffect(() => {
    if (state.composerDraft) {
      setInput(state.composerDraft);
      setResult(null);
    }
  }, [state.composerDraft]);

  const regenerate = (r: SignalRoute, pair: string, action: SignalAction) => {
    setInput(fresh(r, pairs.includes(pair) || r === route ? pair : Object.values(r.symbolMap)[0], action));
    setResult(null);
  };
  const changeRoute = (id: string) => {
    const r = state.routes.find((x) => x.id === id);
    if (!r) return;
    const rp = Object.values(r.symbolMap);
    setInput(fresh(r, rp.includes(input.pair) ? input.pair : rp[0], input.action));
    setResult(null);
  };

  const payload = useMemo(() => JSON.stringify(buildPayload(input, route), null, 2), [input, route]);

  const affectedSubs = useMemo(
    () =>
    state.subscriptions.
    filter((s) => s.strategyId === route.strategyId && s.status !== 'archived').
    map((s) => {
      const acct = state.accounts.find((a) => a.id === s.accountId);
      const user = state.users.find((u) => u.id === ownerOf(acct));
      return `${user?.name ?? 'Demo user'} · ${acct?.name ?? s.accountId}`;
    }),
    [state.subscriptions, state.accounts, state.users, route.strategyId]
  );
  const affectedBlocks = platform.tokenBlocks.filter((b) => b.symbol === input.pair).length;

  const validateNow = () => validateSignal(input, { routes: state.routes, signals: state.centralSignals, watermarks: state.watermarks, now: simNow() });
  const validate = () => setResult(validateNow());

  const dispatch = () => {
    const v = validateNow();
    submitSignal(input);
    // Trade-trigger opening signals also go to strategy packages through the shared token-block processor,
    // which checks each package's saved timeframe before its LONG/SHORT rules.
    if (v.outcome === 'accepted' && usage === 'trade' && isEntryAction(input.action)) {
      const tf = normalizeInterval(input.timeframe);
      executeTokenSignal({
        receiptId: `central:${input.signalId}`,
        signalId: input.signalId,
        symbol: input.pair,
        side: input.action === 'open-long' ? 'long' : 'short',
        timeframe: tf.timeframe,
        rawInterval: tf.raw,
        blocks: platform.tokenBlocks,
        packages: platform.packages,
        pairs: platform.pairs,
        connections: platform.connections,
        candleClose: emaClose.trim() ? Number(emaClose) : null,
        ema200: emaValue.trim() ? Number(emaValue) : null
      });
    }
    setComposerDraft(null);
    setConfirming(false);
    toast.success(usage === 'info' ? 'Information-only signal logged' : 'Signal dispatched', { description: 'See the outcome in the Central Signal Feed.' });
    regenerate(route, input.pair, input.action);
  };

  const confirmText =
  usage === 'info' ?
  'This route is Information only. The signal is logged in the Central Signal Feed and no trades are opened, closed or reversed.' :
  `This updates shared paper-account positions and balances. Subscriptions evaluated: ${affectedSubs.join('; ') || 'none'}. Token blocks on ${input.pair}: ${affectedBlocks}${isEntryAction(input.action) ? '' : ' (close actions are not sent to strategy packages)'}. Setup problems are not fixed automatically.`;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <section className="space-y-4 rounded-xl border border-line bg-surface p-4">
        <div>
          <h3 className="text-sm font-semibold text-ink">Simulate signal</h3>
          <p className="mt-0.5 text-xs text-muted">Simulation route — no public endpoint.</p>
        </div>
        <div className="w-full max-w-sm">
          <FilterSelect label="Signal route" value={route.id} onChange={changeRoute} options={state.routes.map((r) => ({ value: r.id, label: `${r.label} · ${r.timeframe}` }))} />
        </div>
        <dl className="grid grid-cols-1 gap-2 rounded-lg border border-line bg-inset p-3 text-xs sm:grid-cols-3">
          <div><dt className="text-subtle">Alert trigger</dt><dd className="text-ink">{routeTriggerName(route)}</dd></div>
          <div><dt className="text-subtle">Timeframe</dt><dd className="text-ink">{route.timeframe}</dd></div>
          <div><dt className="text-subtle">Use</dt><dd className="text-ink">{USAGE_LABELS[usage]}{!route.enabled && <span className="text-loss"> · route disabled</span>}</dd></div>
        </dl>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <FilterSelect label="Pair" value={input.pair} onChange={(p) => regenerate(route, p, input.action)} options={pairs.map((p) => ({ value: p, label: p }))} />
          <FilterSelect label="Action" value={input.action} onChange={(a) => regenerate(route, input.pair, a as SignalAction)} options={ALL_ACTIONS.map((a) => ({ value: a, label: ACTION_LABELS[a] }))} />
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-subtle">Reference price</span>
            <input inputMode="decimal" value={input.referencePrice} onChange={(e) => setInput({ ...input, referencePrice: Number(e.target.value) })} className="h-9 rounded-lg border border-line bg-inset px-3 text-sm tabular-nums text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-subtle">Signal ID</span>
            <input value={input.signalId} onChange={(e) => setInput({ ...input, signalId: e.target.value })} className="h-9 rounded-lg border border-line bg-inset px-3 font-mono text-xs text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60" />
          </label>
        </div>
        <FilterSelect
          label="Incoming interval (for testing a mismatch)"
          value={input.timeframe ?? ''}
          onChange={(v) => {
            setInput({ ...input, timeframe: v || undefined });
            setResult(null);
          }}
          options={[
          { value: route.timeframe, label: `${route.timeframe} — matches this route` },
          ...['5m', '15m'].filter((t) => t !== route.timeframe).map((t) => ({ value: t, label: `${t} — mismatch` })),
          { value: '', label: 'Missing interval' }]
          } />
        
        <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
          <div><dt className="text-subtle">Candle close</dt><dd className="tabular-nums text-ink">{isoDhaka(input.candleCloseAt)}</dd></div>
          <div><dt className="text-subtle">Signal created</dt><dd className="tabular-nums text-ink">{isoDhaka(input.createdAt)}</dd></div>
          <div><dt className="text-subtle">Simulated receipt</dt><dd className="tabular-nums text-ink">{isoDhaka(input.receivedAt)}</dd></div>
        </dl>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-subtle">Simulated candle close (optional)</span>
            <input inputMode="decimal" value={emaClose} onChange={(e) => setEmaClose(e.target.value)} className="h-9 rounded-lg border border-line bg-inset px-3 text-sm tabular-nums text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-subtle">Simulated EMA 200 (optional)</span>
            <input inputMode="decimal" value={emaValue} onChange={(e) => setEmaValue(e.target.value)} className="h-9 rounded-lg border border-line bg-inset px-3 text-sm tabular-nums text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60" />
          </label>
        </div>
        <p className="-mt-2 text-xs text-subtle">Used only by packages with the EMA 200 trend filter; blank values block those entries. Production source: MEXC Futures candle history.</p>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={input.confirmed} onChange={(e) => setInput({ ...input, confirmed: e.target.checked })} className="h-4 w-4" />
          Completed-candle confirmation
        </label>
        <div className="flex flex-wrap gap-2">
          <Button onClick={validate}>Validate only</Button>
          <Button variant="primary" icon={SendIcon} onClick={() => setConfirming(true)}>
            {usage === 'info' ? 'Send information signal' : 'Dispatch to paper accounts'}
          </Button>
        </div>
        {result &&
        <div className="rounded-lg border border-line bg-inset p-3 text-sm">
            <p className="font-medium text-ink">
              {result.outcome === 'accepted' ? 'Would be accepted' : `Would be ${result.outcome}`} — {result.reason}
            </p>
            <ul className="mt-2 grid gap-1 sm:grid-cols-2">
              {result.checks.map((c) =>
            <li key={c.id} className="flex items-center gap-1.5 text-xs text-muted">
                  {c.status === 'fail' ? <XCircleIcon className="h-3.5 w-3.5 text-loss" aria-hidden /> : <CheckCircle2Icon className="h-3.5 w-3.5 text-gain" aria-hidden />}
                  <span className="sr-only">{c.status}</span>
                  {c.label}
                </li>
            )}
            </ul>
            <p className="mt-2 text-xs text-subtle">Validate only creates no orders and changes no balances.</p>
          </div>
        }
      </section>

      <section className="space-y-4 self-start rounded-xl border border-line bg-surface p-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-ink">Sample payload</h3>
            <CopyButton text={payload} label="Copy JSON" />
          </div>
          <pre className="scrollbar-thin max-h-72 overflow-auto rounded-lg border border-line bg-inset p-3 font-mono text-xs text-ink">{payload}</pre>
          <p className="text-xs text-subtle">The populated simulation message for this route. No keys or secrets.</p>
        </div>
        <div className="space-y-2 border-t border-line pt-4">
          <h3 className="text-sm font-semibold text-ink">Copy TradingView Alert Message</h3>
          <p className="text-xs text-muted">
            Paste-ready messages for “{route.label}”. The route ID is filled in; TradingView placeholders such as {'{{interval}}'} stay as written. Both alerts use the same webhook URL:
          </p>
          <p className="break-all rounded-md border border-line bg-inset px-2 py-1.5 font-mono text-[11px] text-ink">{commonWebhookUrl()}</p>
          <div className="flex flex-wrap gap-2">
            <CopyButton text={tradingViewAlertMessage(route, 'LONG')} label="Copy LONG Alert Message" />
            <CopyButton text={tradingViewAlertMessage(route, 'SHORT')} label="Copy SHORT Alert Message" />
          </div>
          <pre className="scrollbar-thin overflow-x-auto rounded-lg border border-line bg-inset p-3 font-mono text-[11px] text-muted">{tradingViewAlertMessage(route, 'LONG')}</pre>
          <p className="text-xs text-subtle">Demo endpoint — does not receive external requests.</p>
        </div>
      </section>

      <ConfirmDialog
        open={confirming}
        title={usage === 'info' ? 'Send this information-only signal?' : 'Dispatch this signal?'}
        description={confirmText}
        confirmLabel={usage === 'info' ? 'Send' : 'Dispatch'}
        onConfirm={dispatch}
        onCancel={() => setConfirming(false)} />
      
    </div>);

}