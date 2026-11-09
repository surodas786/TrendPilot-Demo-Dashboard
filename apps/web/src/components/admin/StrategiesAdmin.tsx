'use client';

import React, { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ArchiveIcon, ArchiveRestoreIcon, CopyPlusIcon, LockIcon, PencilIcon, PlusIcon, SendIcon, Trash2Icon } from 'lucide-react';
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

function VersionRow({ v, pairs, hasDraft, archived, onEdit, onDelete, onDeriveFrom }: { v: StrategyVersionDto; pairs: InstrumentDto[]; hasDraft: boolean; archived: boolean; onEdit: () => void; onDelete: () => void; onDeriveFrom: () => void }) {
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
      {!archived && (
        <span className="ml-auto flex gap-1.5">
          {v.status === 'DRAFT' ? (
            <>
              <Button size="sm" icon={PencilIcon} onClick={onEdit} aria-label={`Edit draft v${v.version}`}>
                Edit draft
              </Button>
              <Button size="sm" variant="ghost" icon={Trash2Icon} onClick={onDelete} aria-label={`Delete draft v${v.version}`}>
                Delete draft
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" icon={CopyPlusIcon} onClick={onDeriveFrom} disabled={hasDraft} title={hasDraft ? 'Publish or delete the open draft first (one draft per package).' : undefined} aria-label={`Create draft from v${v.version}`}>
              Create draft from this version
            </Button>
          )}
        </span>
      )}
    </li>
  );
}

type Confirm = 'publish' | 'deleteDraft' | 'archive' | 'restore' | 'deletePackage';

