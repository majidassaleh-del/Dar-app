import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { LocaleSwitcher } from './LocaleSwitcher';

const NAV = [
  { key: 'pulse', href: '/' }, { key: 'staff', href: '/' }, { key: 'finance', href: '/' }, { key: 'pettyCash', href: '/' },
  { key: 'fleet', href: '/' }, { key: 'workOrders', href: '/' }, { key: 'travel', href: '/' }, { key: 'policies', href: '/' },
] as const;

/** EFA Private Office shell: navy sidebar (brand, navigation, language), slate content area. */
export async function AppShell({ title, subtitle, current, children }: { title: string; subtitle?: ReactNode; current?: string; children: ReactNode }) {
  const t = await getTranslations();
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">EFA</span>
          <span>
            <span className="brand-name">{t('exec.brand')}</span><br />
            <span className="brand-sub">{t('exec.office')}</span>
          </span>
        </div>
        <nav aria-label="main">
          <ul className="nav">
            {NAV.map((n) => (
              <li key={n.key}><Link href={n.href} aria-current={n.key === current ? 'page' : undefined}>{t(`nav.${n.key}`)}</Link></li>
            ))}
          </ul>
        </nav>
        <div className="sidebar-foot"><LocaleSwitcher /></div>
      </aside>
      <div className="content">
        <header className="topbar">
          <h1>{title}</h1>
          {subtitle && <div className="dates muted">{subtitle}</div>}
        </header>
        <main className="page">{children}</main>
      </div>
    </div>
  );
}
