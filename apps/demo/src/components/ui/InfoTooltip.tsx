import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { InfoIcon } from 'lucide-react';

interface InfoTooltipProps {
  content: React.ReactNode;
  label?: string;
}

const WIDTH = 264;

export function InfoTooltip({ content, label = 'More information' }: InfoTooltipProps) {
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0, above: true });

  const show = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - WIDTH / 2, window.innerWidth - WIDTH - 8));
    const above = rect.top > 140;
    setPos({ left, top: above ? rect.top - 8 : rect.bottom + 8, above });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const hide = () => setOpen(false);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={() => setOpen(false)}
        onFocus={show}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.stopPropagation();
          if (open) setOpen(false);else
          show();
        }}
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-subtle transition-colors duration-150 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
        
        <InfoIcon className="h-3.5 w-3.5" aria-hidden />
      </button>
      {createPortal(
        <AnimatePresence>
          {open &&
          <div
            style={{
              position: 'fixed',
              left: pos.left,
              top: pos.top,
              width: WIDTH,
              transform: pos.above ? 'translateY(-100%)' : undefined,
              zIndex: 100,
              pointerEvents: 'none'
            }}>
            
              <motion.div
              id={id}
              role="tooltip"
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.14, ease: [0.23, 1, 0.32, 1] }}
              className="rounded-lg border border-line-strong bg-raised px-3 py-2 text-xs font-normal normal-case leading-relaxed tracking-normal text-ink shadow-xl shadow-black/50">
              
                {content}
              </motion.div>
            </div>
          }
        </AnimatePresence>,
        document.body
      )}
    </>);

}