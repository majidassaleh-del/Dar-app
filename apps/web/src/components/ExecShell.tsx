import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { Activity, Car, FileText, Plane, Receipt, Users, Wallet, Wrench, Radio, FlaskConical } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import type { Household } from '@/lib/dashboard';
import { cn } from '@/lib/utils';
import { LocaleSwitcher } from './LocaleSwitcher';
import { ThemeToggle } from './ThemeToggle';
import { TenantSwitcher } from './TenantSwitcher';

const NAV = [
  { key: 'pulse', Icon: Activity }, { key: 'staff', Icon: Users }, { key: 'finance', Icon: Wallet }, { key: 'pettyCash', Icon: Receipt },
  { key: 'fleet', Icon: Car }, { key: 'workOrders', Icon: Wrench }, { key: 'travel', Icon: Plane }, { key: 'policies', Icon: FileText },
] as const;

/** EFA Private Office shell: emerald glass header (brand, tenant switcher, data mode, language, theme) and navigation pills. */
export async function ExecShell({ title, subtitle, current, households, household, mode, back, children }:
  { title: string; subtitle?: ReactNode; current?: string; households: Household[]; household: Household; mode: 'live' | 'sample'; back: string; children: ReactNode }) {
  const t = await getTranslations();
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-header text-header-foreground backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 sm:px-8">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="grid size-10 place-items-center rounded-xl border border-[#d97706]/70 bg-gradient-to-br from-[#064e3b] to-[#022c22] font-display text-[11px] font-bold tracking-[0.18em] text-[#fbbf24] shadow-inner">EFA</span>
            <span className="leading-tight">
              <span className="block font-display text-[15px] font-bold">{t('exec.brand')}</span>
              <span className="block text-xs text-header-muted">{t('exec.office')}</span>
            </span>
          </div>
          <div className="order-last flex w-full items-center gap-2 sm:order-none sm:ms-6 sm:w-auto">
            <TenantSwitcher households={households} current={household} back={back} />
          </div>
          <div className="ms-auto flex items-center gap-2">
            <span className={cn('hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium md:inline-flex',
              mode === 'live' ? 'bg-emerald-400/15 text-emerald-200' : 'bg-[#d97706]/20 text-[#fde68a]')}>
              {mode === 'live' ? <Radio className="size-3" aria-hidden="true" /> : <FlaskConical className="size-3" aria-hidden="true" />}
              {t(`lux.mode.${mode}`)}
            </span>
            <LocaleSwitcher />
            <ThemeToggle />
          </div>
        </div>
        <nav aria-label="main" className="mx-auto max-w-7xl overflow-x-auto px-4 pb-2 sm:px-8">
          <ul className="flex gap-1">
            {NAV.map(({ key, Icon }) => (
              <li key={key}>
                <Link href="/" aria-current={key === current ? 'page' : undefined}
                  className={cn('flex items-center gap-2 whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm text-header-muted transition hover:bg-white/10 hover:text-header-foreground',
                    key === current && 'bg-white/10 font-medium text-header-foreground ring-1 ring-inset ring-[#d97706]/50')}>
                  <Icon className="size-4 shrink-0" aria-hidden="true" />{t(`nav.${key}`)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-6 px-4 py-6 sm:px-8">
        <div className="sm:flex sm:items-end sm:justify-between sm:gap-4">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {mode === 'sample' && (
          <p className="glass flex items-center gap-2 px-4 py-2.5 text-sm text-gold-ink md:hidden"><FlaskConical className="size-4" aria-hidden="true" />{t('lux.mode.sample')}</p>
        )}
        {children}
      </main>
    </div>
  );
}
