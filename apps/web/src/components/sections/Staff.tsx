import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { apiGet } from '@/lib/api';
import { fmt } from '@/lib/fmt';
import { label, loose, today, type Rows } from '@/lib/sections';
import { cn } from '@/lib/utils';
import { Avatar, BarRows, Facts, ListDetail, Masked, Panel, RecordHeader, Table, Tabs, type Tone } from '../ListDetail';
import { SettlementStatement } from '../SettlementStatement';

type Opts = { household: string; locale: string };
interface Staff { id: string; membershipId: string | null; name: string; staffType: string; status: string; nationality: string | null; hireDate: string | null;
  probationEndsAt: string | null; payout: { defaultChannel: string | null; ibanLast4: string | null } }
interface Compliance { staffId: string; medical: { status: string; validUntil: string | null; daysLeft: number | null } }
interface Doc { id: string; type: string; numberLast4: string | null; expiryDate: string | null; daysLeft: number | null }
interface Contract { startDate: string; basicSalary: string; allowances: Array<{ code: string; amount: number }>; monthlyTotal: string; annualLeaveDays: number; isActive: boolean }
interface Leave { accruedDays: number; takenDays: number; balanceDays: number; availableNowDays: number; nextEntitlementDate: string; daysPerYear: number }
interface Pay { id: string; period: string; amount: string; channel: string; status: string }
interface Advance { id: string; issuedAt: string; granted: string; repaid: string; outstanding: string; monthlyInstallment: string; installmentsLeft: number }

const TABS = ['profile', 'settlement', 'leave', 'pay', 'documents'] as const;
const WORKING = ['ACTIVE', 'ON_PROBATION', 'ON_LEAVE'];
const medOk = (s?: string) => ['VALID', 'DUE_SOON', 'NOT_REQUIRED'].includes(s ?? '');
const daysTone = (d: number | null | undefined): Tone | undefined => (d == null ? undefined : d < 0 ? 'critical' : d <= 30 ? 'warning' : undefined);
const lastMonth = () => { const d = new Date(`${today()}T00:00:00Z`); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 }; };
/** Falls back to last month; the pulse's pay-day rule (28th) decides when the API answers. */

