'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LockIcon, PlusIcon, SendIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { InstrumentDto, PackageDto, StrategyVersionDto } from '@trendpilot/db';
import {
  DIRECTIONS,
  EMA_FILTERS,
  EMA_LABELS,
  OPPOSITE_LABELS,
  OPPOSITE_POLICIES,
  PAPER_TEMPLATE,
  TIMEFRAMES,
  type Direction,
  type EmaFilter,
  type OppositePolicy,
  type Timeframe
} from '@trendpilot/domain';
import { issueMap, request } from '@/lib/api';
import { Button } from '../ui/Button';
import { ChipCheckboxGroup } from '../ui/ChipCheckboxGroup';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { SegmentedControl } from '../ui/SegmentedControl';
import { StatusPill } from '../ui/StatusPill';
import { TextField } from '../ui/TextField';

const DIRECTION_LABELS: Record<Direction, string> = { LONG_ONLY: 'Long only', SHORT_ONLY: 'Short only', BOTH: 'Long and Short' };

interface Form {
  timeframe: Timeframe;
  atrLength: string;
  atrFactor: string;
  permittedDirections: Direction;
  emaFilter: EmaFilter;
  oppositePolicy: OppositePolicy;
  signalMaxAgeSeconds: string;
  maxPriceDeviationPct: string;
  instrumentIds: string[];
}

const formFrom = (v?: StrategyVersionDto, fallbackPairs: string[] = []): Form => ({
  timeframe: v?.timeframe ?? PAPER_TEMPLATE.timeframe,
  atrLength: String(v?.atrLength ?? PAPER_TEMPLATE.atrLength),
  atrFactor: v?.atrFactor ?? PAPER_TEMPLATE.atrFactor,
  permittedDirections: v?.permittedDirections ?? PAPER_TEMPLATE.permittedDirections,
  emaFilter: v?.emaFilter ?? PAPER_TEMPLATE.emaFilter,
  oppositePolicy: v?.oppositePolicy ?? PAPER_TEMPLATE.oppositePolicy,
  signalMaxAgeSeconds: String(v?.signalMaxAgeSeconds ?? PAPER_TEMPLATE.signalMaxAgeSeconds),
  maxPriceDeviationPct: v?.maxPriceDeviationPct ?? PAPER_TEMPLATE.maxPriceDeviationPct,
  instrumentIds: v?.instrumentIds ?? fallbackPairs
});

const body = (f: Form) => ({
  timeframe: f.timeframe,
  atrLength: Number(f.atrLength),
  atrFactor: f.atrFactor.trim(),
  permittedDirections: f.permittedDirections,
  emaFilter: f.emaFilter,
  oppositePolicy: f.oppositePolicy,
  signalMaxAgeSeconds: Number(f.signalMaxAgeSeconds),
  maxPriceDeviationPct: f.maxPriceDeviationPct.trim(),
  instrumentIds: f.instrumentIds
});

function VersionForm({ form, onChange, errors, pairs }: { form: Form; onChange: (f: Form) => void; errors: Record<string, string>; pairs: InstrumentDto[] }) {
  const set = (patch: Partial<Form>) => onChange({ ...form, ...patch });
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <SegmentedControl<Timeframe> label="Timeframe" value={form.timeframe} onChange={(v) => set({ timeframe: v })} options={TIMEFRAMES.map((t) => ({ value: t, label: t }))} />
        <SegmentedControl<EmaFilter> label="Trend filter" value={form.emaFilter} onChange={(v) => set({ emaFilter: v })} options={EMA_FILTERS.map((e) => ({ value: e, label: EMA_LABELS[e] }))} />
      </div>
      <div className="grid gap-3 sm:grid-cols-4 sm:items-start">
        <TextField label="Supertrend ATR length" inputMode="numeric" value={form.atrLength} onChange={(v) => set({ atrLength: v })} error={errors.atrLength} />
        <TextField label="Supertrend factor" inputMode="decimal" value={form.atrFactor} onChange={(v) => set({ atrFactor: v })} error={errors.atrFactor} />
        <TextField label="Signal max age (s)" inputMode="numeric" value={form.signalMaxAgeSeconds} onChange={(v) => set({ signalMaxAgeSeconds: v })} error={errors.signalMaxAgeSeconds} />
        <TextField label="Max price deviation (%)" inputMode="decimal" value={form.maxPriceDeviationPct} onChange={(v) => set({ maxPriceDeviationPct: v })} error={errors.maxPriceDeviationPct} />
      </div>
      <SegmentedControl<Direction> label="Permitted directions" value={form.permittedDirections} onChange={(v) => set({ permittedDirections: v })} options={DIRECTIONS.map((d) => ({ value: d, label: DIRECTION_LABELS[d] }))} />
      <SegmentedControl<OppositePolicy> label="Opposite signal" value={form.oppositePolicy} onChange={(v) => set({ oppositePolicy: v })} options={OPPOSITE_POLICIES.map((o) => ({ value: o, label: OPPOSITE_LABELS[o] }))} />
      <ChipCheckboxGroup
        label="Approved pairs"
        description="Investors can use this version only on these pairs."
        options={pairs.map((p) => ({ value: p.id, label: `${p.base}/${p.quote}` }))}
        value={form.instrumentIds}
        onChange={(v) => set({ instrumentIds: v })}
        error={errors.instrumentIds ?? Object.entries(errors).find(([k]) => k.startsWith('instrumentIds.'))?.[1]}
      />
    </div>
  );
}

