'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRoundIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';
import type { InstrumentDto, PackageDto, SignalEventOpsDto, SignalRouteDto } from '@trendpilot/db';
import { SIGNAL_ACTIONS, type SignalAction } from '@trendpilot/domain';
import { issueMap, request } from '@/lib/api';
import { CopyButtonInline } from './CopyButtonInline';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { FilterSelect } from '../ui/FilterSelect';
import { SegmentedControl } from '../ui/SegmentedControl';
import { StatusPill } from '../ui/StatusPill';
import { TextField } from '../ui/TextField';

const template = (action: 'BULLISH_FLIP' | 'BEARISH_FLIP') => `{
  "action": "${action}",
  "source_exchange": "{{exchange}}",
  "source_symbol": "{{ticker}}",
  "interval": "{{interval}}",
  "bar_open_utc": "{{time}}",
  "alert_fired_utc": "{{timenow}}",
  "reference_price": "{{close}}"
}`;

interface Props {
  ingress: { namespace: string; tokenHint: string; rotatedAt: string | null; urlTemplate: string } | null;
  routes: SignalRouteDto[];
  instruments: InstrumentDto[];
  packages: PackageDto[];
  events: SignalEventOpsDto[];
  rejections: { id: string; reason: string; httpStatus: number; receivedAt: string; detail: unknown }[];
  timezone: string;
}

type RouteForm = {
  name: string;
  sourceExchange: string;
  sourceSymbol: string;
  interval: '5' | '15';
  action: SignalAction;
  kind: 'ACTIONABLE' | 'INFO_ONLY';
  instrumentId: string;
  packageId: string;
  maxSignalAgeSeconds: string;
  clockToleranceSeconds: string;
};

const formFrom = (r: SignalRouteDto): RouteForm => ({
  name: r.name,
  sourceExchange: r.sourceExchange,
  sourceSymbol: r.sourceSymbol,
  interval: r.interval as '5' | '15',
  action: r.action as SignalAction,
  kind: r.kind,
  instrumentId: r.instrument.id,
  packageId: r.package.id,
  maxSignalAgeSeconds: String(r.maxSignalAgeSeconds),
  clockToleranceSeconds: String(r.clockToleranceSeconds)
});

/** The lineage's real current timeframe, so a package name like "… 15m" cannot hide that v2 runs 5m. */
const latestOf = (p: PackageDto) => p.versions.find((v) => v.isLatest) ?? null;
const lineageLabel = (p: PackageDto) => {
  const v = latestOf(p);
  return v ? `${p.name} — current v${v.version}: ${v.timeframe}` : `${p.name} — no published version`;
};

function TimeframeTag({ latest, interval }: { latest: { version: number; timeframe: string } | null; interval: string }) {
  if (!latest) return <StatusPill tone="warn">no published version</StatusPill>;
  const match = latest.timeframe === `${interval}m`;
  return (
    <StatusPill tone={match ? 'neutral' : 'warn'}>
      <span data-testid="lineage-timeframe">
        v{latest.version} · {latest.timeframe}
        {match ? '' : ` ≠ route ${interval}m`}
      </span>
    </StatusPill>
  );
}

