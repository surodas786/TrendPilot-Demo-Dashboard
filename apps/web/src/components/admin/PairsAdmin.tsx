'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { BadgeCheckIcon, FlaskConicalIcon, SearchCheckIcon, TriangleAlertIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { InstrumentDto } from '@trendpilot/db';
import { issueMap, request } from '@/lib/api';
import { Button } from '../ui/Button';
import { StatusPill } from '../ui/StatusPill';
import { Switch } from '../ui/Switch';
import { TextField } from '../ui/TextField';

interface Validated {
  symbol: string;
  exchangeSymbol: string;
  displayName: string | null;
  settleCoin: string;
  contract: { multiplier: string; qtyStep: string; minQty: string; maxQty: string; priceTick: string; takerFeeRate: string };
  leverage: { min: number; max: number };
  leverageChoices: number[];
  source: 'MEXC_PUBLIC' | 'FIXTURE';
  fixtureLabel: string | null;
  warnings: string[];
  checkedAt: string;
}

const pct = <span className="pr-2 text-xs text-subtle">%</span>;

interface Suggest {
  suggestedStopPct: string;
  suggestedTakeProfitPct: string;
  suggestedTrailingEnabled: boolean;
  suggestedTrailingPct: string;
}

function SuggestFields({ value, onChange, errors }: { value: Suggest; onChange: (v: Suggest) => void; errors: Record<string, string> }) {
  return (
    <div className="grid gap-3 sm:grid-cols-4 sm:items-start">
      <TextField label="Suggested stop" inputMode="decimal" value={value.suggestedStopPct} onChange={(v) => onChange({ ...value, suggestedStopPct: v })} error={errors.suggestedStopPct} trailing={pct} />
      <TextField label="Suggested take profit" inputMode="decimal" value={value.suggestedTakeProfitPct} onChange={(v) => onChange({ ...value, suggestedTakeProfitPct: v })} error={errors.suggestedTakeProfitPct} trailing={pct} />
      <TextField label="Suggested trailing" inputMode="decimal" value={value.suggestedTrailingPct} onChange={(v) => onChange({ ...value, suggestedTrailingPct: v })} error={errors.suggestedTrailingPct} trailing={pct} />
      <div className="sm:pt-7">
        <Switch label="Trailing on by default" checked={value.suggestedTrailingEnabled} onChange={(v) => onChange({ ...value, suggestedTrailingEnabled: v })} />
      </div>
    </div>
  );
}

const fromInstrument = (i: InstrumentDto): Suggest => ({
  suggestedStopPct: i.suggested.stopPct,
  suggestedTakeProfitPct: i.suggested.takeProfitPct,
  suggestedTrailingEnabled: i.suggested.trailingEnabled,
  suggestedTrailingPct: i.suggested.trailingPct
});

function PairRow({ pair }: { pair: InstrumentDto }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<Suggest>(fromInstrument(pair));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = async (patch: Partial<Suggest> & { status?: 'PUBLISHED' | 'DISABLED' }) => {
    const r = await request<InstrumentDto>('PATCH', `/v1/admin/instruments/${pair.id}`, { body: patch, revision: pair.revision });
    if (!r.ok) {
      setErrors(issueMap(r.issues));
      toast.error(r.message);
      if (r.code === 'REVISION_CONFLICT') router.refresh();
      return;
    }
    toast.success(patch.status ? (patch.status === 'PUBLISHED' ? `${pair.symbol} published` : `${pair.symbol} disabled`) : 'Suggested exits saved');
    setEditing(false);
    router.refresh();
  };

  return (
    <li data-testid={`pair-row-${pair.symbol}`} className="space-y-3 px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-semibold text-ink">
          {pair.base}/{pair.quote}
        </span>
        <span className="text-xs text-subtle">{pair.exchange} · {pair.exchangeSymbol}</span>
        <StatusPill tone={pair.status === 'PUBLISHED' ? 'gain' : 'neutral'}>{pair.status === 'PUBLISHED' ? 'Published' : 'Disabled'}</StatusPill>
        {pair.isFixture && (
          <StatusPill tone="warn" icon={FlaskConicalIcon}>
            Fixture contract
          </StatusPill>
        )}
        <span className="ml-auto flex gap-2">
          <Button size="sm" onClick={() => setEditing((v) => !v)}>
            {editing ? 'Close' : 'Edit defaults'}
          </Button>
          <Button size="sm" variant={pair.status === 'PUBLISHED' ? 'ghost' : 'primary'} onClick={() => save({ status: pair.status === 'PUBLISHED' ? 'DISABLED' : 'PUBLISHED' })}>
            {pair.status === 'PUBLISHED' ? 'Disable' : 'Publish'}
          </Button>
        </span>
      </div>
      <p className="text-xs text-muted">
        Suggested: stop {pair.suggested.stopPct}% · TP {pair.suggested.takeProfitPct}% · trailing {pair.suggested.trailingEnabled ? `${pair.suggested.trailingPct}%` : 'off'} · contract {pair.contract.multiplier} {pair.base}, min {pair.contract.minQty}, tick {pair.contract.priceTick} · leverage up to {Math.max(...pair.leverageChoices)}×
      </p>
      {editing && (
        <div className="space-y-3 rounded-lg border border-line bg-inset p-3">
          <SuggestFields value={value} onChange={setValue} errors={errors} />
          <Button size="sm" variant="primary" onClick={() => save(value)}>
            Save defaults
          </Button>
        </div>
      )}
    </li>
  );
}

