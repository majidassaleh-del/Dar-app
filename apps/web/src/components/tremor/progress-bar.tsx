import * as React from 'react';
import { cn } from '@/lib/utils';

/** Tremor Raw ProgressBar: fills from inline-start (RTL-safe). */
/** Emerald → gold fill for the executive theme; severity variants for alerts. */
const fill = { navy: 'bg-gradient-to-r rtl:bg-gradient-to-l from-emerald-royal to-gold dark:from-emerald-400 dark:to-gold', gold: 'bg-gold', critical: 'bg-critical', warning: 'bg-warning', ok: 'bg-ok' };

export function ProgressBar({ value, max = 100, variant = 'navy', label, className }:
  { value: number; max?: number; variant?: keyof typeof fill; label?: string; className?: string }) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className={cn('flex w-full items-center gap-3', className)}>
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted ring-1 ring-inset ring-border" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
        <div className={cn('h-full rounded-full', fill[variant])} style={{ width: `${pct}%` }} />
      </div>
      {label && <span className="shrink-0 text-sm tabular-nums text-muted-foreground">{label}</span>}
    </div>
  );
}
