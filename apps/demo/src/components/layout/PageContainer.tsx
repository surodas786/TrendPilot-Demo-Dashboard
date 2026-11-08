import React from 'react';

interface PageContainerProps {
  title: string;
  description: string;
  /** Short scope line, e.g. whose data the page shows. */
  scope?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

/** Shared page frame for the role-based pages. */
export function PageContainer({ title, description, scope, actions, children }: PageContainerProps) {
  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-5 px-4 py-5 lg:px-6 lg:py-6">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="max-w-2xl">
          <h2 className="text-xl font-bold tracking-tight text-ink">{title}</h2>
          <p className="mt-1 text-sm text-muted">{description}</p>
          {scope && <p className="mt-1.5 text-xs text-subtle">{scope}</p>}
        </div>
        {actions}
      </header>
      {children}
    </div>);

}