import React, { useState } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from './Button';

/** Copies text to the clipboard, with a textarea fallback for restricted frames. */
export function CopyButton({ text, label = 'Copy', size = 'sm' }: {text: string;label?: string;size?: 'sm' | 'md';}) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);else
      throw new Error('no clipboard');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) {
        toast.error('Copy failed', { description: 'Select the text and copy it manually.' });
        return;
      }
    }
    setDone(true);
    toast.success('Copied to clipboard');
    window.setTimeout(() => setDone(false), 1500);
  };
  return (
    <Button size={size} icon={done ? CheckIcon : CopyIcon} onClick={copy}>
      {done ? 'Copied' : label}
    </Button>);

}