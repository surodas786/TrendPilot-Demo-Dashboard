import React from 'react';

/** Standalone frame for sign-in and account-link screens (from the MagicPatterns AuthFrame). */
export function AuthFrame({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] w-full flex-col items-center bg-canvas px-4 py-10 text-ink">
      <div className="flex items-center gap-2.5">
        <img src="/TrendPilot_Logo-removebg-preview.png" alt="" aria-hidden className="h-9 w-9 shrink-0 object-contain" />
        <span className="text-xl font-bold tracking-tight">TrendPilot</span>
      </div>
      <p className="mt-3 rounded-full border border-line bg-inset px-3 py-1 text-[11px] font-medium text-muted">Paper settings only — live trading is disabled</p>
      <main className="mt-8 w-full max-w-md rounded-2xl border border-line bg-surface p-6 sm:p-8">
        <h1 className="text-lg font-semibold">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        {children}
      </main>
    </div>
  );
}
