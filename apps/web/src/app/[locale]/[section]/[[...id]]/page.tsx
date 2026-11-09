import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Locale } from '@herp/i18n';
import { Shell } from '@/components/Shell';
import { FinanceSection } from '@/components/sections/Finance';
import { FleetSection } from '@/components/sections/Fleet';
import { PettyCashSection } from '@/components/sections/PettyCash';
import { RequestsSection } from '@/components/sections/Requests';
import { StaffSection } from '@/components/sections/Staff';
import { WorkOrdersSection } from '@/components/sections/WorkOrders';
import { loadSession } from '@/lib/dashboard';
import { isSection } from '@/lib/sections';

export const dynamic = 'force-dynamic';

const RENDER = {
  staff: StaffSection, requests: RequestsSection, finance: FinanceSection,
  'petty-cash': PettyCashSection, fleet: FleetSection, 'work-orders': WorkOrdersSection,
} as const;

/** /[locale]/[section] (list, first record beside it) and /[locale]/[section]/[id] (that record). */
export default async function SectionPage({ params, searchParams }:
  { params: Promise<{ locale: Locale; section: string; id?: string[] }>; searchParams: Promise<{ tab?: string }> }) {
  const { locale, section, id } = await params;
  if (!isSection(section) || (id && id.length > 1)) notFound();
  setRequestLocale(locale);
  const [{ tab }, session, t] = await Promise.all([searchParams, loadSession(locale), getTranslations('ui')]);
  const selected = id?.[0] ?? null;
  if (selected && !/^[0-9a-f-]{36}$/.test(selected)) notFound();
  const Render = RENDER[section];
  return (
    <Shell current={section} households={session.households} household={session.current} mode={session.mode} pendingRequests={session.pendingRequests}
      back={`/${locale}/${section}${selected ? `/${selected}` : ''}`}>
      {session.opts
        ? <Render opts={session.opts} id={selected} tab={tab ?? null} />
        : <div className="mx-auto max-w-[1280px] px-4 py-8 sm:px-8"><h1 className="text-3xl">{t(`nav.${section === 'petty-cash' ? 'pettyCash' : section === 'work-orders' ? 'workOrders' : section}`)}</h1>
            <p className="mt-2 text-muted-foreground">{t('signedOut')}</p></div>}
    </Shell>
  );
}
