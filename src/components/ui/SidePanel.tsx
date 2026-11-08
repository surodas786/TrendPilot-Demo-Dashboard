import React, { useId } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { XIcon } from 'lucide-react';
import { useEscapeLayer } from '../../hooks/useEscapeLayer';
import { cn } from '../../utils/cn';

interface SidePanelProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  footer?: React.ReactNode;
  escapeEnabled?: boolean;
  /** 'top' stacks above other side panels (e.g. position details opened from connection details). */
  level?: 'base' | 'top';
  widthClassName?: string;
  /** Override the scrolling body wrapper (e.g. when the child manages its own scroll and footer). */
  bodyClassName?: string;
  children: React.ReactNode;
}

export function SidePanel({
  open,
  onClose,
  title,
  subtitle,
  footer,
  escapeEnabled = true,
  level = 'base',
  widthClassName = 'sm:w-[440px]',
  bodyClassName = 'scrollbar-thin flex-1 overflow-y-auto px-5 py-4',
  children
}: SidePanelProps) {
  const titleId = useId();
  useEscapeLayer(open, onClose, escapeEnabled);

  return (
    <AnimatePresence>
      {open &&
      <>
          <motion.div
          className={cn('fixed inset-0 bg-black/55', level === 'top' ? 'z-[74]' : 'z-[60]')}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={onClose}
          aria-hidden />
        
          <motion.aside
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          initial={{ x: '100%' }}
          animate={{ x: 0 }}
          exit={{ x: '100%' }}
          transition={{ duration: 0.26, ease: [0.23, 1, 0.32, 1] }}
          className={cn(
            'fixed inset-y-0 right-0 flex h-[100dvh] w-full flex-col border-l border-line bg-surface shadow-2xl shadow-black/60',
            level === 'top' ? 'z-[75]' : 'z-[70]',
            widthClassName
          )}>
          
            <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
              <div className="min-w-0">
                <div id={titleId}>{title}</div>
                {subtitle && <div className="mt-1 text-sm text-subtle">{subtitle}</div>}
              </div>
              <button
              type="button"
              onClick={onClose}
              aria-label="Close panel"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line text-muted transition-colors duration-150 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
              
                <XIcon className="h-4 w-4" aria-hidden />
              </button>
            </header>
            <div className={bodyClassName}>{children}</div>
            {footer && <footer className="border-t border-line px-5 py-4">{footer}</footer>}
          </motion.aside>
        </>
      }
    </AnimatePresence>);

}