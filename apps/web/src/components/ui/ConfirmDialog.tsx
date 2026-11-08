'use client';

import React, { useEffect, useId, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/cn';
import { useEscapeLayer } from '@/lib/useEscapeLayer';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'danger' | 'default';
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'default',
  onConfirm,
  onCancel,
  children
}: ConfirmDialogProps) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEscapeLayer(open, onCancel);

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  return (
    <AnimatePresence>
      {open &&
      <motion.div
        className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onCancel();
        }}>
        
          <motion.div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={titleId}
          initial={{ opacity: 0, scale: 0.96, y: 6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 6 }}
          transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
          className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-line bg-surface p-5 shadow-2xl shadow-black/60 sm:p-6">
          
            <h2 id={titleId} className="text-base font-semibold text-ink">
              {title}
            </h2>
            <div className="mt-2 text-sm leading-relaxed text-muted">{description}</div>
            {children && <div className="mt-4">{children}</div>}
            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
              ref={cancelRef}
              type="button"
              onClick={onCancel}
              className="h-10 rounded-lg border border-line bg-inset px-4 text-sm font-medium text-ink transition-colors duration-150 hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
              
                {cancelLabel}
              </button>
              <button
              type="button"
              onClick={onConfirm}
              className={cn(
                'h-10 rounded-lg px-4 text-sm font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2',
                tone === 'danger' ?
                'border border-loss/50 bg-loss/15 text-loss hover:bg-loss/25 focus-visible:ring-loss/60' :
                'bg-accent text-accent-ink hover:bg-accent/90 focus-visible:ring-accent/60'
              )}>
              
                {confirmLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      }
    </AnimatePresence>);

}