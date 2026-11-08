import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '../../utils/cn';

interface PopoverProps {
  triggerLabel: string;
  triggerContent: React.ReactNode;
  triggerClassName?: string;
  align?: 'left' | 'right';
  panelClassName?: string;
  onOpenChange?: (open: boolean) => void;
  children: (close: () => void) => React.ReactNode;
}

export function Popover({
  triggerLabel,
  triggerContent,
  triggerClassName,
  align = 'right',
  panelClassName,
  onOpenChange,
  children
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const update = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) update(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') update(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={triggerLabel}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => update(!open)}
        className={cn(
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
          triggerClassName
        )}>
        
        {triggerContent}
      </button>
      <AnimatePresence>
        {open &&
        <motion.div
          initial={{ opacity: 0, y: -4, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -4, scale: 0.98 }}
          transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
          className={cn(
            'absolute top-full z-50 mt-2 max-w-[calc(100vw-1.5rem)] rounded-xl border border-line bg-surface p-1.5 shadow-2xl shadow-black/50',
            align === 'right' ? 'right-0 origin-top-right' : 'left-0 origin-top-left',
            panelClassName
          )}>
          
            {children(() => update(false))}
          </motion.div>
        }
      </AnimatePresence>
    </div>);

}