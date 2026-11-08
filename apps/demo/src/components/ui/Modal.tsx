import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useEscapeLayer } from '../../hooks/useEscapeLayer';
import { cn } from '../../utils/cn';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  size?: 'md' | 'lg';
  children: React.ReactNode;
}

/** Frame for dialogs and wizards. Children own their header, body and footer, and unmount on close. */
export function Modal({ open, onClose, labelledBy, size = 'md', children }: ModalProps) {
  useEscapeLayer(open, onClose);

  return (
    <AnimatePresence>
      {open &&
      <motion.div
        className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}>
        
          <motion.div
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelledBy}
          initial={{ opacity: 0, y: 12, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.98 }}
          transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
          className={cn(
            'flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-surface shadow-2xl shadow-black/60 sm:max-h-[calc(100dvh-2rem)] sm:rounded-2xl',
            size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-md'
          )}>
          
            {children}
          </motion.div>
        </motion.div>
      }
    </AnimatePresence>);

}