import { LockKeyhole } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Visual cue for a field stored encrypted at rest (AES-256-GCM, household key).
 * Shows only what the API exposes (last 4) and says it is encrypted.
 */
export function EncryptedField({ last4, label, hint, empty, always, className }:
  { last4?: string | null; label: string; hint: string; empty?: string; always?: boolean; className?: string }) {
  // Nothing stored: say so plainly (a lock would imply there is encrypted data).
  if (!last4 && !always) return <span className={cn('text-xs text-muted-foreground', className)}>{empty ?? '—'}</span>;
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-gold/30 bg-gold-soft/60 px-2 py-0.5 text-xs', className)} title={hint}>
      <LockKeyhole className="size-3.5 shrink-0 text-gold-ink" aria-hidden="true" />
      <span className="tabular font-medium" dir="ltr">{last4 ? `•••• ${last4}` : empty ?? '—'}</span>
      <span className="sr-only">{label}: {hint}</span>
    </span>
  );
}