function PackageCard({ pkg, pairs, autoOpen }: { pkg: PackageDto; pairs: InstrumentDto[]; autoOpen: boolean }) {
  const router = useRouter();
  const draft = pkg.versions.find((v) => v.status === 'DRAFT');
  const latest = pkg.versions.find((v) => v.isLatest);
  const published = pkg.versions.filter((v) => v.status === 'PUBLISHED');
  const archived = pkg.archivedAt !== null;
  const livePairs = pairs.filter((p) => p.status === 'PUBLISHED');
  const [form, setForm] = useState<Form | null>(() => (draft && !archived ? formFrom(draft) : autoOpen && !archived ? formFrom(undefined, livePairs.map((p) => p.id)) : null));
  const [derivedFrom, setDerivedFrom] = useState<number | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [rename, setRename] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  // Save/Publish stay disabled until the refreshed data has arrived (the card re-renders from it).
  const [refreshing, startRefresh] = useTransition();
  const refresh = () => startRefresh(() => router.refresh());

  const fail = (r: { issues: { path: string; message: string }[]; message: string; code: string }) => {
    setErrors(issueMap(r.issues));
    toast.error(r.message, { duration: 10_000 });
    if (r.code === 'REVISION_CONFLICT') router.refresh();
  };

  /** Saves the form as the package's draft (creating it when needed). Returns the saved draft. */
  const persist = async (): Promise<StrategyVersionDto | null> => {
    if (!form) return null;
    const r = draft
      ? await request<StrategyVersionDto>('PATCH', `/v1/admin/strategy-versions/${draft.id}`, { body: body(form), revision: draft.revision })
      : await request<StrategyVersionDto>('POST', `/v1/admin/strategy-packages/${pkg.id}/versions`, { body: body(form) });
    if (!r.ok) {
      fail(r);
      return null;
    }
    setErrors({});
    return r.data;
  };

  const saveDraft = async () => {
    setBusy(true);
    const d = await persist();
    setBusy(false);
    if (!d) return;
    toast.success(`Draft v${d.version} saved`);
    refresh();
  };

  /** Publish exactly what the form shows: save first, then publish that revision. */
  const publish = async () => {
    setConfirm(null);
    setBusy(true);
    const d = await persist();
    if (!d) return setBusy(false);
    const r = await request<StrategyVersionDto>('POST', `/v1/admin/strategy-versions/${d.id}/publish`, { revision: d.revision });
    setBusy(false);
    if (!r.ok) return fail(r);
    toast.success(`v${r.data.version} published (${r.data.timeframe})`, { description: 'Existing investor settings stay pinned to their current version.' });
    setForm(null);
    setDerivedFrom(null);
    refresh();
  };

  const act = async (fn: () => Promise<{ ok: boolean; message?: string }>, success: string) => {
    setConfirm(null);
    const r = await fn();
    if (!r.ok) toast.error(r.message ?? 'Request failed.', { duration: 12_000 });
    else toast.success(success);
    router.refresh();
  };

  const saveName = async (e: React.FormEvent) => {
    e.preventDefault();
    if (rename === null) return;
    const r = await request<{ name: string }>('PATCH', `/v1/admin/strategy-packages/${pkg.id}`, { body: { name: rename }, revision: pkg.revision });
    if (!r.ok) {
      setRenameError(issueMap(r.issues).name ?? r.message);
      if (r.code === 'REVISION_CONFLICT') router.refresh();
      return;
    }
    toast.success(`Renamed to “${r.data.name}”`, { description: 'Versions, routes and investor settings are unchanged.' });
    setRename(null);
    setRenameError(undefined);
    router.refresh();
  };

  const confirmText: Record<Confirm, { title: string; description: string; label: string; tone?: 'danger' }> = {
    publish: {
      title: `Publish v${draft?.version ?? (pkg.versions[0]?.version ?? 0) + 1} (${form?.timeframe ?? ''})?`,
      description: 'Your current form is saved and published. A published version can never be edited or deleted. New order blocks can select it; existing blocks stay pinned to their version.',
      label: 'Publish'
    },
    deleteDraft: { title: `Delete draft v${draft?.version}?`, description: 'The unpublished draft and its settings are removed permanently. Published versions are not affected.', label: 'Delete draft', tone: 'danger' },
    archive: {
      title: `Archive “${pkg.name}”?`,
      description: 'It disappears from route setup, new drafts and investor Trade Settings. All versions and their history are kept, and you can restore it later. Blocked while an enabled route, an investor setting or an open position depends on it.',
      label: 'Archive package'
    },
    restore: { title: `Restore “${pkg.name}”?`, description: 'It becomes available again for routes, drafts and investor settings.', label: 'Restore' },
    deletePackage: { title: `Delete “${pkg.name}”?`, description: 'This package was never published. It and its draft are removed permanently. This cannot be undone.', label: 'Delete package', tone: 'danger' }
  };
  const runConfirm = () => {
    switch (confirm) {
      case 'publish':
        return void publish();
      case 'deleteDraft':
        return void act(() => request('DELETE', `/v1/admin/strategy-versions/${draft!.id}`, { revision: draft!.revision }), `Draft v${draft!.version} deleted`).then(() => setForm(null));
      case 'archive':
        return void act(() => request('POST', `/v1/admin/strategy-packages/${pkg.id}/archive`, { revision: pkg.revision }), `“${pkg.name}” archived`);
      case 'restore':
        return void act(() => request('POST', `/v1/admin/strategy-packages/${pkg.id}/restore`, { revision: pkg.revision }), `“${pkg.name}” restored`);
      case 'deletePackage':
        return void act(() => request('DELETE', `/v1/admin/strategy-packages/${pkg.id}`, { revision: pkg.revision }), `“${pkg.name}” deleted`);
    }
  };

  return (
    <section data-testid={`package-${pkg.name}`} className={`space-y-3 rounded-xl border bg-surface p-4 ${archived ? 'border-line/60 opacity-80' : 'border-line'}`}>
      <header className="flex flex-wrap items-center gap-2">
        {rename === null ? (
          <>
            <h3 className="text-base font-semibold text-ink">{pkg.name}</h3>
            {latest ? (
              <StatusPill tone="neutral">
                <span data-testid="package-current">
                  current v{latest.version} · {latest.timeframe}
                </span>
              </StatusPill>
            ) : (
              <StatusPill tone="warn">never published</StatusPill>
            )}
            {archived && (
              <StatusPill tone="warn" icon={ArchiveIcon}>
                Archived
              </StatusPill>
            )}
          </>
        ) : (
          <form onSubmit={saveName} className="flex flex-wrap items-start gap-2" noValidate>
            <TextField label="Package name" value={rename} onChange={setRename} error={renameError} className="min-w-[280px]" />
            <Button type="submit" size="sm" variant="primary" className="mt-7">
              Save name
            </Button>
            <Button size="sm" className="mt-7" onClick={() => (setRename(null), setRenameError(undefined))}>
              Cancel
            </Button>
          </form>
        )}
        <span className="ml-auto flex flex-wrap gap-1.5">
          {rename === null && (
            <Button size="sm" icon={PencilIcon} onClick={() => setRename(pkg.name)}>
              Edit package
            </Button>
          )}
          {!archived && !form && !draft && (
            <Button size="sm" icon={PlusIcon} onClick={() => (setDerivedFrom(latest?.version ?? null), setForm(formFrom(latest, latest ? undefined : livePairs.map((p) => p.id))))}>
              New version
            </Button>
          )}
          {archived ? (
            <Button size="sm" icon={ArchiveRestoreIcon} onClick={() => setConfirm('restore')}>
              Restore
            </Button>
          ) : published.length ? (
            <Button size="sm" variant="ghost" icon={ArchiveIcon} onClick={() => setConfirm('archive')}>
              Archive
            </Button>
          ) : (
            <Button size="sm" variant="ghost" icon={Trash2Icon} onClick={() => setConfirm('deletePackage')}>
              Delete package
            </Button>
          )}
        </span>
      </header>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {pkg.versions.map((v) => (
          <VersionRow
            key={v.id}
            v={v}
            pairs={pairs}
            hasDraft={!!draft}
            archived={archived}
            onEdit={() => (setDerivedFrom(null), setForm(formFrom(v)))}
            onDelete={() => setConfirm('deleteDraft')}
            onDeriveFrom={() => (setDerivedFrom(v.version), setForm(formFrom(v)))}
          />
        ))}
        {pkg.versions.length === 0 && <li className="px-3 py-2 text-xs text-subtle">No versions yet.</li>}
      </ul>
      {form && !archived && (
        <div className="space-y-4 rounded-lg border border-warn/30 bg-warn/5 p-4" data-testid="draft-form">
          <p className="text-sm font-medium text-ink">
            {draft ? `Draft v${draft.version}` : `New draft v${(pkg.versions[0]?.version ?? 0) + 1}`}
            {derivedFrom !== null && !draft && <span className="text-xs font-normal text-subtle"> · prefilled from v{derivedFrom}</span>}
          </p>
          <VersionForm form={form} onChange={setForm} errors={errors} pairs={livePairs} />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void saveDraft()} disabled={busy || refreshing}>
              Save draft
            </Button>
            <Button variant="primary" icon={SendIcon} onClick={() => setConfirm('publish')} disabled={busy || refreshing}>
              Publish
            </Button>
            {!draft && (
              <Button variant="ghost" onClick={() => (setForm(null), setDerivedFrom(null))}>
                Cancel
              </Button>
            )}
          </div>
          <p className="text-xs text-subtle">Save draft keeps working on it. Publish saves and freezes it as a new version; investors keep the version they selected until they choose to move.</p>
        </div>
      )}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm ? confirmText[confirm].title : ''}
        description={confirm ? confirmText[confirm].description : ''}
        confirmLabel={confirm ? confirmText[confirm].label : ''}
        tone={confirm ? confirmText[confirm].tone : undefined}
        onConfirm={runConfirm}
        onCancel={() => setConfirm(null)}
      />
    </section>
  );
}