export async function StaffSection({ opts, id, tab }: { opts: Opts; id: string | null; tab: string | null }) {
  const [t0, tl0, f] = await Promise.all([getTranslations('ui'), getTranslations('lux'), fmt()]);
  const t = loose(t0);
  const lm = lastMonth();
  const due = (await apiGet<{ payroll?: { due: { year: number; month: number } } }>('/v1/dashboard/pulse', opts))?.payroll?.due;
  if (due) { lm.y = due.year; lm.m = due.month; }
  const [list, comp, monthPays, expiring] = await Promise.all([
    apiGet<Rows<Staff>>('/v1/staff', opts), apiGet<Rows<Compliance>>('/v1/compliance/staff', opts),
    apiGet<Rows<{ staffId: string; status: string }>>(`/v1/salary-payments?year=${lm.y}&month=${lm.m}`, opts),
    apiGet<Rows<{ daysLeft: number }>>('/v1/staff/documents/expiring', opts),
  ]);
  const staff = (list?.data ?? []).filter((s) => !['TERMINATED', 'FINAL_EXIT'].includes(s.status));
  const working = staff.filter((s) => WORKING.includes(s.status));
  const medical = new Map((comp?.data ?? []).map((c) => [c.staffId, c.medical]));
  const paid = new Set((monthPays?.data ?? []).filter((p) => p.status !== 'REVERSED').map((p) => p.staffId));
  const sel = id ? staff.find((s) => s.id === id) : staff[0];
  if (id && !sel) notFound();
  const tone = (s: Staff): Tone => (!medOk(medical.get(s.id)?.status) && medical.has(s.id) ? 'critical' : s.status === 'ON_LEAVE' ? 'muted' : s.status === 'ON_PROBATION' ? 'brass' : 'ok');
  const validMed = working.filter((s) => medOk(medical.get(s.id)?.status)).length;
  const paidCount = working.filter((s) => paid.has(s.id)).length;
  const docsDue = (expiring?.data ?? []).filter((d) => d.daysLeft <= 30).length;
  const month = f.monthName(`${lm.y}-${String(lm.m).padStart(2, '0')}-01`);

  const items = staff.map((s) => {
    const bad = tone(s) === 'critical';
    return { id: s.id, primary: s.name, lead: <Avatar name={s.name} tone={tone(s)} />, tone: bad ? 'critical' as const : undefined,
      secondary: `${label(tl0, 'staffType', s.staffType)} · ${bad ? t('staff.noMedical') : label(tl0, 'status', s.status)}`,
      trail: WORKING.includes(s.status) ? <span className={paid.has(s.id) ? 'text-primary' : 'text-critical'}>{paid.has(s.id) ? t('sec.paid') : t('sec.unpaid')}</span> : null };
  });

  let detail = null;
  if (sel) {
    const current = (TABS as readonly string[]).includes(tab ?? '') ? tab! : 'profile';
    const base = `/staff/${sel.id}`;
    const m = medical.get(sel.id);
    const [contracts, lb, esb, adv] = await Promise.all([
      apiGet<Rows<Contract>>(`/v1/staff/${sel.id}/contracts`, opts), apiGet<Leave>(`/v1/staff/${sel.id}/leave-balance`, opts),
      apiGet<{ vested: string }>(`/v1/staff/${sel.id}/end-of-service?asOf=${today()}`, opts), apiGet<Rows<Advance>>(`/v1/staff/${sel.id}/advances`, opts),
    ]);
    const c = contracts?.data.find((x) => x.isActive) ?? contracts?.data[0];
    const outstanding = (adv?.data ?? []).reduce((n, a) => n + Number(a.outstanding), 0);
    let body;
    if (current === 'profile') {
      const docs = await apiGet<Rows<Doc>>(`/v1/staff/${sel.id}/documents`, opts);
      const idDoc = docs?.data.find((d) => d.type === 'IQAMA') ?? docs?.data.find((d) => d.type === 'PASSPORT');
      body = (
        <>
          <div className="grid gap-6 xl:grid-cols-2">
            <Panel title={t('staff.person')}>
              <Facts rows={[
                [t('staff.role'), label(tl0, 'staffType', sel.staffType)],
                [t('staff.hired'), f.date(sel.hireDate)],
                sel.probationEndsAt ? [t('staff.probationEnds'), f.date(sel.probationEndsAt)] : null,
                [t('staff.nationality'), sel.nationality ?? '—'],
                [idDoc ? label(t0, 'doc', idDoc.type) : t('doc.IQAMA'), <Masked key="id" last4={idDoc?.numberLast4} none={t('notOnFile')} />],
                [t('staff.payout'), label(t0, 'channel', sel.payout.defaultChannel)],
                [t('staff.iban'), <Masked key="iban" last4={sel.payout.ibanLast4} none={t('notOnFile')} />],
                [t('staff.health'), t('encrypted')],
              ]} />
            </Panel>
            <Panel title={t('staff.contract')} note={c ? t('sec.since', { date: f.date(c.startDate) }) : undefined}>
              {c ? <Facts rows={[
                [t('staff.basic'), <span key="b" className="tabular">{f.money(c.basicSalary)}</span>],
                ...c.allowances.map((a): [string, ReactNode] => [label(t0, 'allowance', a.code), <span key={a.code} className="tabular">{f.money(a.amount)}</span>]),
                [t('staff.monthly'), <strong key="m" className="font-semibold tabular">{f.money(c.monthlyTotal)}</strong>],
                [t('staff.annualLeave'), t('daysCount', { count: c.annualLeaveDays })],
              ]} /> : <p className="text-muted-foreground">{t('staff.noContract')}</p>}
            </Panel>
          </div>
          <Panel title={t('sec.compliance')} footer={t('protectedNote')}>
            <BarRows rows={[
              { label: t('staff.medical'), value: m?.daysLeft ?? 0, max: 365, tone: medOk(m?.status) ? (daysTone(m?.daysLeft) ?? 'ok') : 'critical',
                text: m && m.daysLeft != null ? t('daysCount', { count: m.daysLeft }) : label(t0, 'medical', m?.status ?? 'MISSING'), textTone: medOk(m?.status) ? daysTone(m?.daysLeft) : 'critical' },
              ...(docs?.data ?? []).map((d) => ({ label: label(t0, 'doc', d.type), value: d.daysLeft ?? 0, max: 365, tone: daysTone(d.daysLeft) ?? 'ok' as Tone,
                text: d.daysLeft == null ? '—' : t('daysCount', { count: d.daysLeft }), textTone: daysTone(d.daysLeft) })),
            ]} />
          </Panel>
        </>
      );
    } else if (current === 'settlement') {
      body = <Panel title={t('staff.tab.settlement')} note={t('sec.settleNote')}><SettlementStatement workers={[{ id: sel.id, name: sel.name }]} initialStaffId={sel.id} defaultAsOf={today()} /></Panel>;
    } else if (current === 'leave') {
      body = lb ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Panel title={t('staff.leaveTitle')}>
            <BarRows rows={[
              { label: t('staff.accrued'), value: lb.accruedDays, max: Math.max(lb.accruedDays, 1), tone: 'ok', text: t('daysCount', { count: Math.round(lb.accruedDays * 10) / 10 }) },
              { label: t('staff.taken'), value: lb.takenDays, max: Math.max(lb.accruedDays, 1), tone: 'brass', text: t('daysCount', { count: lb.takenDays }) },
              { label: t('staff.balance'), value: lb.balanceDays, max: Math.max(lb.accruedDays, 1), tone: 'ok', text: t('daysCount', { count: Math.round(lb.balanceDays * 10) / 10 }), textTone: 'ok' },
            ]} />
          </Panel>
          <Panel title={t('sec.entitlement')}>
            <Facts rows={[
              [t('staff.availableNow'), t('daysCount', { count: lb.availableNowDays })],
              [t('staff.nextEntitlement'), f.date(lb.nextEntitlementDate)],
              [t('staff.rate'), t('staff.rateValue', { count: lb.daysPerYear })],
            ]} />
          </Panel>
        </div>
      ) : <p className="text-muted-foreground">{t('unavailable')}</p>;
    } else if (current === 'pay') {
      const pays = await apiGet<Rows<Pay>>(`/v1/staff/${sel.id}/salary-payments`, opts);
      const byPeriod = new Map((pays?.data ?? []).filter((p) => p.status !== 'REVERSED').map((p) => [p.period, p]));
      const months = Array.from({ length: 12 }, (_, i) => { const d = new Date(`${today()}T00:00:00Z`); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 11 + i); return d.toISOString().slice(0, 7); });
      const hired = (sel.hireDate ?? '9999').slice(0, 7);
      const thisMonth = today().slice(0, 7);
      body = (
        <>
          <Panel title={t('sec.twelveMonths')} note={t('sec.legend')}>
            <div className="grid grid-cols-6 gap-2 sm:grid-cols-12">
              {months.map((p) => {
                const pay = byPeriod.get(p), before = p < hired, open = p === thisMonth;
                const cls = pay ? (pay.status === 'DISPUTED' ? 'bg-critical-soft text-critical' : 'bg-selected text-primary') : before || open ? 'bg-muted text-muted-foreground' : 'bg-critical-soft text-critical';
                return (
                  <div key={p} className={cn('rounded-md px-1 py-2 text-center', cls)} title={pay ? label(t0, 'payStatus', pay.status) : undefined}>
                    <div className="text-xs">{f.monthShort(`${p}-01`)}</div>
                    <div className="text-xs font-bold">{pay ? '✓' : before ? '—' : open ? '…' : '✕'}</div>
                  </div>
                );
              })}
            </div>
          </Panel>
          <div className="grid gap-6 xl:grid-cols-2">
            <Panel title={t('staff.payments')}>
              <Table head={[t('staff.period'), t('staff.channel'), t('staff.paymentStatus'), t('amount')]} numeric={[3]} empty={t('staff.noPayments')}
                rows={(pays?.data ?? []).map((p) => [f.monthName(`${p.period}-01`), label(t0, 'channel', p.channel),
                  <span key="s" className={p.status === 'DISPUTED' ? 'text-critical' : p.status === 'RECORDED' ? 'text-muted-foreground' : 'text-primary'}>{label(t0, 'payStatus', p.status)}</span>, f.money(p.amount)])} />
            </Panel>
            <Panel title={t('staff.advances')}>
              {(adv?.data ?? []).length === 0 ? <p className="text-muted-foreground">{t('staff.noAdvances')}</p> : (adv?.data ?? []).map((a) => (
                <div key={a.id} className="flex flex-col gap-1.5 border-hairline py-1 [&+&]:border-t [&+&]:pt-3">
                  <div className="flex justify-between gap-3"><span>{t('sec.advanceOf', { amount: f.money(a.granted), date: f.dayMonth(a.issuedAt) })}</span>
                    <span className="tabular text-muted-foreground">{t('staff.installmentValue', { amount: f.money(a.monthlyInstallment), count: a.installmentsLeft })}</span></div>
                  <BarRows rows={[{ label: t('staff.repaid'), value: Number(a.repaid), max: Number(a.granted), tone: 'ok', text: `${f.money(a.repaid)} / ${f.money(a.granted)}` }]} />
                </div>
              ))}
            </Panel>
          </div>
        </>
      );
    } else {
      const docs = await apiGet<Rows<Doc>>(`/v1/staff/${sel.id}/documents`, opts);
      body = (
        <Panel title={t('staff.documents')} footer={t('protectedNote')}>
          {(docs?.data ?? []).length === 0 ? <p className="text-muted-foreground">{t('staff.noDocuments')}</p> : (
            <BarRows rows={(docs?.data ?? []).map((d) => ({ label: <span>{label(t0, 'doc', d.type)} <Masked last4={d.numberLast4} none="" /></span>, value: d.daysLeft ?? 0, max: 730,
              tone: daysTone(d.daysLeft) ?? 'ok' as Tone, text: d.expiryDate ? `${f.date(d.expiryDate)} · ${t('daysCount', { count: d.daysLeft ?? 0 })}` : '—', textTone: daysTone(d.daysLeft) }))} />
          )}
        </Panel>
      );
    }
    detail = (
      <>
        <RecordHeader title={sel.name} lead={<Avatar name={sel.name} tone={tone(sel)} size="lg" />}
          meta={`${label(tl0, 'staffType', sel.staffType)} · ${label(tl0, 'status', sel.status)}${sel.hireDate ? ` · ${t('staff.sinceDate', { date: f.date(sel.hireDate) })}` : ''}`}
          stats={[
            { label: t('staff.monthly'), value: c ? f.money(c.monthlyTotal) : '—' },
            { label: t('staff.balance'), value: lb ? t('daysCount', { count: Math.round(lb.balanceDays * 10) / 10 }) : '—' },
            { label: t('sec.esbToday'), value: esb ? f.money(esb.vested) : '—' },
            { label: t('staff.outstanding'), value: f.money(outstanding), tone: outstanding > 0 ? 'brass' : undefined },
          ]} />
        <Tabs base={base} current={current} tabs={TABS.map((k) => ({ key: k, label: t(`staff.tab.${k}`) }))} />
        {body}
      </>
    );
  }

  return <ListDetail title={t('nav.staff')} base="/staff" items={items} selectedId={sel?.id ?? null} explicit={!!id} detail={detail} empty={t('empty.staff')}
    summary={t('sec.staff.summary', { count: working.length, active: working.filter((s) => s.status === 'ACTIVE').length, probation: working.filter((s) => s.status === 'ON_PROBATION').length, onLeave: working.filter((s) => s.status === 'ON_LEAVE').length })}
    stats={[
      { label: t('sec.staff.workers'), value: f.num(working.length) },
      { label: t('home.medicalValid'), value: t('home.ofTotal', { count: validMed, total: working.length }), tone: validMed < working.length ? 'critical' : undefined },
      { label: t('home.paidLastMonth', { month }), value: t('home.ofTotal', { count: paidCount, total: working.length }), tone: paidCount < working.length ? 'critical' : undefined },
      { label: t('home.docsDue'), value: f.num(docsDue), tone: docsDue ? 'warning' : undefined },
    ]} />;
}
