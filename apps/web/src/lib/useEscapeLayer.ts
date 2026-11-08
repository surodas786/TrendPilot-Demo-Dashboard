'use client';

import { useEffect, useId, useRef } from 'react';

const stack: string[] = [];

/**
 * Registers an overlay layer (panel, modal, dialog). Escape closes only the topmost
 * open layer, so nested dialogs never close their parents at the same time.
 */
export function useEscapeLayer(open: boolean, onEscape: () => void, enabled = true) {
  const id = useId();
  const callback = useRef(onEscape);
  const enabledRef = useRef(enabled);
  callback.current = onEscape;
  enabledRef.current = enabled;

  useEffect(() => {
    if (!open) return;
    stack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || stack[stack.length - 1] !== id) return;
      if (enabledRef.current) callback.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const index = stack.lastIndexOf(id);
      if (index >= 0) stack.splice(index, 1);
    };
  }, [open, id]);
}