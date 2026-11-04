import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { localeMeta, type Locale } from '@herp/i18n';
import { AppShell } from '@/components/AppShell';

type PulseKey = 'medicalOverdue' | 'documentsExpired' | 'vehicleDocsDue' | 'approvalsWaiting' | 'fuelFlagged' | 'pettyCashToReview';

/**
 * EFA Daily Pulse. The data below has the exact shape of GET /v1/dashboard/pulse
 * (sample values; attention keys without the `pulse.` prefix); wiring the authenticated API client replaces `pulse`.
 */
type Severity = 'critical' | 'warning' | 'info';
const pulse = {
  generatedAt: '2026-11-04T06:00:00Z',
  attention: [
    { severity: 'critical' as Severity, key: 'medicalOverdue' as PulseKey, count: 2, deepLink: '/compliance/staff' },
    { severity: 'critical' as Severity, key: 'documentsExpired' as PulseKey, count: 1, deepLink: '/staff/documents/expiring' },
    { severity: 'warning' as Severity, key: 'vehicleDocsDue' as PulseKey, count: 1, deepLink: '/fleet/overview' },
    { severity: 'warning' as Severity, key: 'approvalsWaiting' as PulseKey, count: 3, deepLink: '/requests' },
    { severity: 'warning' as Severity, key: 'fuelFlagged' as PulseKey, count: 1, deepLink: '/fleet/overview' },
    { severity: 'info' as Severity, key: 'pettyCashToReview' as PulseKey, count: 4, deepLink: '/petty-cash' },
  ],
  payroll: { currentMonth: { period: '2026-11', daysUntilDue: 26, total: '18450.00' } },
  documents: { expiring: 3 }, medical: { needsAction: 2 }, workOrders: { open: 5 }, pettyCash: { pendingReview: 4, amount: '612.40' },
  fleet: { due: 2 }, budgets: { over: 1 }, esb: { totalProvision: '41380.00' },
};

export default async function DailyPulse({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const f = await getFormatter();
  const now = new Date(pulse.generatedAt);
  const hijri = new Intl.DateTimeFormat(`${localeMeta[locale].intlTag}-u-ca-islamic-umalqura`, { dateStyle: 'long', timeZone: 'Asia/Riyadh' }).format(now);
  const month = f.dateTime(new Date(`${pulse.payroll.currentMonth.period}-01T12:00:00Z`), { month: 'long', year: 'numeric' });
  const sar = (v: string) => f.number(Number(v), 'sar');
  const kpis: Array<{ label: string; value: string; note: string; tone?: Severity }> = [
    { label: t('exec.kpi.payroll'), value: sar(pulse.payroll.currentMonth.total), note: t('exec.kpi.payrollDue', { month, days: pulse.payroll.currentMonth.daysUntilDue }) },
    { label: t('exec.kpi.documents'), value: f.number(pulse.documents.expiring), note: t('exec.kpi.documentsDue', { count: pulse.documents.expiring }), tone: 'warning' },
    { label: t('exec.kpi.medical'), value: f.number(pulse.medical.needsAction), note: t('exec.kpi.medicalDue', { count: pulse.medical.needsAction }), tone: 'critical' },
    { label: t('exec.kpi.workOrders'), value: f.number(pulse.workOrders.open), note: t('exec.kpi.workOrdersOpen', { count: pulse.workOrders.open }) },
    { label: t('exec.kpi.pettyCash'), value: sar(pulse.pettyCash.amount), note: t('exec.kpi.pettyCashReview', { count: pulse.pettyCash.pendingReview }) },
    { label: t('exec.kpi.fleet'), value: f.number(pulse.fleet.due), note: t('exec.kpi.fleetDue', { count: pulse.fleet.due }), tone: pulse.fleet.due ? 'warning' : undefined },
    { label: t('exec.kpi.budgets'), value: f.number(pulse.budgets.over), note: t('exec.kpi.budgetsOver', { count: pulse.budgets.over }), tone: pulse.budgets.over ? 'warning' : undefined },
    { label: t('exec.kpi.esb'), value: sar(pulse.esb.totalProvision), note: '' },
  ];

  return (
    <AppShell current="pulse" title={t('pulse.title')}
      subtitle={<>{f.dateTime(now, { dateStyle: 'full', timeZone: 'Asia/Riyadh' })} · {hijri} · {t('exec.updated', { time: f.dateTime(now, { timeStyle: 'short', timeZone: 'Asia/Riyadh' }) })}</>}>
      <section className="panel" aria-labelledby="attention">
        <div className="panel-head"><h2 id="attention">{t('exec.attention')}</h2><span className="muted num">{f.number(pulse.attention.length)}</span></div>
        {pulse.attention.length === 0 ? <p className="panel-body muted">{t('exec.allClear')}</p> : (
          <ul className="attention">
            {pulse.attention.map((a) => (
              <li key={a.key}>
                <span className={`chip ${a.severity}`}>{t(`exec.severity.${a.severity}`)}</span>
                <span>{t(`pulse.${a.key}`, { count: a.count })}</span>
                <a className="go" href={a.deepLink}><span className="flip" aria-hidden="true">→</span></a>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="kpis" aria-label={t('pulse.title')}>
        {kpis.map((k) => (
          <article key={k.label} className={`panel kpi ${k.tone ?? ''}`}>
            <span className="kpi-label">{k.label}</span>
            <span className="kpi-value">{k.value}</span>
            {k.note && <span className="kpi-note">{k.note}</span>}
          </article>
        ))}
      </section>
    </AppShell>
  );
}