function RouteFields({ form, setForm, errors, instruments, packages }: { form: RouteForm; setForm: (f: RouteForm) => void; errors: Record<string, string>; instruments: InstrumentDto[]; packages: PackageDto[] }) {
  const pkg = packages.find((p) => p.id === form.packageId);
  const latest = pkg ? latestOf(pkg) : null;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField label="Route name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} error={errors.name} />
        <TextField label="Source exchange ({{exchange}})" value={form.sourceExchange} onChange={(v) => setForm({ ...form, sourceExchange: v })} error={errors.sourceExchange} />
        <TextField label="Source ticker ({{ticker}})" placeholder="BTCUSDT.P" value={form.sourceSymbol} onChange={(v) => setForm({ ...form, sourceSymbol: v })} error={errors.sourceSymbol} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <SegmentedControl<'5' | '15'> label="Interval" value={form.interval} onChange={(v) => setForm({ ...form, interval: v })} options={[{ value: '5', label: '5m' }, { value: '15', label: '15m' }]} />
          {errors.interval && <p className="mt-1 text-xs text-loss">{errors.interval}</p>}
        </div>
        <FilterSelect label="Action" value={form.action} onChange={(v) => setForm({ ...form, action: v as SignalAction })} options={SIGNAL_ACTIONS.map((a) => ({ value: a, label: a }))} />
        <SegmentedControl<'ACTIONABLE' | 'INFO_ONLY'> label="Kind" value={form.kind} onChange={(v) => setForm({ ...form, kind: v })} options={[{ value: 'ACTIONABLE', label: 'Actionable' }, { value: 'INFO_ONLY', label: 'Info only' }]} />
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <FilterSelect label="Execution contract" value={form.instrumentId} onChange={(v) => setForm({ ...form, instrumentId: v })} options={instruments.map((i) => ({ value: i.id, label: `${i.symbol} (MEXC ${i.exchangeSymbol})` }))} />
          {errors.instrumentId && <p className="mt-1 text-xs text-loss">{errors.instrumentId}</p>}
        </div>
        <div>
          <FilterSelect
            label="Strategy lineage"
            value={form.packageId}
            onChange={(v) => setForm({ ...form, packageId: v })}
            options={packages.filter((p) => !p.archivedAt || p.id === form.packageId).map((p) => ({ value: p.id, label: lineageLabel(p) + (p.archivedAt ? ' (archived)' : '') }))}
          />
          {latest && (
            <p className={`mt-1 text-xs ${latest.timeframe === `${form.interval}m` ? 'text-subtle' : 'text-warn'}`} data-testid="form-lineage-timeframe">
              Current version v{latest.version} uses {latest.timeframe}
              {latest.timeframe === `${form.interval}m` ? '' : `; this route is ${form.interval}m`}
            </p>
          )}
          {errors.packageId && <p className="mt-1 text-xs text-loss">{errors.packageId}</p>}
        </div>
        <TextField label="Max signal age (s)" inputMode="numeric" value={form.maxSignalAgeSeconds} onChange={(v) => setForm({ ...form, maxSignalAgeSeconds: v })} error={errors.maxSignalAgeSeconds} />
        <TextField label="Clock tolerance (s)" inputMode="numeric" value={form.clockToleranceSeconds} onChange={(v) => setForm({ ...form, clockToleranceSeconds: v })} error={errors.clockToleranceSeconds} />
      </div>
    </>
  );
}

const bodyOf = (f: RouteForm) => ({ ...f, maxSignalAgeSeconds: Number(f.maxSignalAgeSeconds), clockToleranceSeconds: Number(f.clockToleranceSeconds) });
const formErrors = (r: { issues: { path: string; message: string }[]; message: string }) => (r.issues.length ? issueMap(r.issues) : { form: r.message });

