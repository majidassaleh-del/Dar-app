import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getDirection, isLocale, type Locale } from '@herp/i18n';
import { Link } from '@/i18n/navigation';
import { PrintButton } from '@/components/PrintButton';
import { lineNote } from '@/components/sections/Payroll';
import { apiGet } from '@/lib/api';
import { loadSession } from '@/lib/dashboard';
import { fmt } from '@/lib/fmt';
import { label, loose, type Rows } from '@/lib/sections';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

interface Run { id: string; periodYear: number; periodMonth: number; status: string; currency: string;
  staff: Array<{ staffId: string; name: string; gross: string; deductions: string; net: string; lines: Array<{ id: string; type: string; amount: string; description: string }> }> }
interface Pay { staffId: string; amount: string; channel: string; status: string; externalRef: string | null; proofFileId: string | null; paidAt: string | null; payoutLast4: string | null; acknowledgedAt: string | null }
interface Staff { id: string; name: string; fullName: Record<string, string>; staffType: string; nationality: string | null; preferredLocale: string; hireDate: string | null }

/**
 * Payslip, A4, in Arabic and in the worker's own language side by side: earnings, every
 * deduction (advance instalment, unpaid days…), net, how and when it was paid, and whether
 * the worker has confirmed receipt. "Print / Save as PDF" uses the browser's print dialog.
 */
