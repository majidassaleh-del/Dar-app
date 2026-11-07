import { getTranslations } from 'next-intl/server';
import { Check, ChevronDown } from 'lucide-react';
import type { Household } from '@/lib/dashboard';
import { cn } from '@/lib/utils';

const toneClass: Record<Household['tone'], string> = {
  emerald: 'bg-emerald-royal text-[#e2e8f0] ring-[#d97706]/60',
  gold: 'bg-gradient-to-br from-[#f59e0b] to-[#b45309] text-[#022c22] ring-[#fde68a]/60',
  platinum: 'bg-gradient-to-br from-[#e2e8f0] to-[#94a3b8] text-[#022c22] ring-white/60',
};

export function HouseholdBadge({ h, size = 'md' }: { h: Household; size?: 'sm' | 'md' }) {
  return (
    <span aria-hidden="true" className={cn('grid shrink-0 place-items-center rounded-lg font-display font-bold tracking-wider ring-1 ring-inset',
      size === 'md' ? 'size-9 text-[11px]' : 'size-7 text-[10px]', toneClass[h.tone])}>{h.badge}</span>
  );
}

/** Household switcher (EFA Private Office · AFA Household …). Works without JS: a <details> menu of form buttons. */
export async function TenantSwitcher({ households, current, back }: { households: Household[]; current: Household; back: string }) {
  const t = await getTranslations('lux.tenant');
  return (
    <details className="group relative">
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-2.5 py-1.5 text-header-foreground transition hover:bg-white/10 [&::-webkit-details-marker]:hidden"
        aria-label={t('switch')}>
        <HouseholdBadge h={current} />
        <span className="min-w-0 text-start">
          <span className="block text-[11px] text-header-muted">{t('label')}</span>
          <span className="block truncate font-display text-sm font-semibold">{current.name}</span>
        </span>
        <ChevronDown className="size-4 text-header-muted transition group-open:rotate-180" aria-hidden="true" />
      </summary>
      <form action="/api/tenant" method="post"
        className="absolute end-0 z-30 mt-2 w-72 overflow-hidden rounded-2xl border border-border bg-popover p-1.5 text-popover-foreground shadow-2xl">
        <input type="hidden" name="back" value={back} />
        <p className="px-3 pb-1 pt-2 text-xs text-muted-foreground">{t('switch')}</p>
        {households.map((h) => (
          <button key={h.id} type="submit" name="householdId" value={h.id} aria-current={h.id === current.id ? 'true' : undefined}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start transition hover:bg-muted">
            <HouseholdBadge h={h} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{h.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{h.role}</span>
            </span>
            {h.id === current.id && <Check className="size-4 text-gold" aria-label={t('current')} />}
          </button>
        ))}
      </form>
    </details>
  );
}
