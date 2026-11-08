'use client';

import React, { useState } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { Button } from '../ui/Button';

export function CopyButtonInline({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={copied ? CheckIcon : CopyIcon}
      className="mt-2"
      onClick={async () => {
        await navigator.clipboard?.writeText(value).catch(() => undefined);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}
