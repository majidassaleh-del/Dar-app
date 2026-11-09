import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { apiGet } from '@/lib/api';
import { fmt } from '@/lib/fmt';
import { addLine, createRun, payWorker, removeLine, runStatus } from '@/lib/payroll-actions';
import { label, loose, today, type Rows } from '@/lib/sections';
import { cn } from '@/lib/utils';
import { Avatar, Dot, ListDetail, Panel, RecordHeader, type Tone } from '../ListDetail';

type Opts = { household: string; locale: string };
interface Run { id: string; period: string; periodYear: number; periodMonth: number; status: string; totalAmount: string; currency: string; paidAt: string | null }
interface Slip { staffId: string; name: string; gross: string; deductions: string; net: string; lines: Array<{ id: string; type: string; amount: string; description: string }> }
interface Pay { id: string; staffId: string; amount: string; channel: string; status: string; externalRef: string | null; proofFileId: string | null; paidAt: string | null }
interface Staff { id: string; staffType: string; preferredLocale: string; payout: { defaultChannel: string | null; ibanLast4: string | null } }

const CHANNELS = ['BANK_TRANSFER', 'MUSANED', 'CASH', 'DIGITAL_WALLET'] as const;
const FLOW = ['DRAFT', 'APPROVED', 'PAID'] as const;
/** Generated allowance lines carry the code ("Allowance: FOOD"): show its name instead. */
export const lineNote = (t0: Parameters<typeof label>[0], type: string, description: string) => {
  const code = type === 'ALLOWANCE' ? /:\s*([A-Z_]+)/.exec(description)?.[1] : undefined;
  return code ? label(t0, 'allowance', code) : ['BASIC_SALARY', 'ADVANCE_RECOVERY'].includes(type) ? '' : description;
};
const toneOf = (s: string): Tone => (s === 'PAID' ? 'ok' : s === 'APPROVED' ? 'brass' : s === 'CANCELLED' ? 'muted' : 'warning');

