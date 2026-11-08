import React, { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { XIcon } from 'lucide-react';
import { useDemo } from '../../contexts/DemoContext';
import { PositionDetailPanel } from '../positions/detail/PositionDetailPanel';
import { DemoGuideProvider } from '../../contexts/DemoGuideContext';
import { Sidebar } from './Sidebar';
import { SubscriberAccessGate } from './SubscriberAccessGate';
import { TopBar } from './TopBar';

export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { pathname } = useLocation();
  const { state, selectPosition, accounts } = useDemo();
  // Ownership check: in Subscriber mode a position opens only if it belongs to the signed-in investor.
  const selected = state.selectedPositionId;
  const ownedPositionId =
  selected && state.role !== 'admin' ?
  (() => {
    const rec = state.positions.find((p) => p.id === selected) ?? state.tradeRecords.find((t) => t.positionId === selected || t.id === selected);
    return rec && accounts.some((a) => a.id === rec.accountId) ? selected : null;
  })() :
  selected;

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  return (
    <DemoGuideProvider>
    <div className="flex h-[100dvh] w-full overflow-hidden bg-canvas text-ink">
      <aside className="hidden w-60 shrink-0 border-r border-line bg-surface lg:flex">
        <Sidebar />
      </aside>

      <AnimatePresence>
        {drawerOpen &&
          <>
            <motion.div
              className="fixed inset-0 z-[55] bg-black/55 lg:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setDrawerOpen(false)}
              aria-hidden />
            
            <motion.aside
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ duration: 0.26, ease: [0.23, 1, 0.32, 1] }}
              className="fixed inset-y-0 left-0 z-[56] flex w-72 max-w-[85vw] border-r border-line bg-surface lg:hidden">
              
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close navigation"
                className="absolute right-3 top-4 flex h-8 w-8 items-center justify-center rounded-lg border border-line text-muted hover:text-ink">
                
                <XIcon className="h-4 w-4" aria-hidden />
              </button>
              <Sidebar showExchange />
            </motion.aside>
          </>
          }
      </AnimatePresence>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onOpenMenu={() => setDrawerOpen(true)} />
        <main className="scrollbar-thin flex-1 overflow-y-auto">
          <SubscriberAccessGate>
            <Outlet />
          </SubscriberAccessGate>
        </main>
      </div>
      <PositionDetailPanel positionId={ownedPositionId} onClose={() => selectPosition(null)} />
    </div>
    </DemoGuideProvider>);

}