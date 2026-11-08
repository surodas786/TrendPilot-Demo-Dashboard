'use client';

import React, { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { XIcon } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import type { ShellRole } from './navigation';

/** Layout carried over from the MagicPatterns demo AppShell, without demo contexts. */
export function AppShell({ role, name, children }: { role: ShellRole; name: string; children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => setDrawerOpen(false), [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-canvas text-ink">
      <aside className="hidden w-60 shrink-0 border-r border-line bg-surface lg:flex">
        <Sidebar role={role} name={name} />
      </aside>

      <AnimatePresence>
        {drawerOpen && (
          <>
            <motion.div
              className="fixed inset-0 z-[55] bg-black/55 lg:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setDrawerOpen(false)}
              aria-hidden
            />
            <motion.aside
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ duration: 0.26, ease: [0.23, 1, 0.32, 1] }}
              className="fixed inset-y-0 left-0 z-[56] flex w-72 max-w-[85vw] border-r border-line bg-surface lg:hidden"
            >
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close navigation"
                className="absolute right-3 top-4 flex h-8 w-8 items-center justify-center rounded-lg border border-line text-muted hover:text-ink"
              >
                <XIcon className="h-4 w-4" aria-hidden />
              </button>
              <Sidebar role={role} name={name} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar role={role} name={name} onOpenMenu={() => setDrawerOpen(true)} />
        <main className="scrollbar-thin flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