/** CFG-02 Strategy packages: drafts, immutable published versions, approved pair mappings, archive. */
export function StrategiesAdmin({ packages, pairs }: { packages: PackageDto[]; pairs: InstrumentDto[] }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [justCreated, setJustCreated] = useState<string | null>(null);
  const active = packages.filter((p) => !p.archivedAt);
  const archived = packages.filter((p) => p.archivedAt);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await request<{ id: string; name: string }>('POST', '/v1/admin/strategy-packages', { body: { name } });
    if (!r.ok) return setError(issueMap(r.issues).name ?? r.message);
    setName('');
    setError(undefined);
    setJustCreated(r.data.id);
    toast.success(`“${r.data.name}” created`, { description: 'Configure its first version below, then save the draft or publish it.' });
    router.refresh();
  };

  const card = (p: PackageDto) => <PackageCard key={`${p.id}-${p.revision}-${p.versions.map((v) => `${v.id}:${v.revision}`).join()}`} pkg={p} pairs={pairs} autoOpen={p.id === justCreated && p.versions.length === 0} />;

  return (
    <div className="space-y-5">
      <form onSubmit={create} className="flex flex-wrap items-start gap-2 rounded-xl border border-line bg-surface p-4" noValidate>
        <TextField label="New strategy package" placeholder="e.g. Supertrend 5m momentum" value={name} onChange={setName} error={error} className="min-w-[260px] flex-1" />
        <Button type="submit" icon={PlusIcon} className="mt-7" disabled={!name}>
          Create package
        </Button>
      </form>
      {active.map(card)}
      {archived.length > 0 && (
        <details className="space-y-3" data-testid="archived-packages">
          <summary className="cursor-pointer text-sm font-medium text-muted">Archived packages ({archived.length}) — hidden from new selections, history kept</summary>
          <div className="mt-3 space-y-3">{archived.map(card)}</div>
        </details>
      )}
    </div>
  );
}
