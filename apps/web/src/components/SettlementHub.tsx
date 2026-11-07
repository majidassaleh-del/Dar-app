'use client';

import { useEffect, useMemo, useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { CalendarDays, Landmark, Plane, Scale } from 'lucide-react';
import { ProgressBar } from '@/components/tremor/progress-bar';
import { cn } from '@/lib/utils';

interface Result {
  mode: 'live' | 'sample';
  esb: { serviceStart: string; serviceDays: number; serviceYears: number; completedFourYearPeriods: number; monthlyWage: string; vested: string;
         provision: string; monthlyProvision: string; nextVestingDate: string | null };
  leave: { accruedDays: number; takenDays: number; balanceDays: number; vestedDays: number; completedTwoYearCycles: number; nextEntitlementDate: string;
           dailyRate: string; unusedLeavePayout: string };
  settlement: { totalDue: string; advancesOutstanding: string; totalAfterAdvances: string };
}
const DAY = 86_400_000;
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

/** Interactive Art. 16 / Art. 10 calculator. Numbers come from the API (via /api/settlement); nothing is computed here in live mode. */
export function SettlementHub({ workers, defaultAsOf }: { workers: Array<{ id: string; name: string; role: string }>; defaultAsOf: string }) {
  const t = useTranslations('lux.settlement');
  const f = useFormatter();
  const locale = useLocale();
  const [staffId, setStaffId] = useState(workers[0]?.id ?? '');
  const [asOf, setAsOf] = useState(defaultAsOf);
  const [data, setData] = useState<Result | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');

  useEffect(() => {
    if (!staffId || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return;
    const ctl = new AbortController();
    setState('loading');
    fetch(`/api/settlement?staffId=${encodeURIComponent(staffId)}&asOf=${asOf}&locale=${locale}`, { signal: ctl.signal, cache: 'no-store' })
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); setData((await r.json()) as Result); setState('idle'); })
      .catch((e) => { if ((e as Error).name !== 'AbortError') setState('error'); });
    return () => ctl.abort();
  }, [staffId, asOf, locale]);

  const sar = (v: string | number) => f.number(Number(v), { style: 'currency', currency: 'SAR' });
  const view = useMemo(() => {
    if (!data) return null;
    const esbIn = data.esb.serviceDays % 1461;
    const toNextEsb = data.esb.nextVestingDate ? Math.max(0, days(asOf, data.esb.nextVestingDate)) : null;
    const next = data.leave.nextEntitlementDate;
    const prev = new Date(`${next}T00:00:00Z`); prev.setUTCFullYear(prev.getUTCFullYear() - 2);
    const cycleLen = days(prev.toISOString().slice(0, 10), next);
    const cycleIn = Math.min(cycleLen, Math.max(0, cycleLen - days(asOf, next)));
    return { esbIn, toNextEsb, cycleLen, cycleIn };
  }, [data, asOf]);

  if (!workers.length) return <p className="glass p-6 text-sm text-muted-foreground">{t('noWorkers')}</p>;

  return (
    <section className="glass gold-edge grid gap-6 p-5 sm:p-6" aria-labelledby="settlement-title" aria-busy={state === 'loading'}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 id="settlement-title" className="flex items-center gap-2 text-lg font-bold"><Scale className="size-5 text-gold" aria-hidden="true" />{t('title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-xs text-muted-foreground">{t('worker')}
            <select value={staffId} onChange={(e) => setStaffId(e.target.value)}
              className="h-9 min-w-48 rounded-lg border border-input bg-card-solid px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
              {workers.map((w) => <option key={w.id} value={w.id}>{w.name} · {w.role}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">{t('asOf')}
            <span className="relative">
              <CalendarDays className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)}
                className="h-9 rounded-lg border border-input bg-card-solid ps-8 pe-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50" />
            </span>
          </label>
        </div>
      </div>

      {state === 'error' && <p role="alert" className="text-sm text-critical">{t('error')}</p>}
      {!data || !view ? <p className="text-sm text-muted-foreground">{t('loading')}</p> : (
        <div className={cn('grid gap-4 transition-opacity lg:grid-cols-3', state === 'loading' && 'opacity-60')}>
          {/* Art. 16 */}
          <article className="rounded-2xl border border-border bg-card-solid/70 p-5">
            <h3 className="flex items-center gap-2 text-sm font-semibold"><Landmark className="size-4 text-primary dark:text-emerald-300" aria-hidden="true" />{t('esb')}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('esbRule')}</p>
            <p className="mt-4 text-xs text-muted-foreground">{t('vested')}</p>
            <p className="font-display text-3xl font-bold tabular">{sar(data.esb.vested)}</p>
            <div className="mt-4 grid gap-1.5">
              <ProgressBar value={view.esbIn} max={1461} label={f.number(view.esbIn / 1461, { style: 'percent' })} />
              {view.toNextEsb != null && <p className="text-xs text-muted-foreground">{t('toNextEsb', { days: view.toNextEsb })}</p>}
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-xs text-muted-foreground">{t('provision')}</dt><dd className="font-semibold tabular">{sar(data.esb.provision)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t('years', { years: f.number(data.esb.serviceYears, { maximumFractionDigits: 1 }) })}</dt>
                <dd className="font-semibold tabular">{f.number(data.esb.completedFourYearPeriods)} × 4</dd></div>
            </dl>
          </article>
          {/* Art. 10 */}
          <article className="rounded-2xl border border-border bg-card-solid/70 p-5">
            <h3 className="flex items-center gap-2 text-sm font-semibold"><Plane className="size-4 text-primary dark:text-emerald-300" aria-hidden="true" />{t('leave')}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('leaveRule')}</p>
            <p className="mt-4 text-xs text-muted-foreground">{t('payout')}</p>
            <p className="font-display text-3xl font-bold tabular">{sar(data.leave.unusedLeavePayout)}</p>
            <div className="mt-4 grid gap-1.5">
              <ProgressBar value={view.cycleIn} max={view.cycleLen} variant="gold" label={f.number(view.cycleIn / Math.max(1, view.cycleLen), { style: 'percent' })} />
              <p className="text-xs text-muted-foreground">{t('toNextLeave', { date: f.dateTime(new Date(`${data.leave.nextEntitlementDate}T12:00:00Z`), { dateStyle: 'medium' }) })}</p>
            </div>
            <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
              {([['accrued', data.leave.accruedDays], ['taken', data.leave.takenDays], ['balance', data.leave.balanceDays]] as const).map(([k, v]) => (
                <div key={k}><dt className="text-xs text-muted-foreground">{t(k)}</dt><dd className="font-semibold tabular">{t('days', { days: f.number(v, { maximumFractionDigits: 1 }) })}</dd></div>
              ))}
            </dl>
          </article>
          {/* Wage breakdown + totals */}
          <article className="flex flex-col rounded-2xl border border-[#d97706]/30 bg-gradient-to-br from-[#064e3b] to-[#022c22] p-5 text-[#e2e8f0] shadow-lg">
            <h3 className="text-sm font-semibold text-[#fbbf24]">{t('breakdown')}</h3>
            <dl className="mt-3 grid gap-2.5 text-sm">
              {([['wage', data.esb.monthlyWage], ['daily', data.leave.dailyRate], ['monthlyProvision', data.esb.monthlyProvision]] as const).map(([k, v]) => (
                <div key={k} className="flex items-baseline justify-between gap-3 border-b border-white/10 pb-2"><dt className="text-[#cbd5e1]">{t(k)}</dt><dd className="font-semibold tabular">{sar(v)}</dd></div>
              ))}
            </dl>
            <div className="mt-auto grid gap-1.5 pt-5">
              <div className="flex items-baseline justify-between gap-3"><span className="text-sm text-[#cbd5e1]">{t('total')}</span><span className="font-display text-2xl font-bold tabular text-[#fbbf24]">{sar(data.settlement.totalDue)}</span></div>
              <div className="flex items-baseline justify-between gap-3 text-sm"><span className="text-[#cbd5e1]">{t('advances')}</span><span className="tabular">− {sar(data.settlement.advancesOutstanding)}</span></div>
              <div className="flex items-baseline justify-between gap-3 text-sm"><span className="text-[#cbd5e1]">{t('net')}</span><span className="font-semibold tabular">{sar(data.settlement.totalAfterAdvances)}</span></div>
            </div>
          </article>
        </div>
      )}
    </section>
  );
}
