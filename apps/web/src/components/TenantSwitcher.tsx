import { getTranslations } from 'next-intl/server';
import type { Household } from '@/lib/dashboard';

/**
 * Household switcher in the header. Works without JS: a <details> list of form buttons (cookie
 * switch on the app host) or of links (each household on its own subdomain, efa.darhub.net).
 */
export async function TenantSwitcher({ households, current, back }: { households: Household[]; current: Household; back: string }) {
  const t = await getTranslations('ui.tenant');
  const row = 'flex w-full items-baseline justify-between gap-3 rounded-md px-3 py-2 text-start text-foreground hover:bg-muted';
  return (
    <details className="group relative">
      <summary className="flex h-10 cursor-pointer list-none items-center gap-2.5 rounded-md border border-header-line bg-[color-mix(in_srgb,var(--header)_85%,white)] px-3.5 text-sm [&::-webkit-details-marker]:hidden">
        <span className="text-xs text-header-muted">{t('label')}</span>
        <span className="font-medium">{current.name}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="transition group-open:rotate-180"><path d="m6 9 6 6 6-6" /></svg>
      </summary>
      <form action="/api/tenant" method="post" className="panel absolute end-0 z-30 mt-1.5 w-64 p-1.5 shadow-lg">
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
