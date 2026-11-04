import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { getDirection, localeMeta, type Locale } from '@herp/i18n';
import { AppShell } from '@/components/AppShell';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { BarChart } from '@/components/tremor/bar-chart';
import { BarList } from '@/components/tremor/bar-list';
import { ProgressBar } from '@/components/tremor/progress-bar';
import { cn } from '@/lib/utils';

type Severity = 'critical' | 'warning' | 'info';
type PulseKey = 'medicalOverdue' | 'documentsExpired' | 'vehicleDocsDue' | 'approvalsWaiting' | 'fuelFlagged' | 'pettyCashToReview';

/**
 * EFA Daily Pulse on shadcn/ui + Tremor primitives. `pulse` has the shape of
 * GET /v1/dashboard/pulse (sample values; attention keys without the `pulse.`
 * prefix); wiring the authenticated API client replaces it.
 */
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
  documents: { byTier: { EXPIRED: 1, '15': 1, '30': 1, '60': 2 } as Record<string, number> },
  medical: { workers: 7, needsAction: 2 }, workOrders: { open: 5 }, pettyCash: { pendingReview: 4, amount: '612.40' },
  fleet: { due: 2 }, esb: { totalProvision: '41380.00' },
  budgets: [
    { name: 'groceries', budget: 6000, spent: 4870 }, { name: 'fuel', budget: 2500, spent: 2710 },
    { name: 'utilities', budget: 3200, spent: 2140 }, { name: 'household', budget: 2000, spent: 960 },
  ],
};
const BUDGET_NAMES: Record<string, Record<string, string>> = {
  ar: { groceries: 'المقاضي', fuel: 'الوقود', utilities: 'الخدمات', household: 'المنزل' },
  en: { groceries: 'Groceries', fuel: 'Fuel', utilities: 'Utilities', household: 'Household' },
};

