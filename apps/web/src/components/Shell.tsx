import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import type { Household } from '@/lib/dashboard';
import { SECTIONS, loose, type Section } from '@/lib/sections';
import { cn } from '@/lib/utils';
import { LocaleSwitcher } from './LocaleSwitcher';
import { ThemeToggle } from './ThemeToggle';
import { TenantSwitcher } from './TenantSwitcher';

export const NAV_KEY: Record<Section | 'brief', string> = {
  brief: 'brief', staff: 'staff', requests: 'requests', finance: 'finance', 'petty-cash': 'pettyCash', fleet: 'fleet', 'work-orders': 'workOrders',
};

/**
 * The app frame: a quiet sidebar (office, household, sections, language, theme) beside the page.
 * On a phone the sidebar sits above the page and the sections scroll sideways.
 */
export async function Shell({ current, households, household, mode, back, children }:
  { current: Section | 'brief' | null; households: Household[]; household: Household; mode: 'live' | 'sample'; back: string; children: ReactNode }) {
  const t = await getTranslations('ui');
  const items: Array<{ key: Section | 'brief'; href: string }> = [{ key: 'brief', href: '/' }, ...SECTIONS.map((s) => ({ key: s, href: `/${s}` }))];
  return (
    <div className="lg:flex lg:min-h-dvh">
      <aside className="flex flex-col gap-4 border-b bg-muted px-3 py-4 lg:sticky lg:top-0 lg:h-dvh lg:w-60 lg:shrink-0 lg:border-b-0 lg:border-e">
        <div className="flex items-center justify-between gap-3 px-2">
          <span className="text-xs text-muted-foreground">{t('office')}</span>
          {mode === 'sample' && <span className="text-xs text-warning">{t('sample')}</span>}
        </div>
        <TenantSwitcher households={households} current={household} back={back} />
        <nav aria-label={t('sections')}>
          <ul className="-mx-1 flex gap-0.5 overflow-x-auto px-1 lg:flex-col lg:overflow-visible">
            {items.map(({ key, href }) => (
              <li key={key} className="shrink-0">
                <Link href={href} aria-current={key === current ? 'page' : undefined}
                  className={cn('block rounded-md px-2.5 py-1.5 whitespace-nowrap hover:bg-selected', key === current && 'bg-selected font-semibold')}>
                  {loose(t)(`nav.${NAV_KEY[key]}`)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex flex-wrap items-center gap-2 px-2 lg:mt-auto">
          <LocaleSwitcher />
          <ThemeToggle />
        </div>
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