export async function PayrollSection({ opts, id, sp }: { opts: Opts; id: string | null; tab: string | null; sp?: Record<string, string | undefined> }) {
  const [t0, tl0, f, locale] = await Promise.all([getTranslations('ui'), getTranslations('lux'), fmt(), getLocale()]);
  const t = loose(t0);
  const [list, pulse, staffR] = await Promise.all([
    apiGet<Rows<Run>>('/v1/payroll-runs', opts),
    apiGet<{ payroll: { payDay: number } }>('/v1/dashboard/pulse', opts),
    apiGet<Rows<Staff>>('/v1/staff', opts),
  ]);
  const runs = (list?.data ?? []).filter((r) => r.status !== 'CANCELLED');
  const payDay = pulse?.payroll.payDay ?? 28;
  const staff = new Map((staffR?.data ?? []).map((s) => [s.id, s]));
  const now = today(), y = Number(now.slice(0, 4)), m = Number(now.slice(5, 7));
  const hasCurrent = runs.some((r) => r.periodYear === y && r.periodMonth === m);
  const sel = id ? runs.find((r) => r.id === id) : runs[0];
  if (id && !sel) notFound();
  const monthOf = (r: { periodYear: number; periodMonth: number }) => f.monthName(`${r.periodYear}-${String(r.periodMonth).padStart(2, '0')}-01`);
  const payDate = (r: { periodYear: number; periodMonth: number }) => `${r.periodYear}-${String(r.periodMonth).padStart(2, '0')}-${String(payDay).padStart(2, '0')}`;

  const items = runs.map((r) => ({ id: r.id, lead: <Dot tone={toneOf(r.status)} />, primary: monthOf(r),
    secondary: `${label(t0, 'runStatus', r.status)} · ${f.dayMonth(payDate(r))}`, trail: f.money(r.totalAmount, r.currency), tone: r.status === 'DRAFT' ? 'warning' as const : undefined }));

  const create = !hasCurrent ? (
    <Panel title={t('payroll.notPrepared', { month: f.monthName(`${now.slice(0, 7)}-01`) })} note={t('payroll.payDayNote', { date: f.dayMonth(payDate({ periodYear: y, periodMonth: m })) })}>
      <form action={createRun} className="flex flex-wrap items-center justify-between gap-4">
        <input type="hidden" name="locale" value={locale} /><input type="hidden" name="year" value={y} /><input type="hidden" name="month" value={m} />
        <p className="text-muted-foreground">{t('payroll.prepareHint')}</p>
        <button type="submit" className="btn btn-primary">{t('payroll.prepare', { month: f.monthName(`${now.slice(0, 7)}-01`) })}</button>
      </form>
    </Panel>
  ) : null;

  let detail: React.ReactNode = create;
  if (sel) {
    const run = await apiGet<Run & { staff: Slip[] }>(`/v1/payroll-runs/${sel.id}`, opts);
    const pays = await apiGet<Rows<Pay>>(`/v1/salary-payments?year=${sel.periodYear}&month=${sel.periodMonth}`, opts);
    const paid = new Map((pays?.data ?? []).filter((p) => p.status !== 'REVERSED').map((p) => [p.staffId, p]));
    const slips = (run?.staff ?? []).filter((s) => Number(s.net) > 0 || s.lines.length);
    const due = slips.filter((s) => Number(s.net) > 0);
    const nPaid = due.filter((s) => paid.has(s.staffId)).length;
    const nProof = due.filter((s) => paid.get(s.staffId)?.proofFileId || paid.get(s.staffId)?.externalRef || paid.get(s.staffId)?.channel === 'CASH').length;
    const reached = FLOW.indexOf(sel.status as (typeof FLOW)[number]);
    const err = sp?.e ? decodeURIComponent(sp.e) : null;
    const hidden = (extra: Record<string, string>) => (<><input type="hidden" name="locale" value={locale} /><input type="hidden" name="runId" value={sel.id} />
      {Object.entries(extra).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}</>);
    detail = (
      <>
        {create}
        <RecordHeader title={t('payroll.title', { month: monthOf(sel) })} meta={`${t('payroll.payDay', { date: f.date(payDate(sel)) })} · ${label(t0, 'runStatus', sel.status)}`}
          actions={sel.status === 'DRAFT' ? (
            <form action={runStatus}>{hidden({ action: 'approve' })}<button type="submit" className="btn btn-primary">{t('payroll.approve')}</button></form>
          ) : sel.status === 'APPROVED' && nPaid === 0 ? (
            <form action={runStatus}>{hidden({ action: 'reopen' })}<button type="submit" className="btn">{t('payroll.reopen')}</button></form>
          ) : null}
          stats={[
            { label: t('payroll.total'), value: f.money(sel.totalAmount, sel.currency) },
            { label: t('payroll.workers'), value: f.num(due.length) },
            { label: t('payroll.paid'), value: t('home.ofTotal', { count: nPaid, total: due.length }), tone: nPaid < due.length ? (sel.status === 'APPROVED' ? 'brass' : undefined) : 'ok' },
            { label: t('payroll.proven'), value: t('home.ofTotal', { count: nProof, total: nPaid }), tone: nProof < nPaid ? 'warning' : undefined },
          ]} />
        <section className="panel flex flex-wrap items-center gap-3 px-5 py-3.5 sm:px-6" aria-label={t('sec.progress')}>
          {FLOW.map((s, n) => (
            <div key={s} className="flex items-center gap-3">
              {n > 0 && <span aria-hidden="true" className={cn('h-0.5 w-8 rounded', n <= reached ? 'bg-primary' : 'bg-track')} />}
              <span className={cn('grid size-6 place-items-center rounded-full text-xs font-bold', n < reached || (n === reached && s === 'PAID') ? 'bg-primary text-white' : n === reached ? 'bg-brass text-header' : 'bg-track text-muted-foreground')}>
                {n < reached || (n === reached && s === 'PAID') ? '✓' : n + 1}
              </span>
              <span className={cn(n === reached ? 'font-semibold' : 'text-muted-foreground')}>{label(t0, 'runStatus', s)}</span>
            </div>
          ))}
          <span className="ms-auto text-xs text-muted-foreground">{t(`payroll.stepHint.${sel.status}`)}</span>
        </section>
        {err && <p role="alert" className="rounded-md bg-critical-soft px-4 py-2.5 text-sm text-critical">{err}</p>}
        <Panel title={t('payroll.workersTitle')} note={t('payroll.capNote')} flush>
          {slips.length === 0 && <p className="px-6 py-4 text-muted-foreground">{t('payroll.noWorkers')}</p>}
          {slips.map((s, i) => {
            const p = paid.get(s.staffId), st = staff.get(s.staffId);
            const open = sp?.worker === s.staffId || (!p && sel.status === 'APPROVED' && i === slips.findIndex((x) => !paid.has(x.staffId)));
            return (
              <details key={s.staffId} open={open} className={cn('group', i > 0 && 'border-t border-hairline')}>
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3.5 hover:bg-muted sm:px-6 [&::-webkit-details-marker]:hidden">
                  <Avatar name={s.name} tone={p ? 'ok' : sel.status === 'APPROVED' ? 'brass' : 'muted'} />
                  <span className="min-w-0 flex-[1_1_160px]"><span className="block font-semibold">{s.name}</span>
                    <span className="block text-xs text-muted-foreground">{st ? label(tl0, 'staffType', st.staffType) : ''}</span></span>
                  <span className="text-xs text-muted-foreground tabular">{t('payroll.grossDed', { gross: f.money(s.gross), ded: f.money(Math.abs(Number(s.deductions))) })}</span>
                  <span className="min-w-28 text-end font-bold tabular">{f.money(s.net)}</span>
                  <span className={cn('min-w-32 text-end text-xs', p ? 'text-primary' : sel.status === 'APPROVED' ? 'text-brass-ink' : 'text-muted-foreground')}>
                    {p ? `${t('sec.paid')} · ${f.dayMonth(p.paidAt ?? now)}` : sel.status === 'APPROVED' ? t('payroll.toPay') : '—'}
                  </span>
                </summary>
                <div className="grid gap-4 bg-muted px-5 py-4 sm:px-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                  <table className="w-full border-collapse self-start text-sm">
                    <tbody>
                      {s.lines.map((ln) => (
                        <tr key={ln.id} className="border-b border-hairline last:border-0">
                          <td className="py-1.5 pe-3">{label(t0, 'lineType', ln.type)}<span className="block text-xs text-muted-foreground">{lineNote(t0, ln.type, ln.description)}</span></td>
                          <td className={cn('py-1.5 text-end tabular', Number(ln.amount) < 0 && 'text-critical')}>{f.money(ln.amount)}</td>
                          {sel.status === 'DRAFT' && ['BONUS', 'OVERTIME', 'ALLOWANCE', 'DEDUCTION'].includes(ln.type) && (
                            <td className="w-8 py-1.5 text-end"><form action={removeLine}>{hidden({ lineId: ln.id, staffId: s.staffId })}
                              <button type="submit" className="text-xs text-critical hover:underline" aria-label={t('payroll.remove')}>✕</button></form></td>
                          )}
                        </tr>
                      ))}
                      <tr><td className="pt-2 font-semibold">{t('payroll.net')}</td><td className="pt-2 text-end font-bold tabular">{f.money(s.net)}</td></tr>
                    </tbody>
                  </table>
                  <div className="flex min-w-0 flex-col gap-3">
                    {sel.status === 'DRAFT' && (
                      <form action={addLine} className="panel grid gap-2.5 p-4">{hidden({ staffId: s.staffId })}
                        <div className="text-sm font-semibold">{t('payroll.addLine')}</div>
                        <div className="flex gap-2">
                          <select name="type" className="field flex-1" aria-label={t('finance.kind')}>
                            {['BONUS', 'OVERTIME', 'ALLOWANCE', 'DEDUCTION'].map((k) => <option key={k} value={k}>{label(t0, 'lineType', k)}</option>)}
                          </select>
                          <input name="amount" required inputMode="decimal" className="field w-28 tabular" placeholder={t('amount')} aria-label={t('amount')} />
                        </div>
                        <input name="description" required maxLength={200} className="field" placeholder={t('wo.description')} aria-label={t('wo.description')} />
                        <button type="submit" className="btn">{t('payroll.addLineBtn')}</button>
                      </form>
                    )}
                    {sel.status === 'APPROVED' && !p && (
                      <form action={payWorker} className="panel grid min-w-0 gap-2.5 p-4">{hidden({ staffId: s.staffId })}
                        <div className="text-sm font-semibold">{t('payroll.recordTitle', { amount: f.money(s.net) })}</div>
                        <label className="grid gap-1 text-xs text-muted-foreground">{t('payroll.proof')}
                          <input name="proof" type="file" accept="image/*,application/pdf" className="field w-full min-w-0 py-1.5 text-sm file:me-3 file:rounded file:border-0 file:bg-selected file:px-2 file:py-1 file:text-primary" />
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                          <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">{t('staff.channel')}
                            <select name="channel" defaultValue={st?.payout.defaultChannel ?? 'BANK_TRANSFER'} className="field w-full min-w-0">
                              {CHANNELS.map((c) => <option key={c} value={c}>{label(t0, 'channel', c)}</option>)}
                            </select></label>
                          <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">{t('payroll.reference')}
                            <input name="externalRef" maxLength={80} dir="ltr" className="field w-full min-w-0" /></label>
                        </div>
                        <p className="text-xs text-muted-foreground">{t('payroll.proofHint')}</p>
                        <button type="submit" className="btn btn-primary">{t('payroll.record')}</button>
                      </form>
                    )}
                    {p && (
                      <div className="panel grid gap-1.5 p-4 text-sm">
                        <div className="font-semibold text-primary">{t('payroll.paidOn', { date: f.date(p.paidAt ?? now) })}</div>
                        <div className="text-muted-foreground">{label(t0, 'channel', p.channel)}{p.externalRef ? ` · ${p.externalRef}` : ''}{st?.payout.ibanLast4 && p.channel === 'BANK_TRANSFER' ? ` · •••• ${st.payout.ibanLast4}` : ''}</div>
                        <div className="text-muted-foreground">{label(t0, 'payStatus', p.status)}</div>
                        <div className="mt-1 flex flex-wrap gap-3">
                          <Link href={`/payslip/${sel.id}/${s.staffId}`} className="link">{t('payroll.payslip')}</Link>
                          {p.proofFileId && <a href={`/api/files/${p.proofFileId}`} target="_blank" rel="noopener" className="link">{t('payroll.viewProof')}</a>}
                        </div>
                      </div>
                    )}
                    {!p && sel.status !== 'DRAFT' && sel.status !== 'APPROVED' && <span className="text-xs text-muted-foreground">—</span>}
                    {sel.status !== 'DRAFT' && !p && <Link href={`/payslip/${sel.id}/${s.staffId}`} className="link text-sm">{t('payroll.payslip')}</Link>}
                  </div>
                </div>
              </details>
            );
          })}
        </Panel>
      </>
    );
  }

  return <ListDetail title={t('nav.payroll')} base="/payroll" items={items} selectedId={sel?.id ?? null} explicit={!!id} detail={detail} empty={t('payroll.empty')}
    summary={t('payroll.summary', { day: payDay })}
    stats={[
      { label: t('payroll.payDayLabel'), value: f.num(payDay) },
      { label: t('payroll.months'), value: f.num(runs.length) },
      { label: t('payroll.lastPaid'), value: runs.find((r) => r.status === 'PAID') ? monthOf(runs.find((r) => r.status === 'PAID')!) : '—' },
    ]} />;
}
