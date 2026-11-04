import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { Activity, Car, FileText, Plane, Receipt, Users, Wallet, Wrench } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';
import { LocaleSwitcher } from './LocaleSwitcher';
import { ThemeToggle } from './ThemeToggle';

const NAV = [
  { key: 'pulse', href: '/', Icon: Activity }, { key: 'staff', href: '/', Icon: Users }, { key: 'finance', href: '/', Icon: Wallet },
  { key: 'pettyCash', href: '/', Icon: Receipt }, { key: 'fleet', href: '/', Icon: Car }, { key: 'workOrders', href: '/', Icon: Wrench },
  { key: 'travel', href: '/', Icon: Plane }, { key: 'policies', href: '/', Icon: FileText },
] as const;

/** EFA Private Office shell: navy sidebar (brand, navigation, language, theme) + slate content area. RTL-safe (logical utilities). */
export async function AppShell({ title, subtitle, current, children }: { title: string; subtitle?: ReactNode; current?: string; children: ReactNode }) {
  const t = await getTranslations();
  return (
    <div className="grid min-h-dvh grid-cols-[minmax(0,1fr)] lg:grid-cols-[16rem_minmax(0,1fr)]">
      <aside className="flex min-w-0 flex-col gap-5 bg-sidebar px-4 py-4 text-sidebar-foreground lg:sticky lg:top-0 lg:h-dvh lg:gap-6 lg:py-6">
        <div className="flex items-center gap-3 px-1">
          <span aria-hidden="true" className="grid size-9 place-items-center rounded-md border border-sidebar-border bg-sidebar-accent text-[11px] font-semibold tracking-wider">EFA</span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">{t('exec.brand')}</span>
            <span className="block truncate text-xs text-sidebar-muted">{t('exec.office')}</span>
          </span>
        </div>
        <nav aria-label="main" className="-mx-1 overflow-x-auto lg:mx-0 lg:overflow-visible">
          <ul className="flex gap-1 px-1 lg:flex-col lg:px-0">
            {NAV.map(({ key, href, Icon }) => (
              <li key={key}>
                <Link href={href} aria-current={key === current ? 'page' : undefined}
                  className={cn('flex items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-sm text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground',
                    key === current && 'bg-sidebar-accent font-medium text-sidebar-foreground')}>
                  <Icon className="size-4 shrink-0" aria-hidden="true" />{t(`nav.${key}`)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex items-end justify-between gap-3 lg:mt-auto lg:flex-col lg:items-stretch">
          <div className="min-w-0 flex-1 lg:flex-none"><LocaleSwitcher /></div>
          <ThemeToggle />
        </div>
      </aside>
      <div className="min-w-0">
        <header className="border-b border-slate-200 bg-card px-4 py-5 sm:px-8 dark:border-slate-800">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
        </header>
        <main className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-6 px-4 py-6 sm:px-8">{children}</main>
      </div>
    </div>
  );
}