export default async function Payslip({ params }: { params: Promise<{ locale: Locale; runId: string; staffId: string }> }) {
  const { locale, runId, staffId } = await params;
  if (![runId, staffId].every((x) => /^[0-9a-f-]{36}$/.test(x))) notFound();
  setRequestLocale(locale);
  const s = await loadSession(locale);
  if (!s.opts) notFound();
  const [run, staff] = await Promise.all([apiGet<Run>(`/v1/payroll-runs/${runId}`, s.opts), apiGet<Staff>(`/v1/staff/${staffId}`, s.opts)]);
  const slip = run?.staff.find((x) => x.staffId === staffId);
  if (!run || !slip || !staff) notFound();
  const pays = await apiGet<Rows<Pay>>(`/v1/salary-payments?year=${run.periodYear}&month=${run.periodMonth}&staffId=${staffId}`, s.opts);
  const pay = (pays?.data ?? []).find((p) => p.status !== 'REVERSED');
  const second: Locale = staff.preferredLocale && isLocale(staff.preferredLocale) && staff.preferredLocale !== 'ar' ? staff.preferredLocale : 'en';
  const [ta0, tw0, tl0, tlw0, f] = await Promise.all([getTranslations({ locale: 'ar', namespace: 'ui' }), getTranslations({ locale: second, namespace: 'ui' }),
    getTranslations({ locale: 'ar', namespace: 'lux' }), getTranslations({ locale: second, namespace: 'lux' }), fmt()]);
  const ta = loose(ta0), tw = loose(tw0);
  const both = (k: string, v?: Record<string, string>) => (
    <span className="flex flex-col"><span>{ta(k, v)}</span><span lang={second} dir={getDirection(second)} className="text-[11px] text-muted-foreground">{tw(k, v)}</span></span>);
  const bothLabel = (ns: string, value: string) => (
    <span className="flex flex-col"><span>{label(ta0, ns, value)}</span><span lang={second} dir={getDirection(second)} className="text-[11px] text-muted-foreground">{label(tw0, ns, value)}</span></span>);
  const period = `${run.periodYear}-${String(run.periodMonth).padStart(2, '0')}-01`;
  const earn = slip.lines.filter((l) => Number(l.amount) > 0), ded = slip.lines.filter((l) => Number(l.amount) < 0);
  const money = (v: string | number) => f.money(Math.abs(Number(v)), run.currency);
  const row = (l: Run['staff'][number]['lines'][number], neg = false) => (
    <tr key={l.id} className="border-b border-hairline">
      <td className="py-2 pe-3">{bothLabel('lineType', l.type)}{lineNote(ta0, l.type, l.description) && <span className="text-[11px] text-muted-foreground">{lineNote(ta0, l.type, l.description)}</span>}</td>
      <td className={cn('py-2 text-end tabular', neg && 'text-critical')}>{neg ? '−' : ''}{money(l.amount)}</td>
    </tr>
  );

  return (
    <div className="min-h-dvh bg-background px-4 py-6 print:bg-white print:p-0">
      <div className="mx-auto mb-4 flex max-w-[210mm] items-center justify-between gap-3 print:hidden">
        <Link href={`/payroll/${runId}`} className="link">{tw('back', { section: ta('nav.payroll') })}</Link>
        <PrintButton label={ta('slip.print')} />
      </div>
      <article className="panel mx-auto max-w-[210mm] overflow-hidden print:rounded-none print:border-0">
        <header className="flex items-center justify-between gap-4 bg-header px-8 py-5 text-header-foreground print:[-webkit-print-color-adjust:exact] print:[print-color-adjust:exact]">
          <div className="flex items-center gap-3.5">
            <span aria-hidden="true" className="grid size-12 place-items-center rounded-full border-[1.5px] border-brass outline outline-1 outline-offset-[3px] outline-brass">
              <span className="font-display text-[15px] tracking-[0.06em] text-[#e6cf9c]">EFA</span>
            </span>
            <div><div className="font-display text-xl">{ta('office')}</div><div className="text-xs text-header-muted">{s.current.name}</div></div>
          </div>
          <div className="text-end">
            <div className="font-display text-2xl">{ta('slip.title')}</div>
            <div lang={second} className="text-xs text-header-muted">{tw('slip.title')}</div>
          </div>
        </header>
        <div className="grid gap-6 px-8 py-6">
          <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-4">
            <div><dt className="text-xs text-muted-foreground">{both('slip.employee')}</dt><dd className="font-semibold">{staff.name}{staff.fullName[second] && staff.fullName[second] !== staff.name ? <span className="block font-normal">{staff.fullName[second]}</span> : null}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{both('slip.role')}</dt><dd>{label(tl0, 'staffType', staff.staffType)}<span className="block text-xs text-muted-foreground">{label(tlw0, 'staffType', staff.staffType)}</span></dd></div>
            <div><dt className="text-xs text-muted-foreground">{both('slip.period')}</dt><dd className="font-semibold">{f.monthName(period)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{both('slip.payDate')}</dt><dd>{pay?.paidAt ? f.date(pay.paidAt) : '—'}</dd></div>
          </dl>
          <div className="grid gap-6 sm:grid-cols-2">
            <section><h2 className="mb-1 border-b-2 border-foreground pb-1 text-lg">{both('slip.earnings')}</h2>
              <table className="w-full border-collapse text-sm"><tbody>{earn.map((l) => row(l))}
                <tr><td className="pt-2 font-semibold">{both('slip.gross')}</td><td className="pt-2 text-end font-semibold tabular">{money(slip.gross)}</td></tr></tbody></table></section>
            <section><h2 className="mb-1 border-b-2 border-foreground pb-1 text-lg">{both('slip.deductions')}</h2>
              {ded.length === 0 ? <p className="py-2 text-sm text-muted-foreground">{both('slip.noDeductions')}</p> : (
                <table className="w-full border-collapse text-sm"><tbody>{ded.map((l) => row(l, true))}
                  <tr><td className="pt-2 font-semibold">{both('slip.totalDeductions')}</td><td className="pt-2 text-end font-semibold text-critical tabular">−{money(slip.deductions)}</td></tr></tbody></table>
              )}
              {ded.length > 0 && <p className="mt-2 text-[11px] text-muted-foreground">{ta('slip.capNote')}<span lang={second} className="block">{tw('slip.capNote')}</span></p>}</section>
          </div>
          <div className="flex items-center justify-between gap-4 rounded-lg bg-selected px-6 py-4 print:[-webkit-print-color-adjust:exact] print:[print-color-adjust:exact]">
            <span className="text-lg font-semibold">{both('slip.net')}</span>
            <span className="text-3xl font-bold text-primary tabular">{money(slip.net)}</span>
          </div>
          <dl className="grid gap-x-8 gap-y-3 border-t border-hairline pt-4 text-sm sm:grid-cols-3">
            <div><dt className="text-xs text-muted-foreground">{both('slip.channel')}</dt><dd>{pay ? <>{label(ta0, 'channel', pay.channel)}{pay.payoutLast4 ? <span dir="ltr"> •••• {pay.payoutLast4}</span> : null}</> : ta('slip.notPaid')}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{both('slip.reference')}</dt><dd>{pay?.externalRef ?? (pay?.proofFileId ? ta('slip.proofAttached') : '—')}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{both('slip.ack')}</dt><dd className={pay?.acknowledgedAt ? 'text-primary' : 'text-muted-foreground'}>{pay?.acknowledgedAt ? ta('slip.ackDone', { date: f.date(pay.acknowledgedAt) }) : ta('slip.ackPending')}</dd></div>
          </dl>
          <footer className="grid gap-6 border-t border-hairline pt-4 text-xs text-muted-foreground sm:grid-cols-2">
            <p>{ta('slip.footer')}<span lang={second} className="mt-1 block">{tw('slip.footer')}</span></p>
            <div className="flex items-end justify-end gap-8"><span className="w-40 border-t border-foreground pt-1 text-center">{both('slip.signature')}</span></div>
          </footer>
        </div>
      </article>
    </div>
  );
}
