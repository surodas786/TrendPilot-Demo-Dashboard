import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useDemo } from './DemoContext';
import { usePlatform } from './PlatformContext';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';

interface DemoGuideValue {
  /** Opens the confirmation; on confirm restores the documented demo data. */
  requestReset: () => void;
}

const Ctx = createContext<DemoGuideValue | null>(null);

/** Hosts the shared "Reset demo" confirmation used by the account menu. */
export function DemoGuideProvider({ children }: {children: React.ReactNode;}) {
  const { resetDemo } = useDemo();
  const { resetPlatform } = usePlatform();
  const [resetOpen, setResetOpen] = useState(false);

  const doReset = useCallback(() => {
    resetDemo();
    resetPlatform();
    setResetOpen(false);
    toast('Demo reset', { description: 'Original demo users, settings and records restored.' });
  }, [resetDemo, resetPlatform]);

  const value = useMemo<DemoGuideValue>(() => ({ requestReset: () => setResetOpen(true) }), []);

  return (
    <Ctx.Provider value={value}>
      {children}
      <ConfirmDialog
        open={resetOpen}
        title="Reset the whole demo?"
        description="Restores the original demo users, settings, signals and holdings. Changes made in this session are discarded."
        confirmLabel="Reset demo"
        tone="danger"
        onConfirm={doReset}
        onCancel={() => setResetOpen(false)} />
      
    </Ctx.Provider>);

}

export function useDemoGuide(): DemoGuideValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDemoGuide must be used inside DemoGuideProvider');
  return v;
}