'use client';

import { useEffect, useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';

interface Result {
  esb: { serviceYears: number; completedFourYearPeriods: number; monthlyWage: string; vested: string; provision: string; monthlyProvision: string; nextVestingDate: string | null };
  leave: { balanceDays: number; dailyRate: string; unusedLeavePayout: string; nextEntitlementDate: string };
  settlement: { totalDue: string; advancesOutstanding: string; totalAfterAdvances: string };
}

/**
 * What a worker would be owed if the service ended on a chosen date: Art. 16 end of service,
 * Art. 10 unused leave, less advances. Figures come from the API via /api/settlement.
 * `table` for the worker's file, `sentence` for the daily brief.
 */
export function SettlementStatement({ workers, defaultAsOf, initialStaffId, variant = 'table' }:
  { workers: Array<{ id: string; name: string }>; defaultAsOf: string; initialStaffId?: string; variant?: 'table' | 'sentence' }) {
  const t = useTranslations('ui.settle');
  const f = useFormatter();
  const locale = useLocale();
  const [staffId, setStaffId] = useState(initialStaffId ?? workers[0]?.id ?? '');
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

  if (!workers.length) return <p className="text-muted-foreground">{t('noWorkers')}</p>;
  const n = (v: string | number) => f.number(Number(v), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const days = (v: number) => f.number(v, { maximumFractionDigits: 1 });

  const controls = (
    <div className="flex flex-wrap items-end gap-3">
      {variant === 'sentence' || !initialStaffId ? (
        <label className="grid gap-1 text-xs text-muted-foreground">{t('worker')}
          <select value={staffId} onChange={(e) => setStaffId(e.target.value)} className="field min-w-48">
            {workers.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
      ) : null}
      <label className="grid gap-1 text-xs text-muted-foreground">{t('asOf')}
        <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="field tabular" />
      </label>
    </div>
  );

  return (
    <div className="grid gap-4" aria-busy={state === 'loading'}>
      {controls}
      {state === 'error' && <p role="alert" className="text-critical">{t('error')}</p>}
      {!data ? <p className="text-muted-foreground">{t('loading')}</p> : variant === 'sentence' ? (
        <div className={state === 'loading' ? 'opacity-60' : undefined}>
          <p>{t('sentence', { esb: n(data.esb.vested), days: days(data.leave.balanceDays), leave: n(data.leave.unusedLeavePayout),
                              advances: n(data.settlement.advancesOutstanding), net: n(data.settlement.totalAfterAdvances) })}</p>
          <p className="text-muted-foreground">{t('wageLine', { wage: n(data.esb.monthlyWage), daily: n(data.leave.dailyRate), provision: n(data.esb.monthlyProvision) })}</p>
        </div>
      ) : (
        <div className={state === 'loading' ? 'opacity-60' : undefined}>
          <table className="w-full border-collapse">
            <thead><tr className="text-xs text-muted-foreground"><th className="py-1.5 text-start font-medium">{t('item')}</th><th className="py-1.5 text-start font-medium">{t('basis')}</th><th className="py-1.5 text-end font-medium">{t('sar')}</th></tr></thead>
            <tbody>
              <tr className="border-t"><td className="py-2 pe-4">{t('esb')}</td>
                <td className="py-2 pe-4 text-muted-foreground">{t('esbBasis', { years: f.number(data.esb.serviceYears, { maximumFractionDigits: 1 }), periods: data.esb.completedFourYearPeriods })}</td>
                <td className="py-2 text-end tabular">{n(data.esb.vested)}</td></tr>
              <tr className="border-t"><td className="py-2 pe-4">{t('leave')}</td>
                <td className="py-2 pe-4 text-muted-foreground">{t('leaveBasis', { days: days(data.leave.balanceDays), daily: n(data.leave.dailyRate) })}</td>
                <td className="py-2 text-end tabular">{n(data.leave.unusedLeavePayout)}</td></tr>
              <tr className="border-t"><td className="py-2 pe-4">{t('advances')}</td><td className="py-2 pe-4 text-muted-foreground">{t('advancesBasis')}</td>
                <td className="py-2 text-end tabular">−{n(data.settlement.advancesOutstanding)}</td></tr>
              <tr className="border-t border-t-foreground"><td className="py-2.5 font-semibold" colSpan={2}>{t('net')}</td>
                <td className="py-2.5 text-end font-semibold tabular">{n(data.settlement.totalAfterAdvances)}</td></tr>
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted-foreground">
            {t('footnote', { wage: n(data.esb.monthlyWage), provision: n(data.esb.monthlyProvision),
                             next: data.esb.nextVestingDate ? f.dateTime(new Date(`${data.esb.nextVestingDate}T12:00:00Z`), { dateStyle: 'medium' }) : '—',
                             leaveNext: f.dateTime(new Date(`${data.leave.nextEntitlementDate}T12:00:00Z`), { dateStyle: 'medium' }) })}
          </p>
        </div>
      )}
    </div>
  );
}