export default async function DailyPulse({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const f = await getFormatter();
  const dir = getDirection(locale);
  const now = new Date(pulse.generatedAt);
  const hijri = new Intl.DateTimeFormat(`${localeMeta[locale].intlTag}-u-ca-islamic-umalqura`, { dateStyle: 'long', timeZone: 'Asia/Riyadh' }).format(now);
  const month = f.dateTime(new Date(`${pulse.payroll.currentMonth.period}-01T12:00:00Z`), { month: 'long', year: 'numeric' });
  const sar = (v: number | string) => f.number(Number(v), 'sar');
  const Forward = dir === 'rtl' ? ArrowLeft : ArrowRight;
  const kpis: Array<{ label: string; value: string; note?: string; tone?: Severity }> = [
    { label: t('exec.kpi.payroll'), value: sar(pulse.payroll.currentMonth.total), note: t('exec.kpi.payrollDue', { month, days: pulse.payroll.currentMonth.daysUntilDue }) },
    { label: t('exec.kpi.pettyCash'), value: sar(pulse.pettyCash.amount), note: t('exec.kpi.pettyCashReview', { count: pulse.pettyCash.pendingReview }) },
    { label: t('exec.kpi.workOrders'), value: f.number(pulse.workOrders.open), note: t('exec.kpi.workOrdersOpen', { count: pulse.workOrders.open }) },
    { label: t('exec.kpi.esb'), value: sar(pulse.esb.totalProvision) },
  ];
  const names = BUDGET_NAMES[locale] ?? BUDGET_NAMES.en!;
  const budgets = pulse.budgets.map((b) => ({ ...b, name: names[b.name] ?? b.name }));
  const tiers = Object.entries(pulse.documents.byTier).map(([tier, n]) => ({
    name: tier === 'EXPIRED' ? t('exec.docs.expired') : t('exec.docs.within', { days: Number(tier) }), value: n,
    tone: (tier === 'EXPIRED' ? 'critical' : tier === '15' ? 'warning' : 'navy') as 'critical' | 'warning' | 'navy' }));
  const valid = pulse.medical.workers - pulse.medical.needsAction;

  return (
    <AppShell current="pulse" title={t('pulse.title')}
      subtitle={<>{f.dateTime(now, { dateStyle: 'full', timeZone: 'Asia/Riyadh' })} · {hijri} · {t('exec.updated', { time: f.dateTime(now, { timeStyle: 'short', timeZone: 'Asia/Riyadh' }) })}</>}>
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label={t('pulse.title')}>
        {kpis.map((k) => (
          <Card key={k.label} className="gap-2">
            <CardHeader><CardDescription>{k.label}</CardDescription></CardHeader>
            <CardContent className="grid gap-1">
              <span className="text-2xl font-semibold tracking-tight tabular-nums">{k.value}</span>
              {k.note && <span className="text-sm text-muted-foreground">{k.note}</span>}
            </CardContent>
          </Card>
        ))}
      </section>

      <Card className="gap-0 pb-0">
        <CardHeader className="border-b border-slate-200 pb-4 dark:border-slate-800">
          <CardTitle>{t('exec.attention')}</CardTitle>
          <CardDescription className="tabular-nums">{f.number(pulse.attention.length)}</CardDescription>
        </CardHeader>
        {pulse.attention.length === 0 ? <CardContent className="py-5 text-sm text-muted-foreground">{t('exec.allClear')}</CardContent> : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="ps-5">{t('exec.table.severity')}</TableHead>
                <TableHead>{t('exec.table.item')}</TableHead>
                <TableHead className="text-end">{t('exec.table.count')}</TableHead>
                <TableHead className="pe-5 text-end"><span className="sr-only">{t('exec.table.action')}</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pulse.attention.map((a) => (
                <TableRow key={a.key}>
                  <TableCell className="ps-5"><Badge variant={a.severity}>{t(`exec.severity.${a.severity}`)}</Badge></TableCell>
                  <TableCell className="min-w-56">{t(`pulse.${a.key}`, { count: a.count })}</TableCell>
                  <TableCell className="text-end tabular-nums">{f.number(a.count)}</TableCell>
                  <TableCell className="pe-5 text-end">
                    <a href={a.deepLink} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                      {t('exec.table.action')}<Forward className="size-3.5" aria-hidden="true" />
                    </a>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>{t('exec.budgets.title')}</CardTitle></CardHeader>
          <CardContent>
            <BarChart data={budgets} index="name" dir={dir} numberLocale={locale} className="h-80"
              categories={[{ key: 'budget', label: t('exec.budgets.budget') }, { key: 'spent', label: t('exec.budgets.spent') }]} />
          </CardContent>
        </Card>
        <div className="grid gap-4">
          <Card>
            <CardHeader><CardTitle>{t('exec.docs.title')}</CardTitle></CardHeader>
            <CardContent><BarList data={tiers} sortOrder="none" valueFormatter={(v) => f.number(v)} /></CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('exec.medical.title')}</CardTitle>
              <CardDescription>{t('exec.medical.valid', { valid, total: pulse.medical.workers })}</CardDescription>
            </CardHeader>
            <CardContent>
              <ProgressBar value={valid} max={pulse.medical.workers} variant={pulse.medical.needsAction ? 'warning' : 'ok'}
                label={f.number(valid / pulse.medical.workers, { style: 'percent' })} />
            </CardContent>
          </Card>
          <Card className={cn('gap-2')}>
            <CardHeader><CardDescription>{t('exec.kpi.fleet')}</CardDescription></CardHeader>
            <CardContent className="flex items-baseline justify-between gap-2">
              <span className="text-2xl font-semibold tabular-nums">{f.number(pulse.fleet.due)}</span>
              <Badge variant={pulse.fleet.due ? 'warning' : 'ok'}>{t('exec.kpi.fleetDue', { count: pulse.fleet.due })}</Badge>
            </CardContent>
          </Card>
        </div>
      </section>
    </AppShell>
  );
}
