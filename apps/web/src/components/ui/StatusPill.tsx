'use client';

import React from 'react';
import { cn } from '@/lib/cn';
import { type LucideIcon } from 'lucide-react';
export type PillTone = 'accent' | 'gain' | 'loss' | 'warn' | 'neutral';
const toneClasses: Record<PillTone, string> = {
  accent: 'border-accent/35 bg-accent/10 text-accent',
  gain: 'border-gain/30 bg-gain/10 text-gain',
  loss: 'border-loss/35 bg-loss/10 text-loss',
  warn: 'border-warn/35 bg-warn/10 text-warn',
  neutral: 'border-line bg-inset text-muted'
};
interface StatusPillProps {
  tone: PillTone;
  icon?: LucideIcon;
  children: React.ReactNode;
  className?: string;
}
export function StatusPill({
  tone,
  icon: Icon,
  children,
  className
}: StatusPillProps) {
  return <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium', toneClasses[tone], className)}>
      {Icon && <Icon className="h-3 w-3" aria-hidden />}
      {children}
    </span>;
}