import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import type { Household } from '@/lib/dashboard';
import { fmt } from '@/lib/fmt';
import { SECTIONS, loose, today, type Section } from '@/lib/sections';
import { cn } from '@/lib/utils';
import { signOut } from '@/lib/auth-actions';
import { LocaleSwitcher } from './LocaleSwitcher';
import { ThemeToggle } from './ThemeToggle';
import { TenantSwitcher } from './TenantSwitcher';

export const NAV_KEY: Record<Section | 'brief', string> = {
  brief: 'brief', staff: 'staff', payroll: 'payroll', requests: 'requests', finance: 'finance', 'petty-cash': 'pettyCash', fleet: 'fleet', 'work-orders': 'workOrders',
};

/**
 * The app frame: the official green band (seal, office, dates, household, language, theme)
 * with the section tabs under it; the page sits below on the paper ground.
 */
export async function Shell({ current, households, household, mode, back, pendingRequests = 0, children }:
  { current: Section | 'brief' | null; households: Household[]; household: Household; mode: 'live' | 'sample'; back: string; pendingRequests?: number; children: ReactNode }) {
  const [t, f] = await Promise.all([getTranslations('ui'), fmt()]);
  const items: Array<{ key: Section | 'brief'; href: string }> = [{ key: 'brief', href: '/' }, ...SECTIONS.map((s) => ({ key: s, href: `/${s}` }))];
  const now = today();
  return (
    <div className="min-h-dvh">
      <header className="bg-header text-header-foreground">
        <div className="mx-auto flex max-w-[1280px] flex-col gap-3 px-4 pt-4 sm:px-8">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
            <Link href="/" className="flex items-center gap-3.5">
              <span aria-hidden="true" className="grid size-12 place-items-center rounded-full border-[1.5px] border-brass outline outline-1 outline-offset-[3px] outline-brass">
                <span className="font-display text-[15px] tracking-[0.06em] text-[#e6cf9c]">{household.badge}</span>
              </span>
              <span className="leading-tight">
                <span className="block font-display text-xl">{household.name}</span>
                <span className="block text-xs text-header-muted">{t('officeTagline')}</span>
              </span>
            </Link>
            <div className="flex flex-wrap items-center gap-3">
              <span className="hidden text-end text-xs leading-normal text-header-muted md:block">{f.weekday(now)}<br />{f.hijri(now)}</span>
              <TenantSwitcher households={households} current={household} back={back} />
              <LocaleSwitcher />
              <ThemeToggle />
              {mode === 'live' && household.owner && <Link href="/invitations" className="field-header inline-flex items-center px-3">{t('invite.nav')}</Link>}
              {mode === 'live' && (
                <form action={signOut}>
                  <input type="hidden" name="locale" value={f.locale} />
                  <button type="submit" className="field-header cursor-pointer px-3">{t('auth.signOut')}</button>
                </form>
              )}
            </div>
          </div>
          <nav aria-label={t('sections')} className="-mx-1 overflow-x-auto">
            <ul className="flex gap-1 px-1">
              {items.map(({ key, href }) => (
                <li key={key} className="shrink-0">
                  <Link href={href} aria-current={key === current ? 'page' : undefined}
                    className={cn('flex items-center gap-2 whitespace-nowrap border-b-[3px] px-3.5 py-2.5 text-[15px]',
                      key === current ? 'border-brass font-semibold text-white' : 'border-transparent text-header-muted hover:text-header-foreground')}>
                    {loose(t)(`nav.${NAV_KEY[key]}`)}
                    {key === 'requests' && pendingRequests > 0 && (
                      <span className="rounded-full bg-brass px-2 text-xs font-bold text-header tabular">{f.num(pendingRequests)}</span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
      {mode === 'sample' && <p className="bg-brass/20 px-4 py-1.5 text-center text-xs text-brass-ink">{t('sampleBanner')}</p>}
      <main>{children}</main>
    </div>
  );
}
