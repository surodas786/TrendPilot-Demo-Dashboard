'use client';

import React, { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangleIcon, EyeIcon, SendIcon } from 'lucide-react';
import { toast } from 'sonner';
import { commonExitDefinitionSchema, parseWith, type CommonExitDefinition } from '@trendpilot/domain';
import type { CommonExitRevisionDto, ExitPlanApplyOutcome, PartialCloseProtection } from '@trendpilot/db';
import { request } from '@/lib/api';
import { Button } from '../ui/Button';
import { SegmentedControl } from '../ui/SegmentedControl';
import { ExitPlanEditor } from '../tradeSettings/ExitPlanEditor';
import { errorMap, exitDraftFrom, exitPlanPayload, newTargetId, trailingOff, type ExitDraft } from '../tradeSettings/draft';

interface View {
  current: CommonExitRevisionDto | null;
  revisions: CommonExitRevisionDto[];
  linked: {
    blocks: { id: string; owner: string; symbol: string; exchange: string; mode: string }[];
    openPositions: { id: string; owner: string; symbol: string; exchange: string; mode: string; side: string; contracts: string; exitPlan: { source: string; adminVersion: number | null; appliedAt: string | null } }[];
  };
  partialExitProtection: Record<string, { PAPER: PartialCloseProtection; LIVE: PartialCloseProtection }>;
}

type PreviewItem = ExitPlanApplyOutcome & { owner: string; symbol: string; exchange: string; mode: string };
type Scope = 'FUTURE_ENTRIES' | 'EXISTING_POSITIONS';

const initialDraft = (): ExitDraft => {
  const fixed = () => ({ mode: 'FIXED' as const, targets: [{ id: newTargetId(), movePct: '3', closePct: '100' }], allocationPct: '100' });
  return { tp: { LONG: fixed(), SHORT: fixed() }, trailing: { LONG: trailingOff(), SHORT: trailingOff() } };
};

const FIELD_LABEL: Record<string, string> = { takeProfitLong: 'Long take profit', takeProfitShort: 'Short take profit', trailingLong: 'Long trailing take profit', trailingShort: 'Short trailing take profit' };

