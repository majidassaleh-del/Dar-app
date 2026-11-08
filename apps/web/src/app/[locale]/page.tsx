import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Locale } from '@herp/i18n';
import { Link } from '@/i18n/navigation';
import { Shell } from '@/components/Shell';
import { SettlementStatement } from '@/components/SettlementStatement';
import { loadDashboard } from '@/lib/dashboard';
import { fmt } from '@/lib/fmt';
import { label, loose, sectionForDeepLink, today } from '@/lib/sections';

export const dynamic = 'force-dynamic';

/** The daily brief: what needs a decision, what is coming up, and what the household owes, read as a short letter. */
export default async function Brief({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [t, tp0, tf0, d, f] = await Promise.all([getTranslations('ui'), getTranslations('pulse'), getTranslations('lux.fleet'), loadDashboard(locale), fmt()]);
  const tp = loose(tp0), tf = loose(tf0);
  const by = (s: string) => d.staff.filter((x) => x.status === s).length;
  const decisions = d.attention.filter((a) => a.severity !== 'info');
  const notes = d.attention.filter((a) => a.severity === 'info');
  const workers = d.staff.map((s) => ({ id: s.id, name: s.name }));
  const now = today();

  return (
    <Shell current="brief" households={d.households} household={d.current} mode={d.mode} back={`/${locale}`}>
      <article className="mx-auto grid max-w-[760px] gap-8 px-5 py-8 text-lg leading-relaxed sm:px-8">
        <header>
          <p className="text-sm text-muted-foreground">{f.date(now, 'long')} · {f.hijri(now)}</p>
          <h1 className="text-xl font-semibold">{t('brief.title')}</h1>
        </header>

        <p>
          {t('brief.workforce', { count: d.staff.length, active: by('ACTIVE'), probation: by('ON_PROBATION'), onLeave: by('ON_LEAVE') })}{' '}
          {t('brief.decisions', { count: decisions.length })}
        </p>

        {decisions.length > 0 && (
          <section aria-labelledby="b-decide">
            <h2 id="b-decide" className="mb-1 font-semibold">{t('brief.decideTitle')}</h2>
            <ol className="grid list-decimal gap-2 ps-6">
              {decisions.map((a) => {
                const s = sectionForDeepLink(a.deepLink);
                return (
                  <li key={a.key}>
                    <span className={a.severity === 'critical' ? 'font-semibold' : undefined}>{tp(a.key, { count: a.count })}</span>
                    {s && <> · <Link href={`/${s}`} className="link">{t('open')}</Link></>}
                  </li>
                );
              })}
            </ol>
            {notes.length > 0 && (
              <p className="mt-3 text-sm text-muted-foreground">{t('brief.alsoNote')} {notes.map((a) => tp(a.key, { count: a.count })).join(' · ')}</p>
            )}
          </section>
        )}

        <section aria-labelledby="b-fleet">
          <h2 id="b-fleet" className="mb-1 font-semibold">{t('nav.fleet')}</h2>
          {d.vehicles.length === 0 ? <p className="text-muted-foreground">{t('empty.fleet')}</p> : d.vehicles.map((v) => {
            const soon = [...v.docs].sort((a, b) => a.daysLeft - b.daysLeft)[0];
            const service = v.maintenance.find((m) => m.status === 'OVERDUE' || m.status === 'DUE_SOON');
            const lower = (x: string) => (locale === 'en' || locale === 'tl' ? x.toLowerCase() : x);
            const parts = [
              soon && soon.daysLeft <= 30 ? t('brief.docDue', { doc: tf(`doc.${soon.doc}`), days: soon.daysLeft }) : null,
              service ? (service.kmLeft != null ? t('brief.serviceDueKm', { item: lower(label(t, 'maintenance', service.type)), km: service.kmLeft }) : t('brief.serviceDue', { item: lower(label(t, 'maintenance', service.type)) })) : null,
            ].filter(Boolean);
            return (
              <p key={v.id} className="mb-2">
                <Link href={`/fleet/${v.id}`} className="font-semibold hover:underline">{v.make} {v.model}</Link>{' '}
                <span className="text-muted-foreground" dir="ltr">({v.plateNumber})</span>:{' '}
                {parts.length ? `${parts.join(t('brief.and'))}.` : soon ? t('brief.vehicleOk', { doc: tf(`doc.${soon.doc}`), days: soon.daysLeft }) : t('brief.vehicleOkPlain')}
              </p>
            );
          })}
        </section>

        <section aria-labelledby="b-esb">
          <h2 id="b-esb" className="mb-1 font-semibold">{t('brief.esbTitle')}</h2>
          <p className="mb-3">{t('brief.esb', { provision: f.money(d.esb.totalProvision), vested: f.money(d.esb.totalVested), count: d.esb.workers })}</p>
          <div className="rounded-md bg-muted px-5 py-4 text-base">
            <SettlementStatement workers={workers} defaultAsOf={now} variant="sentence" />
          </div>
        </section>

        <footer className="border-t pt-4 text-sm text-muted-foreground">
          {t('brief.protected')} <Link href="/staff" className="link">{t('brief.allStaff')}</Link>
        </footer>
      </article>
    </Shell>
  );
}
