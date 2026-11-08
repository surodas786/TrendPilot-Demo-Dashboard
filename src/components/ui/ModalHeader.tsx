import React from 'react';
import { XIcon } from 'lucide-react';

interface ModalHeaderProps {
  id: string;
  title: string;
  description?: React.ReactNode;
  onClose: () => void;
  children?: React.ReactNode;
}

export function ModalHeader({ id, title, description, onClose, children }: ModalHeaderProps) {
  return (
    <header className="border-b border-line px-5 py-4 sm:px-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id={id} className="text-base font-semibold text-ink">
            {title}
          </h2>
          {description && <div className="mt-1 text-sm text-muted">{description}</div>}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line text-muted transition-colors duration-150 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
          
          <XIcon className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {children}
    </header>);

}