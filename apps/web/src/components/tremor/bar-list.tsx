import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Tremor Raw BarList (tremor.so/docs/visualizations/bar-list), Tailwind v4.
 * Bars grow from the reading start (inline-start), so it is correct in RTL.
 */
export interface BarListItem { name: string; value: number; href?: string; tone?: 'navy' | 'critical' | 'warning' | 'muted' }
const tones = { navy: 'bg-chart-1/15 dark:bg-chart-1/25', critical: 'bg-critical-soft', warning: 'bg-warning-soft', muted: 'bg-slate-100 dark:bg-slate-800' };

export function BarList({ data, valueFormatter = (v) => String(v), className, sortOrder = 'descending' }:
  { data: BarListItem[]; valueFormatter?: (v: number) => string; className?: string; sortOrder?: 'ascending' | 'descending' | 'none' }) {
  const rows = sortOrder === 'none' ? data : [...data].sort((a, b) => (sortOrder === 'ascending' ? a.value - b.value : b.value - a.value));
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className={cn('flex flex-col gap-1.5', className)}>
      {rows.map((r) => (
        <li key={r.name} className="flex items-center gap-4">
          <div className="relative flex h-8 flex-1 items-center">
            <div className={cn('absolute inset-y-0 start-0 rounded-sm', tones[r.tone ?? 'navy'])} style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
            <span className="relative truncate ps-2 text-sm">{r.href ? <a href={r.href} className="hover:underline">{r.name}</a> : r.name}</span>
          </div>
          <span className="shrink-0 text-sm font-medium tabular-nums">{valueFormatter(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}