/** UI-05 TradingView Webhook and Signal Routes, with operations views (counts only, no investor data). */
export function SignalsAdmin({ ingress, routes, instruments, packages, events, rejections, timezone }: Props) {
  const router = useRouter();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [form, setForm] = useState<RouteForm>({
    name: '',
    sourceExchange: 'MEXC',
    sourceSymbol: '',
    interval: '15',
    action: 'BULLISH_FLIP',
    kind: 'ACTIONABLE',
    instrumentId: instruments[0]?.id ?? '',
    packageId: packages.find((p) => !p.archivedAt)?.id ?? '',
    maxSignalAgeSeconds: '120',
    clockToleranceSeconds: '5'
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{ route: SignalRouteDto; form: RouteForm; errors: Record<string, string> } | null>(null);
  const [deleting, setDeleting] = useState<SignalRouteDto | null>(null);
  const fmt = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: timezone });

  const rotate = async () => {
    setConfirmRotate(false);
    const r = await request<{ url: string }>('POST', '/v1/admin/webhook/rotate');
    if (!r.ok) return toast.error(r.message);
    setRevealed(r.data.url);
    router.refresh();
  };

  const createRoute = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await request('POST', '/v1/admin/signal-routes', { body: bodyOf(form) });
    if (!r.ok) {
      setErrors(r.issues.length ? issueMap(r.issues) : { sourceSymbol: r.message });
      return;
    }
    setErrors({});
    toast.success('Route created');
    router.refresh();
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const r = await request('PUT', `/v1/admin/signal-routes/${editing.route.id}`, { body: bodyOf(editing.form), revision: editing.route.revision });
    if (!r.ok) {
      setEditing({ ...editing, errors: formErrors(r) });
      if (r.code === 'REVISION_CONFLICT') router.refresh();
      return;
    }
    toast.success('Route updated');
    setEditing(null);
    router.refresh();
  };

  const toggle = async (route: SignalRouteDto) => {
    const r = await request('PATCH', `/v1/admin/signal-routes/${route.id}`, { body: { enabled: !route.enabled }, revision: route.revision });
    if (!r.ok) toast.error(r.message, { duration: 10_000 });
    router.refresh();
  };

  const remove = async () => {
    const route = deleting;
    setDeleting(null);
    if (!route) return;
    const r = await request('DELETE', `/v1/admin/signal-routes/${route.id}`, { revision: route.revision });
    if (!r.ok) toast.error(r.message, { duration: 10_000 });
    else toast.success('Route deleted');
    router.refresh();
  };

  const disableInstead = async () => {
    const route = deleting;
    setDeleting(null);
    if (route) await toggle(route);
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-xl border border-line bg-surface p-4">
        <h3 className="text-sm font-semibold text-ink">Webhook URL</h3>
        {ingress ? (
          <>
            <p className="break-all font-mono text-xs text-muted">
              {ingress.urlTemplate.replace('<token>', ingress.tokenHint)}
            </p>
            <p className="text-xs text-subtle">
              Namespace {ingress.namespace} · {ingress.rotatedAt ? `rotated ${fmt(ingress.rotatedAt)}` : 'never rotated'}. The full token is stored only as a hash and is shown once, when rotated.
            </p>
            {revealed && (
              <div className="space-y-2 rounded-lg border border-warn/40 bg-warn/10 p-3" data-testid="revealed-webhook-url">
                <p className="text-xs font-semibold text-warn">Copy this URL into TradingView now. It will not be shown again.</p>
                <p className="break-all font-mono text-xs text-ink">{revealed}</p>
                <CopyButtonInline value={revealed} />
              </div>
            )}
            <Button size="sm" icon={KeyRoundIcon} onClick={() => setConfirmRotate(true)}>
              Rotate token
            </Button>
          </>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-muted">No TradingView webhook exists yet. Create it to get the webhook URL (shown once).</p>
            {revealed && (
              <div className="space-y-2 rounded-lg border border-warn/40 bg-warn/10 p-3" data-testid="revealed-webhook-url">
                <p className="text-xs font-semibold text-warn">Copy this URL into TradingView now. It will not be shown again.</p>
                <p className="break-all font-mono text-xs text-ink">{revealed}</p>
                <CopyButtonInline value={revealed} />
              </div>
            )}
            <Button size="sm" icon={KeyRoundIcon} onClick={() => void rotate()}>
              Create webhook
            </Button>
          </div>
        )}
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        {(['BULLISH_FLIP', 'BEARISH_FLIP'] as const).map((a) => (
          <div key={a} className="rounded-xl border border-line bg-surface p-4">
            <p className="text-sm font-semibold text-ink">{a === 'BULLISH_FLIP' ? 'Bullish alert message' : 'Bearish alert message'}</p>
            <p className="mt-0.5 text-xs text-subtle">Supertrend alert on a time-based chart, &ldquo;Once Per Bar Close&rdquo;.</p>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-inset p-3 text-xs text-ink">{template(a)}</pre>
            <CopyButtonInline value={template(a)} />
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-ink">Signal routes</h3>
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="border-b border-line text-xs text-subtle">
              <tr>
                <th className="px-4 py-2.5 font-medium">Source</th>
                <th className="px-4 py-2.5 font-medium">Interval</th>
                <th className="px-4 py-2.5 font-medium">Action</th>
                <th className="px-4 py-2.5 font-medium">Kind</th>
                <th className="px-4 py-2.5 font-medium">Contract · lineage</th>
                <th className="px-4 py-2.5 font-medium">Max age</th>
                <th className="px-4 py-2.5 font-medium">State</th>
                <th className="px-4 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {routes.map((r) => (
                <tr key={r.id} data-testid={`route-${r.sourceSymbol}-${r.interval}-${r.action}`}>
                  <td className="px-4 py-2.5 font-mono text-xs text-ink">
                    {r.sourceExchange}:{r.sourceSymbol}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{r.interval}m</td>
                  <td className="px-4 py-2.5 text-muted">{r.action}</td>
                  <td className="px-4 py-2.5">
                    <StatusPill tone={r.kind === 'ACTIONABLE' ? 'accent' : 'neutral'}>{r.kind === 'ACTIONABLE' ? 'Actionable' : 'Information only'}</StatusPill>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted">
                    <div>
                      {r.instrument.symbol} · {r.package.name}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <TimeframeTag latest={r.package.latest} interval={r.interval} />
                      {r.openPositions > 0 && <span className="text-[11px] text-subtle">{r.openPositions} open position(s)</span>}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-muted">{r.maxSignalAgeSeconds}s</td>
                  <td className="px-4 py-2.5">
                    <Button size="sm" variant={r.enabled ? 'ghost' : 'secondary'} onClick={() => toggle(r)}>
                      {r.enabled ? 'Enabled — disable' : 'Disabled — enable'}
                    </Button>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="flex gap-1.5">
                      <Button size="sm" icon={PencilIcon} onClick={() => setEditing({ route: r, form: formFrom(r), errors: {} })} aria-label={`Edit route ${r.name}`}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" icon={Trash2Icon} onClick={() => setDeleting(r)} aria-label={`Delete route ${r.name}`}>
                        Delete
                      </Button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {editing && (
          <form onSubmit={saveEdit} className="space-y-3 rounded-xl border border-accent/40 bg-surface p-4" noValidate data-testid="edit-route-form">
            <p className="text-sm font-medium text-ink">
              Edit route “{editing.route.name}”{' '}
              <span className="text-xs font-normal text-subtle">
                ({editing.route.history.events} event(s), {editing.route.history.rejections} rejection(s) recorded)
              </span>
            </p>
            <RouteFields form={editing.form} setForm={(f) => setEditing({ ...editing, form: f })} errors={editing.errors} instruments={instruments} packages={packages} />
            {editing.errors.form && <p className="rounded-lg border border-loss/40 bg-loss/10 p-2 text-xs text-loss">{editing.errors.form}</p>}
            <span className="flex gap-2">
              <Button type="submit" variant="primary">
                Save changes
              </Button>
              <Button onClick={() => setEditing(null)}>Cancel</Button>
            </span>
          </form>
        )}
        <form onSubmit={createRoute} className="space-y-3 rounded-xl border border-line bg-surface p-4" noValidate>
          <p className="text-sm font-medium text-ink">Add a route</p>
          <RouteFields form={form} setForm={setForm} errors={errors} instruments={instruments} packages={packages} />
          <Button type="submit" icon={PlusIcon} variant="primary" disabled={!form.name || !form.sourceSymbol}>
            Create route
          </Button>
        </form>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-ink">Recent accepted signals</h3>
        <p className="text-xs text-subtle">Outcome counts only. Investor identities and settings are not shown here.</p>
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[920px] text-left text-sm">
            <thead className="border-b border-line text-xs text-subtle">
              <tr>
                <th className="px-4 py-2.5 font-medium">Bar open → close</th>
                <th className="px-4 py-2.5 font-medium">Fired / received</th>
                <th className="px-4 py-2.5 font-medium">Signal</th>
                <th className="px-4 py-2.5 font-medium">Dispatch</th>
                <th className="px-4 py-2.5 font-medium">Outcomes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {events.map((e) => (
                <tr key={e.id} data-testid="ops-event">
                  <td className="px-4 py-2 text-xs text-muted">
                    {fmt(e.barOpenAt)} → {fmt(e.barCloseAt)}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted">
                    {fmt(e.alertFiredAt)} / {fmt(e.receivedAt)}
                  </td>
                  <td className="px-4 py-2 text-xs text-ink">
                    {e.action} · {e.source} · {e.interval}m · {e.referencePrice}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted">
                    {e.disposition === 'INFO_ONLY' ? 'Information only' : e.job ? `${e.job.status} (attempts ${e.job.attempts})` : '—'}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted">
                    {Object.entries(e.outcomes)
                      .map(([k, n]) => `${k} ×${n}`)
                      .join(', ') || '—'}
                  </td>
                </tr>
              ))}
              {events.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-subtle">
                    No signals yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-ink">Recent rejections</h3>
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface text-xs">
          {rejections.map((r) => (
            <li key={r.id} className="flex flex-wrap gap-x-3 px-4 py-2">
              <span className="text-muted">{fmt(r.receivedAt)}</span>
              <StatusPill tone="loss">
                {r.httpStatus} {r.reason}
              </StatusPill>
              <span className="truncate font-mono text-subtle">{JSON.stringify((r.detail as { payload?: unknown })?.payload ?? r.detail).slice(0, 160)}</span>
            </li>
          ))}
          {rejections.length === 0 && <li className="px-4 py-3 text-subtle">No rejections.</li>}
        </ul>
      </section>

      {deleting && (deleting.history.events > 0 || deleting.history.rejections > 0) ? (
        <ConfirmDialog
          open
          title="This route cannot be deleted"
          description={`“${deleting.name}” has signal history (${deleting.history.events} accepted event(s), ${deleting.history.rejections} rejection(s)) that must stay traceable. ${deleting.enabled ? 'You can disable it instead: it will stop matching alerts but keep its history.' : 'It is already disabled.'}`}
          confirmLabel={deleting.enabled ? 'Disable route' : 'Close'}
          onConfirm={deleting.enabled ? disableInstead : () => setDeleting(null)}
          onCancel={() => setDeleting(null)}
        />
      ) : (
        <ConfirmDialog
          open={deleting !== null}
          title="Delete this route permanently?"
          description={deleting ? `“${deleting.name}” (${deleting.sourceExchange}:${deleting.sourceSymbol} ${deleting.interval}m ${deleting.action}) has no signal history. Deleting it cannot be undone.` : ''}
          confirmLabel="Delete route"
          tone="danger"
          onConfirm={remove}
          onCancel={() => setDeleting(null)}
        />
      )}

      <ConfirmDialog
        open={confirmRotate}
        title="Rotate the webhook token?"
        description="TradingView alerts using the current URL stop working immediately. Update every alert with the new URL. Deduplication is unaffected."
        confirmLabel="Rotate"
        tone="danger"
        onConfirm={rotate}
        onCancel={() => setConfirmRotate(false)}
      />
    </div>
  );
}