function VersionRow({ v, pairs }: { v: StrategyVersionDto; pairs: InstrumentDto[] }) {
  const names = v.instrumentIds.map((id) => pairs.find((p) => p.id === id)?.symbol ?? 'unknown').join(', ');
  return (
    <li data-testid={`version-${v.version}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
      <span className="font-semibold text-ink">v{v.version}</span>
      {v.status === 'PUBLISHED' ? (
        <StatusPill tone={v.isLatest ? 'gain' : 'neutral'} icon={LockIcon}>
          {v.isLatest ? 'Published · latest' : 'Published'}
        </StatusPill>
      ) : (
        <StatusPill tone="warn">Draft</StatusPill>
      )}
      <span className="text-xs text-muted">
        {v.timeframe} · ATR {v.atrLength} × {v.atrFactor} · {v.emaFilter === 'OFF' ? 'EMA off' : 'EMA 200'} · {DIRECTION_LABELS[v.permittedDirections]} · {OPPOSITE_LABELS[v.oppositePolicy]} · pairs: {names}
      </span>
    </li>
  );
}

function PackageCard({ pkg, pairs }: { pkg: PackageDto; pairs: InstrumentDto[] }) {
  const router = useRouter();
  const draft = pkg.versions.find((v) => v.status === 'DRAFT');
  const latest = pkg.versions.find((v) => v.isLatest);
  const [form, setForm] = useState<Form | null>(draft ? formFrom(draft) : null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);

  const fail = (r: { issues: { path: string; message: string }[]; message: string; code: string }) => {
    setErrors(issueMap(r.issues));
    toast.error(r.message);
    if (r.code === 'REVISION_CONFLICT') router.refresh();
  };

  const saveDraft = async () => {
    if (!form) return;
    const r = draft
      ? await request<StrategyVersionDto>('PATCH', `/v1/admin/strategy-versions/${draft.id}`, { body: body(form), revision: draft.revision })
      : await request<StrategyVersionDto>('POST', `/v1/admin/strategy-packages/${pkg.id}/versions`, { body: body(form) });
    if (!r.ok) return fail(r);
    setErrors({});
    toast.success(`Draft v${r.data.version} saved`);
    router.refresh();
  };

  const publish = async () => {
    setConfirm(false);
    if (!draft) return;
    const r = await request<StrategyVersionDto>('POST', `/v1/admin/strategy-versions/${draft.id}/publish`, { revision: draft.revision });
    if (!r.ok) return fail(r);
    toast.success(`v${r.data.version} published`, { description: 'Existing investor settings stay on their current version.' });
    setForm(null);
    router.refresh();
  };

  return (
    <section data-testid={`package-${pkg.name}`} className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-ink">{pkg.name}</h3>
        {!form && (
          <Button size="sm" icon={PlusIcon} onClick={() => setForm(formFrom(latest, latest ? undefined : pairs.filter((p) => p.status === 'PUBLISHED').map((p) => p.id)))}>
            New version
          </Button>
        )}
      </header>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {pkg.versions.map((v) => (
          <VersionRow key={v.id} v={v} pairs={pairs} />
        ))}
        {pkg.versions.length === 0 && <li className="px-3 py-2 text-xs text-subtle">No versions yet.</li>}
      </ul>
      {form && (
        <div className="space-y-4 rounded-lg border border-warn/30 bg-warn/5 p-4">
          <p className="text-sm font-medium text-ink">{draft ? `Draft v${draft.version}` : `New draft v${(pkg.versions[0]?.version ?? 0) + 1}`}</p>
          <VersionForm form={form} onChange={setForm} errors={errors} pairs={pairs.filter((p) => p.status === 'PUBLISHED')} />
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={saveDraft}>
              Save draft
            </Button>
            {draft && (
              <Button icon={SendIcon} onClick={() => setConfirm(true)}>
                Publish v{draft.version}
              </Button>
            )}
            {!draft && (
              <Button variant="ghost" onClick={() => setForm(null)}>
                Cancel
              </Button>
            )}
          </div>
          <p className="text-xs text-subtle">Publishing freezes this version permanently. Investors keep the version they selected until they choose to move.</p>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        title={`Publish v${draft?.version}?`}
        description="A published version can never be edited. New order blocks can select it; existing blocks stay pinned to their current version."
        confirmLabel="Publish"
        onConfirm={publish}
        onCancel={() => setConfirm(false)}
      />
    </section>
  );
}

/** CFG-02 Strategy packages: drafts, immutable published versions, approved pair mappings. */
export function StrategiesAdmin({ packages, pairs }: { packages: PackageDto[]; pairs: InstrumentDto[] }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>();

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await request('POST', '/v1/admin/strategy-packages', { body: { name } });
    if (!r.ok) return setError(issueMap(r.issues).name ?? r.message);
    setName('');
    setError(undefined);
    toast.success('Package created — add its first version');
    router.refresh();
  };

  return (
    <div className="space-y-5">
      <form onSubmit={create} className="flex flex-wrap items-start gap-2 rounded-xl border border-line bg-surface p-4" noValidate>
        <TextField label="New strategy package" placeholder="e.g. Supertrend 5m momentum" value={name} onChange={setName} error={error} className="min-w-[260px] flex-1" />
        <Button type="submit" icon={PlusIcon} className="mt-7" disabled={!name}>
          Create package
        </Button>
      </form>
      {packages.map((p) => (
        <PackageCard key={`${p.id}-${p.versions.map((v) => `${v.id}:${v.revision}`).join()}`} pkg={p} pairs={pairs} />
      ))}
    </div>
  );
}
