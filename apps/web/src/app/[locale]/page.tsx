import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { ArrowLeft, ArrowRight, Car, ShieldCheck, Users, Wrench, Gauge, UserRound, HeartPulse } from 'lucide-react';
import { getDirection, localeMeta, type Locale } from '@herp/i18n';
import { ExecShell } from '@/components/ExecShell';
import { EncryptedField } from '@/components/EncryptedField';
import { SaudiPlate } from '@/components/SaudiPlate';
import { SettlementHub } from '@/components/SettlementHub';
import { Badge } from '@/components/ui/badge';
import { ProgressBar } from '@/components/tremor/progress-bar';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { loadDashboard, type VehicleCard } from '@/lib/dashboard';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic'; // live data per request (session + household)

const todayRiyadh = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());

export default async function ExecutivePulse({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const f = await getFormatter();
  const d = await loadDashboard(locale);
  const dir = getDirection(locale);
  const Forward = dir === 'rtl' ? ArrowLeft : ArrowRight;
  const now = new Date();
  const hijri = new Intl.DateTimeFormat(`${localeMeta[locale].intlTag}-u-ca-islamic-umalqura`, { dateStyle: 'long', timeZone: 'Asia/Riyadh' }).format(now);
  const sar = (v: string | number) => f.number(Number(v), { style: 'currency', currency: 'SAR', maximumFractionDigits: 0 });

  const count = (s: string) => d.staff.filter((x) => x.status === s).length;
  const workforce = [{ k: 'active', n: count('ACTIVE') }, { k: 'probation', n: count('ON_PROBATION') }, { k: 'onLeave', n: count('ON_LEAVE') }] as const;
  const medicalValid = Math.max(0, d.medical.workers - d.medical.needsAction);
  const tone = (days: number) => (days < 0 ? 'critical' : days <= 30 ? 'warning' : 'ok') as 'critical' | 'warning' | 'ok';
  const vehicleState = (v: VehicleCard) => {
    const worstDoc = [...v.docs].sort((a, b) => a.daysLeft - b.daysLeft)[0];
    const due = v.maintenance.find((m) => m.status === 'OVERDUE') ?? v.maintenance.find((m) => m.status === 'DUE_SOON');
    return { worstDoc, due };
  };

  return (
    <ExecShell current="pulse" title={t('lux.hero.title')} households={d.households} household={d.current} mode={d.mode} back={`/${locale}`}
      subtitle={<>{f.dateTime(now, { dateStyle: 'full', timeZone: 'Asia/Riyadh' })} · {hijri}</>}>

      {/* Hero: workforce · decisions · ESB liability */}
      <section className="grid gap-4 lg:grid-cols-3" aria-label={t('lux.hero.title')}>
        <article className="glass gold-edge p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground"><Users className="size-4 text-gold" aria-hidden="true" />{t('lux.hero.staff')}</h2>
          <p className="mt-2 font-display text-4xl font-bold tabular">{f.number(d.staff.length)}</p>
          <p className="text-sm text-muted-foreground">{t('lux.hero.workers', { count: d.staff.length })}</p>
          <ul className="mt-4 flex flex-wrap gap-2">
            {workforce.map((w) => (
              <li key={w.k} className="rounded-full border border-border bg-card-solid/70 px-3 py-1 text-xs"><span className="font-semibold tabular">{f.number(w.n)}</span> {t(`lux.hero.${w.k}`)}</li>
            ))}
          </ul>
          <div className="mt-4 grid gap-1">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><HeartPulse className="size-3.5" aria-hidden="true" />{t('lux.hero.medicalValid')}</span>
            <ProgressBar value={medicalValid} max={Math.max(1, d.medical.workers)} variant={d.medical.needsAction ? 'gold' : 'ok'}
              label={`${f.number(medicalValid)} / ${f.number(d.medical.workers)}`} />
          </div>
        </article>

        <article className="glass gold-edge p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground"><ShieldCheck className="size-4 text-gold" aria-hidden="true" />{t('lux.hero.decisions')}</h2>
          <p className="mt-2 font-display text-4xl font-bold tabular">{f.number(d.attention.reduce((s, a) => s + a.count, 0))}</p>
          <ul className="mt-3 grid gap-2">
            {d.attention.slice(0, 3).map((a) => (
              <li key={a.key} className="flex items-center gap-2 text-sm"><Badge variant={a.severity}>{t(`exec.severity.${a.severity}`)}</Badge><span className="min-w-0 truncate">{t(`pulse.${a.key}` as 'pulse.medicalOverdue', { count: a.count })}</span></li>
            ))}
            {!d.attention.length && <li className="text-sm text-muted-foreground">{t('lux.compliance.none')}</li>}
          </ul>
        </article>

        <article className="glass relative overflow-hidden p-5">
          <div aria-hidden="true" className="absolute -end-10 -top-10 size-40 rounded-full bg-[#d97706]/15 blur-2xl" />
          <h2 className="text-sm font-semibold text-muted-foreground">{t('exec.kpi.esb')}</h2>
          <p className="mt-2 font-display text-4xl font-bold tabular text-primary dark:text-[#fbbf24]">{sar(d.esb.totalProvision)}</p>
          <p className="text-sm text-muted-foreground">{t('lux.settlement.provision')}</p>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div><dt className="text-xs text-muted-foreground">{t('lux.settlement.vested')}</dt><dd className="font-semibold tabular">{sar(d.esb.totalVested)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{t('lux.hero.staff')}</dt><dd className="font-semibold tabular">{t('lux.hero.workers', { count: d.esb.workers })}</dd></div>
          </dl>
        </article>
      </section>

      {/* Fleet */}
      <section aria-labelledby="fleet-title" className="grid gap-3">
        <h2 id="fleet-title" className="flex items-center gap-2 text-lg font-bold"><Car className="size-5 text-gold" aria-hidden="true" />{t('lux.fleet.title')}</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {d.vehicles.map((v) => {
            const { worstDoc, due } = vehicleState(v);
            return (
              <article key={v.id} className="glass p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="font-display text-lg font-bold">{v.make} {v.model}</h3>
                    <p className="text-xs text-muted-foreground">{v.year} · {v.drivers ? t('lux.fleet.assigned') : '—'}</p>
                  </div>
                  <SaudiPlate latin={v.plateNumber} arabic={v.plateNumberAr} />
                </div>
                <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
                  <div className="grid gap-0.5"><dt className="flex items-center gap-1 text-xs text-muted-foreground"><Gauge className="size-3.5" aria-hidden="true" />{t('lux.fleet.odometerLabel')}</dt>
                    <dd className="font-semibold tabular">{t('lux.fleet.odometer', { km: v.odometerKm })}</dd></div>
                  <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">{t('lux.fleet.docs')}</dt>
                    <dd>{worstDoc ? <Badge variant={tone(worstDoc.daysLeft)}>{worstDoc.daysLeft < 0 ? t('lux.fleet.expired', { doc: t(`lux.fleet.doc.${worstDoc.doc}`) })
                      : worstDoc.daysLeft <= 60 ? t('lux.fleet.expiresIn', { doc: t(`lux.fleet.doc.${worstDoc.doc}`), days: worstDoc.daysLeft }) : t('lux.fleet.allValid')}</Badge> : '—'}</dd></div>
                  <div className="grid gap-0.5"><dt className="flex items-center gap-1 text-xs text-muted-foreground"><Wrench className="size-3.5" aria-hidden="true" />{t('lux.fleet.service')}</dt>
                    <dd>{due ? <Badge variant={due.status === 'OVERDUE' ? 'critical' : 'warning'}>{t('lux.fleet.serviceDue', { item: t(`notify.item.${due.type}` as 'notify.item.OIL_CHANGE') })}</Badge>
                      : <Badge variant="ok">{t('lux.fleet.serviceOk')}</Badge>}</dd></div>
                </dl>
                <ul className="mt-4 flex flex-wrap gap-1.5">
                  {v.docs.map((doc) => (
                    <li key={doc.doc} className={cn('rounded-md border px-2 py-0.5 text-[11px]', doc.daysLeft < 0 ? 'border-critical/40 text-critical' : doc.daysLeft <= 30 ? 'border-[#d97706]/40 text-gold-ink' : 'border-border text-muted-foreground')}>
                      {t(`lux.fleet.doc.${doc.doc}`)} · <span className="tabular">{f.number(doc.daysLeft)}</span>
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>
      </section>

      {/* Compliance highlights */}
      <section className="glass overflow-hidden" aria-labelledby="compliance-title">
        <h2 id="compliance-title" className="border-b border-border px-5 py-4 text-base font-bold">{t('lux.compliance.title')}</h2>
        {d.attention.length === 0 ? <p className="px-5 py-4 text-sm text-muted-foreground">{t('lux.compliance.none')}</p> : (
          <ul className="divide-y divide-border">
            {d.attention.map((a) => (
              <li key={a.key} className="flex items-center gap-3 px-5 py-3 text-sm">
                <Badge variant={a.severity}>{t(`exec.severity.${a.severity}`)}</Badge>
                <span className="min-w-0 flex-1">{t(`pulse.${a.key}` as 'pulse.medicalOverdue', { count: a.count })}</span>
                <a href={a.deepLink} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">{t('exec.table.action')}<Forward className="size-3.5" aria-hidden="true" /></a>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Financial & settlement hub */}
      <SettlementHub defaultAsOf={todayRiyadh()} workers={d.staff.map((s) => ({ id: s.id, name: s.name, role: t(`lux.staffType.${s.staffType}` as 'lux.staffType.OTHER') }))} />

      {/* Staff roster with data-protection cues */}
      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="glass overflow-hidden">
          <h2 className="flex items-center gap-2 border-b border-border px-5 py-4 text-base font-bold"><UserRound className="size-4 text-gold" aria-hidden="true" />{t('lux.roster.title')}</h2>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="ps-5">{t('lux.roster.name')}</TableHead>
                <TableHead>{t('lux.roster.status')}</TableHead>
                <TableHead>{t('lux.protection.identity')}</TableHead>
                <TableHead>{t('lux.protection.iban')}</TableHead>
                <TableHead className="pe-5">{t('lux.protection.health')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.staff.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="ps-5"><span className="font-medium">{s.name}</span><span className="block text-xs text-muted-foreground">{t(`lux.staffType.${s.staffType}` as 'lux.staffType.OTHER')}</span></TableCell>
                  <TableCell><Badge variant={s.status === 'ACTIVE' ? 'ok' : s.status === 'ON_LEAVE' ? 'info' : 'warning'}>{t(`lux.status.${s.status}` as 'lux.status.ACTIVE')}</Badge></TableCell>
                  <TableCell><EncryptedField last4={s.identity?.last4} label={t('lux.protection.identity')} hint={t('lux.protection.hint')} empty={t('lux.protection.none')} /></TableCell>
                  <TableCell><EncryptedField last4={s.ibanLast4} label={t('lux.protection.iban')} hint={t('lux.protection.hint')} empty={t('lux.protection.none')} /></TableCell>
                  <TableCell className="pe-5"><EncryptedField always label={t('lux.protection.health')} hint={t('lux.protection.healthHint')} empty={t('lux.protection.encrypted')} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <aside className="glass gold-edge grid content-start gap-4 p-5" aria-labelledby="protection-title">
          <h2 id="protection-title" className="flex items-center gap-2 text-base font-bold"><ShieldCheck className="size-5 text-gold" aria-hidden="true" />{t('lux.protection.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('lux.protection.hint')}</p>
          <ul className="grid gap-2 text-sm">
            {(['identity', 'iban', 'health'] as const).map((k) => (
              <li key={k} className="flex items-center justify-between gap-2"><span>{t(`lux.protection.${k}`)}</span><EncryptedField always label={t(`lux.protection.${k}`)} hint={t('lux.protection.hint')} empty={t('lux.protection.encrypted')} /></li>
            ))}
          </ul>
          <div className="rounded-xl border border-border bg-card-solid/60 p-3 text-xs">
            <p className="font-semibold">{t('lux.protection.isolated')} · {d.current.name}</p>
            <p className="mt-1 text-muted-foreground">{t('lux.protection.isolatedHint')}</p>
          </div>
        </aside>
      </section>
    </ExecShell>
  );
}
