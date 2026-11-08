import React from 'react';
import { cn } from '../../utils/cn';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => React.ReactNode;
  align?: 'left' | 'right';
  className?: string;
}

interface SimpleTableProps<T> {
  label: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty: string;
  onRowClick?: (row: T) => void;
}

/** Compact data table that scrolls inside its own container on narrow screens. */
export function SimpleTable<T>({ label, columns, rows, rowKey, empty, onRowClick }: SimpleTableProps<T>) {
  if (rows.length === 0) {
    return <p className="rounded-xl border border-dashed border-line-strong bg-surface px-4 py-10 text-center text-sm text-muted">{empty}</p>;
  }
  return (
    <div className="scrollbar-thin overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full min-w-[640px] text-sm" aria-label={label}>
        <thead>
          <tr className="border-b border-line text-left text-xs text-subtle">
            {columns.map((c) =>
            <th key={c.key} scope="col" className={cn('whitespace-nowrap px-3 py-2.5 font-medium', c.align === 'right' && 'text-right')}>
                {c.header}
              </th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) =>
          <tr
            key={rowKey(r)}
            onClick={onRowClick ? () => onRowClick(r) : undefined}
            onKeyDown={onRowClick ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onRowClick(r)) : undefined}
            tabIndex={onRowClick ? 0 : undefined}
            className={cn(onRowClick && 'cursor-pointer transition-colors duration-150 hover:bg-inset focus-visible:bg-inset focus-visible:outline-none')}>
            
              {columns.map((c) =>
            <td key={c.key} className={cn('whitespace-nowrap px-3 py-2.5 tabular-nums text-ink', c.align === 'right' && 'text-right', c.className)}>
                  {c.render(r)}
                </td>
            )}
            </tr>
          )}
        </tbody>
      </table>
    </div>);

}