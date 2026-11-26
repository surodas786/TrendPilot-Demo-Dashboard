'use client';

import React from 'react';
import { AlertTriangleIcon, CheckCircle2Icon, FlaskConicalIcon } from 'lucide-react';
import { exchangeLabel, type OrderPreview } from '@trendpilot/domain';
import { StatusPill } from '../ui/StatusPill';

export type PreviewResult = OrderPreview & {
  instrument: { symbol: string; exchangeSymbol: string; fixtureLabel: string | null; exchange?: string; quoteCurrency?: string };
  exitPlan?: { source: 'CUSTOM' | 'ADMIN'; adminVersion: number | null };
  partialExitProtection?: { verified: boolean; limitation: string | null };
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-0.5">
      <dt className="text-subtle">{label}</dt>
      <dd className="text-right text-ink tabular-nums">{value}</dd>
    </div>
  );
}

/** EXE-01 preview: estimates from a labelled fixture or a fresh public quote from the pair's own exchange. Places no order. */
export function PreviewPanel({ preview }: { preview: PreviewResult }) {
  return (
    <section aria-label="Order preview" data-testid="order-preview" className="space-y-3 rounded-lg border border-accent/30 bg-accent/5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {preview.quote.source.endsWith('_PUBLIC') ? (
          <StatusPill tone="accent">{exchangeLabel(preview.quote.source.replace(/_PUBLIC$/, ''))} public price</StatusPill>
        ) : (
          <StatusPill tone="warn" icon={FlaskConicalIcon}>
            Fixture data
          </StatusPill>
        )}
        <span className="text-xs text-muted">
          {preview.instrument.exchangeSymbol} · bid {preview.quote.bid} · ask {preview.quote.ask} · mark {preview.quote.mark}
          {preview.instrument.quoteCurrency ? ` ${preview.instrument.quoteCurrency}` : ''}
          {preview.quote.asOf ? ` · price time ${new Date(preview.quote.asOf).toISOString().slice(11, 19)} UTC` : ''}
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {preview.sides.map((s) => (
          <div key={s.side} className="rounded-lg border border-line bg-surface p-3 text-xs">
            <p className="mb-2 flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-ink">{s.side === 'LONG' ? 'Long entry' : 'Short entry'}</span>
              {s.ok ? (
                <StatusPill tone="gain" icon={CheckCircle2Icon}>
                  Valid
                </StatusPill>
              ) : (
                <StatusPill tone="loss" icon={AlertTriangleIcon}>
                  Would be blocked
                </StatusPill>
              )}
            </p>
            <dl>
              <Row label={`Entry (${s.entryPriceBasis.toLowerCase()})`} value={s.entryPrice} />
              <Row label="Contracts" value={<span data-testid={`preview-${s.side}-contracts`}>{s.contracts}</span>} />
              <Row label="Quantity" value={s.quantity} />
              <Row label="Est. notional" value={`${s.estimatedNotionalUsdt} USDT`} />
              <Row label="Est. margin" value={`${s.estimatedMarginUsdt} USDT`} />
              <Row label="Est. entry fee" value={`${s.estimatedEntryFeeUsdt} USDT`} />
              <Row label={`Stop (${s.stopBasis.toLowerCase()})`} value={`${s.stopPrice} (${s.stopDistancePct}%)`} />
              <Row label="Loss to stop incl. fees" value={<span data-testid={`preview-${s.side}-loss`}>{s.lossToStopUsdt} USDT</span>} />
              <Row
                label={`${s.side === 'LONG' ? 'Long' : 'Short'} take profit`}
                value={<span data-testid={`preview-${s.side}-tp`}>{s.takeProfitMode === 'OFF' ? 'Off' : `${s.takeProfitMode === 'FIXED' ? 'Fixed' : 'Split'} · manages ${s.takeProfitManagesPct}%`}</span>}
              />
              {s.takeProfits.map((t, i) => (
                <Row key={t.id} label={`Target ${i + 1} (${t.closePct}% of TP, ${s.side === 'LONG' ? 'above' : 'below'} entry)`} value={<span data-testid={`preview-${s.side}-target`}>{`${t.price} · ${t.contracts} contracts`}</span>} />
              ))}
              {s.trailing && (
                <Row
                  label={`Trailing take profit pool (${s.trailing.managesPct}%)`}
                  value={
                    <span data-testid={`preview-${s.side}-trailing`}>{`${s.trailing.contracts} contracts · activates at ${s.trailing.activationPrice ?? '—'} · retracement ${s.trailing.distancePct}% · first trigger closes ${s.trailing.firstCloseContracts}${s.trailing.closePct ? ` (${s.trailing.closePct}%)` : ''}`}</span>
                  }
                />
              )}
              {s.trailing?.targetClose && (
                <Row label="Trailing target close (once)" value={<span data-testid={`preview-${s.side}-target-close`}>{`${s.trailing.targetClose.price} · ${s.trailing.targetClose.contracts} contracts (${s.trailing.targetClose.closePct}%)`}</span>} />
              )}
            </dl>
            {s.exitWarnings.length > 0 && (
              <ul className="mt-2 space-y-1 text-warn" data-testid={`preview-${s.side}-exit-warnings`}>
                {s.exitWarnings.map((w, i) => (
                  <li key={i}>
                    <span className="font-semibold">{w.exit}</span>: {w.message} It is reported and not sent at runtime (never turned into a full close).
                  </li>
                ))}
              </ul>
            )}
            {s.reasons.length > 0 && (
              <ul className="mt-2 space-y-1 text-loss">
                {s.reasons.map((r, i) => (
                  <li key={i}>
                    <span className="font-semibold">{r.code}</span>: {r.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
      {preview.exitPlan?.source === 'ADMIN' && <p className="text-xs text-muted">Exits from the admin Common Exit Definition version {preview.exitPlan.adminVersion}.</p>}
      {preview.partialExitProtection && !preview.partialExitProtection.verified && (
        <p className="text-xs text-warn" data-testid="preview-protection">
          Partial exits not verified as protected: {preview.partialExitProtection.limitation}
        </p>
      )}
      <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-subtle">
        {preview.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </section>
  );
}
