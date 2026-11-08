import React from 'react';
import { Link } from 'react-router-dom';
import { LockIcon } from 'lucide-react';
import { useDemo } from '../../contexts/DemoContext';
import { Button } from '../ui/Button';
import type { PreviewRole } from '../../types/trading';

const ROLE_NAME: Record<PreviewRole, string> = { admin: 'Administrator', trader: 'Subscriber' };

/** Hides a page from the other demo role. Interface behavior only — not access enforcement. */
export function RoleGate({ role, children }: {role: PreviewRole;children: React.ReactNode;}) {
  const { state, setRole } = useDemo();
  if (state.role === role) return <>{children}</>;
  return (
    <div className="mx-auto w-full max-w-xl px-4 py-12 lg:px-6">
      <section className="rounded-xl border border-line bg-surface p-6 text-center">
        <LockIcon className="mx-auto h-6 w-6 text-subtle" aria-hidden />
        <h2 className="mt-3 text-base font-semibold text-ink">{ROLE_NAME[role]} page</h2>
        <p className="mt-1 text-sm text-muted">
          This page is part of the {ROLE_NAME[role]} workspace. You are using the {ROLE_NAME[state.role]} demo role.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Button variant="primary" onClick={() => setRole(role)}>
            Switch to {ROLE_NAME[role]}
          </Button>
          <Link to="/" className="inline-flex h-9 items-center rounded-lg border border-line bg-inset px-3.5 text-sm font-medium text-ink transition-colors duration-150 hover:border-line-strong">
            Back to dashboard
          </Link>
        </div>
      </section>
    </div>);

}