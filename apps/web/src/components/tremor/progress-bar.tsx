import * as React from 'react';
import { cn } from '@/lib/utils';

/** Tremor Raw ProgressBar: fills from inline-start (RTL-safe). */
const fill = { navy: 'bg-primary', critical: 'bg-critical', warning: 'bg-warning', ok: 'bg-ok' };

export function ProgressBar({ value, max = 100, variant = 'navy', label, className }:
  { value: number; max?: number; variant?: keyof typeof fill; label?: string; className?: string }) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className={cn('flex w-full items-center gap-3', className)}>
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
        <div className={cn('h-full rounded-full', fill[variant])} style={{ width: `${pct}%` }} />
      </div>
      {label && <span className="shrink-0 text-sm tabular-nums text-muted-foreground">{label}</span>}
    </div>
  );
}