/** UI-05 Trading Pairs: type a ticker, validate it on MEXC (fixtures in tests/demo), publish with suggested exits. */
export function PairsAdmin({ pairs }: { pairs: InstrumentDto[] }) {
  const router = useRouter();
  const [symbol, setSymbol] = useState('');
  const [validated, setValidated] = useState<Validated | null>(null);
  const [suggest, setSuggest] = useState<Suggest>({ suggestedStopPct: '2', suggestedTakeProfitPct: '4', suggestedTrailingEnabled: false, suggestedTrailingPct: '1.5' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [checking, setChecking] = useState(false);

  const validate = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    setValidated(null);
    setChecking(true);
    const r = await request<Validated>('POST', '/v1/admin/instruments/validate', { body: { symbol } });
    setChecking(false);
    if (r.ok) setValidated(r.data);
    else setErrors(r.issues.length ? issueMap(r.issues) : { symbol: r.message });
  };

  const publish = async () => {
    if (!validated) return;
    const r = await request<InstrumentDto>('POST', '/v1/admin/instruments', { body: { symbol: validated.symbol, ...suggest } });
    if (!r.ok) {
      setErrors(r.issues.length ? issueMap(r.issues) : { symbol: r.message });
      return;
    }
    toast.success(`${r.data.symbol} published`, { description: 'Market data starts within seconds. Approve it in a strategy version so investors can select it in Trade Settings.' });
    setValidated(null);
    setSymbol('');
    router.refresh();
  };

  return (
    <div className="space-y-5">
      <section className="space-y-3 rounded-xl border border-line bg-surface p-4">
        <h3 className="text-sm font-semibold text-ink">Add a trading pair</h3>
        <form onSubmit={validate} className="flex flex-wrap items-start gap-2" noValidate>
          <TextField label="MEXC Futures ticker" placeholder="e.g. XAUUSDT or XAU_USDT" value={symbol} onChange={(v) => setSymbol(v.toUpperCase())} error={errors.symbol} className="w-60" />
          <Button type="submit" icon={SearchCheckIcon} className="mt-7" disabled={!symbol || checking} loading={checking}>
            Validate
          </Button>
        </form>
        <p className="text-xs text-subtle">
          Validation looks the contract up on MEXC Futures (public contract info) and reads its size, tick, steps and leverage limits from the exchange. Test and local demo builds use the fixture catalogue instead. The
          TradingView alert symbol is set separately on signal routes.
        </p>
        {validated && (
          <div className="space-y-3 rounded-lg border border-accent/30 bg-accent/5 p-3" data-testid="validated-contract">
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold text-ink">{validated.symbol}</span>
              <span className="text-muted" data-testid="validated-exchange-symbol">
                MEXC {validated.exchangeSymbol}
              </span>
              {validated.displayName && <span className="text-xs text-subtle">{validated.displayName}</span>}
              {validated.source === 'MEXC_PUBLIC' ? (
                <StatusPill tone="gain" icon={BadgeCheckIcon}>
                  Verified on MEXC · {validated.settleCoin}-settled perpetual
                </StatusPill>
              ) : (
                <StatusPill tone="warn" icon={FlaskConicalIcon}>
                  {validated.fixtureLabel}
                </StatusPill>
              )}
            </p>
            <p className="text-xs text-muted">
              Contract size {validated.contract.multiplier} {validated.symbol.replace(/USDT$/, '')} · min {validated.contract.minQty} · step {validated.contract.qtyStep} · max {validated.contract.maxQty} · price tick{' '}
              {validated.contract.priceTick} · taker fee {validated.contract.takerFeeRate} · MEXC leverage {validated.leverage.min}–{validated.leverage.max}× (choices {validated.leverageChoices.join(', ')}×)
            </p>
            {validated.warnings.map((w) => (
              <p key={w} className="flex items-center gap-1.5 text-xs text-warn">
                <TriangleAlertIcon className="h-3.5 w-3.5" aria-hidden />
                {w}
              </p>
            ))}
            <SuggestFields value={suggest} onChange={setSuggest} errors={errors} />
            <Button variant="primary" onClick={publish}>
              Publish pair
            </Button>
          </div>
        )}
      </section>

      <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
        {pairs.map((p) => (
          <PairRow key={`${p.id}-${p.revision}`} pair={p} />
        ))}
      </ul>
    </div>
  );
}
