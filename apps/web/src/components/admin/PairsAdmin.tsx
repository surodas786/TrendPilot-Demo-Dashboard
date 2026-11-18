'use client';


import { exchangeLabel } from '@trendpilot/domain';
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
      <TextField label="Suggested trail distance" inputMode="decimal" value={value.suggestedTrailingPct} onChange={(v) => onChange({ ...value, suggestedTrailingPct: v })} error={errors.suggestedTrailingPct} trailing={pct} />
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
    const name = `${exchangeLabel(pair.exchange)} ${pair.symbol}`;
    toast.success(patch.status ? (patch.status === 'PUBLISHED' ? `${name} published` : `${name} disabled`) : 'Suggested exits saved', patch.status === 'PUBLISHED' ? { description: 'Investors can select it in Trade Settings once a published strategy version includes it (Strategies).' } : undefined);
    setEditing(false);
    router.refresh();
  };

  return (
    <li data-testid={pair.exchange === 'MEXC' ? `pair-row-${pair.symbol}` : `pair-row-${pair.exchange}-${pair.symbol}`} className="space-y-3 px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-semibold text-ink">
          {pair.base}/{pair.quote}
        </span>
        <span className="text-xs text-subtle" data-testid="pair-exchange">
          {exchangeLabel(pair.exchange)} · {pair.exchangeSymbol}
          {pair.marketId !== null ? ` · market ${pair.marketId}` : ''}
        </span>
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

/** "0.001000000000" → "0.001" (numeric columns come back at full scale). */
const trimZeros = (v: string) => (v.includes('.') ? v.replace(/\.?0+$/, '') : v);

interface BitunixImport {
  instrument: { id: string; symbol: string; exchangeSymbol: string; qtyStep: string; minQty: string; maxQty: string; priceTick: string; leverageChoices: number[]; status: string; isFixture: boolean };
  warnings: string[];
  source: 'BITUNIX_PUBLIC' | 'FIXTURE';
}

/**
 * Bitunix contracts: read from Bitunix's public trading_pairs (fixtures in tests/demo) and added as a
 * separate DISABLED instrument; refreshing an existing one updates only its trading rules. Publish it
 * in the list below like any pair.
 */
function BitunixImportSection() {
  const router = useRouter();
  const [symbol, setSymbol] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BitunixImport | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    setBusy(true);
    const r = await request<BitunixImport>('POST', '/v1/admin/instruments/bitunix', { body: { symbol } });
    setBusy(false);
    if (!r.ok) return setError(r.issues[0]?.message ?? r.message);
    setResult(r.data);
    toast.success(`Bitunix ${r.data.instrument.exchangeSymbol} imported`, { description: r.data.instrument.status === 'PUBLISHED' ? 'Trading rules refreshed.' : 'It starts Disabled: review it below and press Publish.' });
    router.refresh();
  };
  return (
    <section className="space-y-3 rounded-xl border border-line bg-surface p-4" data-testid="bitunix-import">
      <h3 className="text-sm font-semibold text-ink">Add a Bitunix Futures pair</h3>
      <form onSubmit={submit} className="flex flex-wrap items-start gap-2" noValidate>
        <TextField label="Bitunix Futures symbol" placeholder="e.g. BTCUSDT or XAUUSDT" value={symbol} onChange={(v) => setSymbol(v.toUpperCase())} error={error ?? undefined} className="w-60" />
        <Button type="submit" icon={SearchCheckIcon} className="mt-7" disabled={!symbol || busy} loading={busy}>
          Import from Bitunix
        </Button>
      </form>
      <p className="text-xs text-subtle">
        Reads the contract from Bitunix (public trading_pairs): it must be USDT-margined, OPEN, API-enabled and launched. Quantity step, minimum and maximum market quantity, price tick and leverage come from the exchange. The pair is
        separate from the MEXC pair with the same coin (own prices, orders and positions), is Live only, and starts Disabled. Test and local demo builds use captured fixture contracts.
      </p>
      {result && (
        <div className="space-y-1 rounded-lg border border-accent/30 bg-accent/5 p-3 text-xs text-muted" data-testid="bitunix-imported">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold text-ink">Bitunix {result.instrument.exchangeSymbol}</span>
            {result.source === 'BITUNIX_PUBLIC' ? (
              <StatusPill tone="gain" icon={BadgeCheckIcon}>
                Read from Bitunix
              </StatusPill>
            ) : (
              <StatusPill tone="warn" icon={FlaskConicalIcon}>
                Fixture contract (not verified on Bitunix)
              </StatusPill>
            )}
            <StatusPill tone={result.instrument.status === 'PUBLISHED' ? 'gain' : 'neutral'}>{result.instrument.status === 'PUBLISHED' ? 'Published' : 'Disabled'}</StatusPill>
          </p>
          <p>
            Step {trimZeros(result.instrument.qtyStep)} · min {trimZeros(result.instrument.minQty)} · max (market) {trimZeros(result.instrument.maxQty)} · tick {trimZeros(result.instrument.priceTick)} · leverage up to {Math.max(...result.instrument.leverageChoices)}×
          </p>
          {result.warnings.map((w) => (
            <p key={w} className="flex items-center gap-1.5 text-warn">
              <TriangleAlertIcon className="h-3.5 w-3.5" aria-hidden />
              {w}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

interface LighterImport {
  instrument: { id: string; symbol: string; exchangeSymbol: string; marketId: number; base: string; quote: string; qtyStep: string; minQty: string; minNotional: string | null; priceTick: string; leverageChoices: number[]; status: string; isFixture: boolean };
  market: { marketId: number; symbol: string; marketType: string; status: string; settlementCurrency: string; environment: string; maxLeverage: number };
  source: 'LIGHTER_PUBLIC' | 'FIXTURE';
}

/**
 * Lighter USDC perpetuals (registration only): validated against the official public catalog of the
 * Ethereum-based Lighter mainnet by exact native symbol or market ID, and added as a separate
 * DISABLED instrument. Prices come from Lighter; Live orders follow the Live eligibility checks.
 */
function LighterImportSection() {
  const router = useRouter();
  const [market, setMarket] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LighterImport | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    setBusy(true);
    const r = await request<LighterImport>('POST', '/v1/admin/instruments/lighter', { body: { market: market.trim() } });
    setBusy(false);
    if (!r.ok) return setError(r.issues[0]?.message ?? r.message);
    setResult(r.data);
    toast.success(`Lighter ${r.data.instrument.exchangeSymbol} (market ${r.data.instrument.marketId}) registered`, { description: r.data.instrument.status === 'PUBLISHED' ? 'Market rules refreshed.' : 'It starts Disabled: review it below and press Publish.' });
    router.refresh();
  };
  return (
    <section className="space-y-3 rounded-xl border border-line bg-surface p-4" data-testid="lighter-import">
      <h3 className="text-sm font-semibold text-ink">Add a Lighter USDC perpetual</h3>
      <form onSubmit={submit} className="flex flex-wrap items-start gap-2" noValidate>
        <TextField label="Lighter market (native symbol or market ID)" placeholder="e.g. XAU or 92" value={market} onChange={setMarket} error={error ?? undefined} className="w-72" />
        <Button type="submit" icon={SearchCheckIcon} className="mt-7" disabled={!market.trim() || busy} loading={busy}>
          Look up on Lighter
        </Button>
      </form>
      <p className="text-xs text-subtle">
        Looks the market up in Lighter&apos;s official public catalog for the Ethereum mainnet. Only active, Lighter-deployed perpetuals settled in USDC are accepted; spot pairs, inactive or frozen markets, dated or binary markets and other
        environments are refused. Enter the symbol exactly as Lighter lists it (XAU, not XAUUSDT) or its market ID. Published Lighter pairs get Lighter prices and Paper trading; Live needs the Lighter account approved and the contract on the Live allowlist.
      </p>
      {result && (
        <div className="space-y-1 rounded-lg border border-accent/30 bg-accent/5 p-3 text-xs text-muted" data-testid="lighter-imported">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold text-ink">
              {result.instrument.base}/{result.instrument.quote} · Lighter {result.instrument.exchangeSymbol}
            </span>
            <span className="font-mono text-xs" data-testid="lighter-market-id">
              market {result.instrument.marketId}
            </span>
            {result.source === 'LIGHTER_PUBLIC' ? (
              <StatusPill tone="gain" icon={BadgeCheckIcon}>
                Verified on Lighter ({result.market.environment.toLowerCase()}) · {result.market.marketType} · {result.market.status} · {result.market.settlementCurrency}
              </StatusPill>
            ) : (
              <StatusPill tone="warn" icon={FlaskConicalIcon}>
                Fixture market (captured catalog, not read live)
              </StatusPill>
            )}
            <StatusPill tone={result.instrument.status === 'PUBLISHED' ? 'gain' : 'neutral'}>{result.instrument.status === 'PUBLISHED' ? 'Published' : 'Disabled'}</StatusPill>
          </p>
          <p>
            Size step {trimZeros(result.instrument.qtyStep)} {result.instrument.base} · min {trimZeros(result.instrument.minQty)} {result.instrument.base}
            {result.instrument.minNotional ? ` · min order ${trimZeros(result.instrument.minNotional)} ${result.instrument.quote}` : ''} · price tick {trimZeros(result.instrument.priceTick)} · leverage up to {result.market.maxLeverage}×
          </p>
        </div>
      )}
    </section>
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
        <h3 className="text-sm font-semibold text-ink">Add a MEXC Futures pair</h3>
        <form onSubmit={validate} className="flex flex-wrap items-start gap-2" noValidate>
          <TextField label="MEXC Futures ticker" placeholder="e.g. XAUUSDT or XAU_USDC" value={symbol} onChange={(v) => setSymbol(v.toUpperCase())} error={errors.symbol} className="w-60" />
          <Button type="submit" icon={SearchCheckIcon} className="mt-7" disabled={!symbol || checking} loading={checking}>
            Validate
          </Button>
        </form>
        <p className="text-xs text-subtle">
          Validation looks the contract up on MEXC Futures (public contract info) and reads its settlement currency (USDT or USDC), size, tick, steps and leverage limits from the exchange. Test and local demo builds use the fixture catalogue instead. The
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
              Contract size {validated.contract.multiplier} {validated.symbol.replace(/(USDT|USDC)$/, '')} · min {validated.contract.minQty} · step {validated.contract.qtyStep} · max {validated.contract.maxQty} · price tick{' '}
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

      <BitunixImportSection />

      <LighterImportSection />

      <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
        {pairs.map((p) => (
          <PairRow key={`${p.id}-${p.revision}`} pair={p} />
        ))}
      </ul>
    </div>
  );
}
