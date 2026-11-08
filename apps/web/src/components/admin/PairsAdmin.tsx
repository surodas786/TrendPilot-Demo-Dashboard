'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FlaskConicalIcon, SearchCheckIcon } from 'lucide-react';
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
  contract: { multiplier: string; qtyStep: string; minQty: string; maxQty: string; priceTick: string; takerFeeRate: string };
  leverageChoices: number[];
  fixtureLabel: string;
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

/** UI-05 Trading Pairs: type a ticker, validate it (local fixtures), publish with suggested exits. */
export function PairsAdmin({ pairs }: { pairs: InstrumentDto[] }) {
  const router = useRouter();
  const [symbol, setSymbol] = useState('');
  const [validated, setValidated] = useState<Validated | null>(null);
  const [suggest, setSuggest] = useState<Suggest>({ suggestedStopPct: '2', suggestedTakeProfitPct: '4', suggestedTrailingEnabled: false, suggestedTrailingPct: '1.5' });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    setValidated(null);
    const r = await request<Validated>('POST', '/v1/admin/instruments/validate', { body: { symbol } });
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
    toast.success(`${r.data.symbol} published`, { description: 'Approve it in a strategy version so investors can trade it.' });
    setValidated(null);
    setSymbol('');
    router.refresh();
  };

  return (
    <div className="space-y-5">
      <section className="space-y-3 rounded-xl border border-line bg-surface p-4">
        <h3 className="text-sm font-semibold text-ink">Add a trading pair</h3>
        <form onSubmit={validate} className="flex flex-wrap items-start gap-2" noValidate>
          <TextField label="MEXC Futures ticker" placeholder="e.g. ETHUSDT" value={symbol} onChange={(v) => setSymbol(v.toUpperCase())} error={errors.symbol} className="w-60" />
          <Button type="submit" icon={SearchCheckIcon} className="mt-7" disabled={!symbol}>
            Validate
          </Button>
        </form>
        <p className="text-xs text-subtle">Validation uses the local MEXC contract fixtures in this build, not the live exchange.</p>
        {validated && (
          <div className="space-y-3 rounded-lg border border-accent/30 bg-accent/5 p-3" data-testid="validated-contract">
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold text-ink">{validated.symbol}</span>
              <span className="text-muted">{validated.exchangeSymbol}</span>
              <StatusPill tone="warn" icon={FlaskConicalIcon}>
                {validated.fixtureLabel}
              </StatusPill>
            </p>
            <p className="text-xs text-muted">
              Contract size {validated.contract.multiplier} · min {validated.contract.minQty} · step {validated.contract.qtyStep} · price tick {validated.contract.priceTick} · taker fee {validated.contract.takerFeeRate} · leverage {validated.leverageChoices.join(', ')}×
            </p>
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
