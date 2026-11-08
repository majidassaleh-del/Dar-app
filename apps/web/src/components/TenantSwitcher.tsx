import { getTranslations } from 'next-intl/server';
import type { Household } from '@/lib/dashboard';

/**
 * Household switcher. Works without JS: a <details> list of form buttons (cookie switch on the
 * app host) or of links (each household on its own subdomain, efa.darhub.net).
 */
export async function TenantSwitcher({ households, current, back }: { households: Household[]; current: Household; back: string }) {
  const t = await getTranslations('ui.tenant');
  const row = 'flex w-full items-baseline justify-between gap-3 rounded-md px-2.5 py-2 text-start hover:bg-selected';
  return (
    <details className="group relative">
      <summary className="flex cursor-pointer list-none flex-col rounded-md border border-input bg-background px-2.5 py-1.5 [&::-webkit-details-marker]:hidden">
        <span className="text-xs text-muted-foreground">{t('label')}</span>
        <span className="font-semibold">{current.name}</span>
      </summary>
      <form action="/api/tenant" method="post" className="absolute inset-x-0 z-30 mt-1 rounded-md border bg-background p-1">
        <input type="hidden" name="back" value={back} />
        {households.map((h) => {
          const body = (<><span>{h.name}</span>{h.id === current.id && <span className="text-xs text-muted-foreground">{t('current')}</span>}</>);
          const cur = h.id === current.id ? 'true' as const : undefined;
          return h.origin
            ? <a key={h.id} href={`${h.origin}${back}`} aria-current={cur} className={row}>{body}</a>
            : <button key={h.id} type="submit" name="householdId" value={h.id} aria-current={cur} className={row}>{body}</button>;
        })}
      </form>
    </details>
  );
}
