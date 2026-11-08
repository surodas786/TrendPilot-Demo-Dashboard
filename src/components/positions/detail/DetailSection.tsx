import React from 'react';

export function DetailSection({ title, children, first }: {title: string;children: React.ReactNode;first?: boolean;}) {
  return (
    <section>
      <h3 className={first ? 'mb-3 text-xs font-semibold text-muted' : 'mb-3 border-t border-line pt-4 text-xs font-semibold text-muted'}>{title}</h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3">{children}</dl>
    </section>);

}

export const NOT_RECORDED = 'Not recorded in this demo';
export const UNAVAILABLE = 'Unavailable in this simulation';