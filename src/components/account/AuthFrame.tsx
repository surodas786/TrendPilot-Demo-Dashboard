import React from 'react';

/** Standalone TrendPilot frame for the simulated setup and reset screens. */
export function AuthFrame({ children }: {children: React.ReactNode;}) {
  return (
    <div className="flex min-h-[100dvh] w-full flex-col items-center bg-canvas px-4 py-10 text-ink">
      <div className="flex items-center gap-2.5">
        <img src="/TrendPilot_Logo-removebg-preview.png" alt="" aria-hidden className="h-9 w-9 shrink-0 object-contain" />
        <span className="text-xl font-bold tracking-tight">TrendPilot</span>
      </div>
      <p className="mt-3 rounded-full border border-line bg-inset px-3 py-1 text-[11px] font-medium text-muted">Demo simulation — not real account access</p>
      <main className="mt-8 w-full max-w-md rounded-2xl border border-line bg-surface p-6 sm:p-8">{children}</main>
    </div>);

}