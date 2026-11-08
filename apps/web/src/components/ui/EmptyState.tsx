'use client';

import React from 'react';
import { type LucideIcon } from 'lucide-react';
interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  body: string;
  children?: React.ReactNode;
}
export function EmptyState({
  icon: Icon,
  title,
  body,
  children
}: EmptyStateProps) {
  return <section className="flex flex-col items-center rounded-xl border border-dashed border-line-strong bg-surface px-6 py-14 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-lg border border-accent/40 bg-accent/10 text-accent">
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <h3 className="mt-4 text-base font-semibold text-ink">{title}</h3>
      <p className="mt-1 max-w-md text-sm text-muted">{body}</p>
      {children && <div className="mt-5">{children}</div>}
    </section>;
}