/** Admin → Common Exit Definition: edit, preview, publish; revision history. */
export function CommonExitAdmin({ initial }: { initial: View }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [draft, setDraft] = useState<ExitDraft>(() => (initial.current ? exitDraftFrom(initial.current.plan) : initialDraft()));
  const [touched, setTouched] = useState(false);
  const [left, setLeft] = useState<ReadonlySet<string>>(() => new Set());
  const [serverIssues, setServerIssues] = useState<Record<string, string>>({});
  const [scope, setScope] = useState<Scope>('FUTURE_ENTRIES');
  const [preview, setPreview] = useState<PreviewItem[] | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'publish' | null>(null);
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const payload = useMemo(() => exitPlanPayload(draft), [draft]);
  const issues = useMemo(() => {
    try {
      const r = parseWith(commonExitDefinitionSchema, payload);
      return r.ok ? [] : r.issues;
    } catch {
      return [{ path: '', message: 'Some values could not be checked.' }];
    }
  }, [payload]);
  const errors = { ...errorMap(issues), ...serverIssues };
  const err = (path: string) => (touched || left.has(path) ? errors[path] : undefined);
  const commit = (path: string) => setLeft((c) => (c.has(path) ? c : new Set(c).add(path)));
  const onChange = (patch: Partial<ExitDraft>) => {
    setServerIssues({});
    setPreview(null);
    setAck(false);
    setDraft((d) => ({ ...d, ...patch }));
  };

  const runPreview = async () => {
    setTouched(true);
    setFormError(null);
    if (issues.length) return;
    setBusy('preview');
    const r = await request<{ plan: CommonExitDefinition; positions: PreviewItem[] }>('POST', '/v1/admin/common-exit-definition/preview', { body: { plan: payload } });
    setBusy(null);
    if (!r.ok) {
      setServerIssues(errorMap(r.issues));
      setFormError(r.message);
      return;
    }
    setPreview(r.data.positions);
  };

  const publish = async () => {
    setTouched(true);
    setFormError(null);
    if (issues.length) return;
    if (scope === 'EXISTING_POSITIONS' && (!preview || !ack)) {
      setFormError('Preview the affected positions and confirm the warning before applying the change to open positions.');
      return;
    }
    setBusy('publish');
    const r = await request<{ revision: CommonExitRevisionDto; linkedBlocks: number; notifiedInvestors: number; positions: ExitPlanApplyOutcome[] }>('POST', '/v1/admin/common-exit-definition', {
      body: { plan: payload, scope, expectedVersion: view.current?.version ?? null, ...(note.trim() ? { note: note.trim() } : {}) }
    });
    setBusy(null);
    if (!r.ok) {
      if (r.issues.length) setServerIssues(errorMap(r.issues));
      setFormError(r.message);
      return;
    }
    const applied = r.data.positions.filter((p) => p.status === 'APPLIED').length;
    const skipped = r.data.positions.filter((p) => p.status === 'SKIPPED').length;
    toast.success(`Version ${r.data.revision.version} published`, {
      description: `${r.data.linkedBlocks} linked order block(s) use it for new entries; ${r.data.notifiedInvestors} investor(s) notified.${scope === 'EXISTING_POSITIONS' ? ` Open positions: ${applied} updated, ${skipped} kept on their previous plan.` : ''}`
    });
    setPreview(null);
    setAck(false);
    setNote('');
    const v = await request<View>('GET', '/v1/admin/common-exit-definition');
    if (v.ok) setView(v.data);
    router.refresh();
  };

  const prot = Object.entries(view.partialExitProtection);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
      <div className="space-y-5 rounded-xl border border-line bg-surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">{view.current ? `Editing version ${view.current.version} → publishes version ${view.current.version + 1}` : 'No rule published yet → publishes version 1'}</h3>
          <span className="text-xs text-subtle" data-testid="linked-count">
            {view.linked.blocks.length} linked order block(s) · {view.linked.openPositions.length} open position(s)
          </span>
        </div>
        <p className="text-xs text-subtle">Percentages of price are movement from the confirmed average entry, before fees and leverage. Stop loss stays per order block and is not part of this definition.</p>
        <ExitPlanEditor draft={draft} err={err} commit={commit} onChange={onChange} />

        <div className="space-y-3 border-t border-line pt-4" data-testid="apply-scope">
          <SegmentedControl<Scope>
            label="Apply to"
            value={scope}
            onChange={(v) => {
              setScope(v);
              setAck(false);
            }}
            options={[
              { value: 'FUTURE_ENTRIES', label: 'Future entries (default)' },
              { value: 'EXISTING_POSITIONS', label: 'Also existing linked positions' }
            ]}
            hint={
              scope === 'FUTURE_ENTRIES'
                ? 'Linked order blocks use the new rule for every new entry from now on. Open positions keep the exit plan snapshot they were opened with.'
                : 'Also updates the exit plan of every open position of a linked order block. Completed targets, pending exit quantities and trailing cycle history are kept; orders in flight are not duplicated. Positions that cannot take the change stay on their previous plan and are listed.'
            }
          />
          {scope === 'EXISTING_POSITIONS' && (
            <div className="space-y-3">
              <Button size="sm" icon={EyeIcon} onClick={() => void runPreview()} loading={busy === 'preview'} data-testid="preview-apply">
                Preview affected positions
              </Button>
              {preview && (
                <div className="space-y-2" data-testid="apply-preview">
                  {preview.length === 0 && <p className="text-xs text-muted">No linked open positions.</p>}
                  {preview.map((p) => (
                    <div key={p.positionId} className="rounded-lg border border-line p-3 text-xs" data-testid="apply-preview-item" data-status={p.status}>
                      <p className="font-medium text-ink">
                        {p.owner} · {p.symbol} · {p.exchange} · {p.mode === 'LIVE' ? 'Live' : 'Paper'} · {p.side} —{' '}
                        <span className={p.status === 'SKIPPED' ? 'text-warn' : 'text-gain'}>{p.status === 'SKIPPED' ? 'stays on its previous plan' : 'will be updated'}</span>
                      </p>
                      {p.reason && <p className="mt-1 text-warn">{p.reason}</p>}
                      {p.changes.length > 0 && (
                        <ul className="mt-1 list-disc pl-4 text-muted">
                          {p.changes.map((c) => (
                            <li key={c}>{c}</li>
                          ))}
                        </ul>
                      )}
                      {p.kept.length > 0 && (
                        <ul className="mt-1 list-disc pl-4 text-subtle">
                          {p.kept.map((c) => (
                            <li key={c}>Kept: {c}</li>
                          ))}
                        </ul>
                      )}
                      {p.warnings.map((w) => (
                        <p key={w} className="mt-1 text-loss">
                          {w}
                        </p>
                      ))}
                    </div>
                  ))}
                  <label className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3 text-xs text-ink">
                    <input type="checkbox" className="mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="apply-ack" />
                    <span>
                      <AlertTriangleIcon className="mr-1 inline h-3.5 w-3.5 text-warn" aria-hidden />I understand that changed thresholds may close part or all of a position on the next fresh price.
                    </span>
                  </label>
                </div>
              )}
            </div>
          )}
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            Change note (optional, recorded in the audit log)
            <input className="h-10 rounded-lg border border-line bg-inset px-3 text-sm" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} data-testid="publish-note" />
          </label>
          {touched && issues.length > 0 && <p className="text-xs text-loss">Fix the highlighted fields before publishing.</p>}
          {formError && (
            <p role="alert" className="text-xs text-loss">
              {formError}
            </p>
          )}
          <div className="flex justify-end">
            <Button variant="primary" icon={SendIcon} onClick={() => void publish()} loading={busy === 'publish'} data-testid="publish">
              Publish version {(view.current?.version ?? 0) + 1}
            </Button>
          </div>
        </div>
      </div>

      <aside className="space-y-5">
        <section className="rounded-xl border border-line bg-surface p-4">
          <h3 className="text-sm font-semibold text-ink">Partial-close protection by exchange</h3>
          <ul className="mt-2 space-y-2 text-xs">
            {prot.map(([x, m]) => (
              <li key={x} data-testid="protection-row" data-exchange={x} data-verified={m.LIVE.verified}>
                <span className="font-medium text-ink">{x} Live:</span> {m.LIVE.verified ? <span className="text-gain">verified — {m.LIVE.mechanism}</span> : <span className="text-warn">not verified as protected. {m.LIVE.limitation}</span>}
              </li>
            ))}
            <li className="text-subtle">Paper: the simulator resizes the stop to the remainder atomically.</li>
          </ul>
        </section>
        <section className="rounded-xl border border-line bg-surface p-4" data-testid="linked-positions">
          <h3 className="text-sm font-semibold text-ink">Linked open positions</h3>
          {view.linked.openPositions.length === 0 ? (
            <p className="mt-2 text-xs text-muted">None.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-xs text-muted">
              {view.linked.openPositions.map((p) => (
                <li key={p.id}>
                  {p.owner} · {p.symbol} · {p.mode === 'LIVE' ? 'Live' : 'Paper'} · {p.side} {p.contracts} — uses {p.exitPlan.source === 'ADMIN' ? `admin v${p.exitPlan.adminVersion}` : 'its own plan'}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="rounded-xl border border-line bg-surface p-4" data-testid="revisions">
          <h3 className="text-sm font-semibold text-ink">Published versions</h3>
          {view.revisions.length === 0 ? (
            <p className="mt-2 text-xs text-muted">Nothing published yet. Investors cannot turn on Sync Admin Setting until version 1 is published.</p>
          ) : (
            <ol className="mt-2 space-y-3 text-xs">
              {view.revisions.map((r) => (
                <li key={r.version} className="border-b border-line pb-2 last:border-0" data-testid="revision">
                  <p className="font-medium text-ink">
                    Version {r.version} · {new Date(r.publishedAt).toLocaleString()}
                  </p>
                  <p className="text-muted">
                    By {r.author.name} · {r.scope === 'EXISTING_POSITIONS' ? 'future entries and existing linked positions' : 'future entries'}
                  </p>
                  <p className="text-subtle">Changed: {r.changes.length ? r.changes.map((c) => FIELD_LABEL[c.field] ?? c.field).join(', ') : 'nothing'}</p>
                  {r.applyResult && (
                    <p className="text-subtle">
                      Positions: {r.applyResult.filter((a) => a.status === 'APPLIED').length} updated, {r.applyResult.filter((a) => a.status === 'SKIPPED').length} kept
                    </p>
                  )}
                  {r.note && <p className="italic text-subtle">“{r.note}”</p>}
                </li>
              ))}
            </ol>
          )}
        </section>
      </aside>
    </div>
  );
}
