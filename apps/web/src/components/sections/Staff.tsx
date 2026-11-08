import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { apiGet } from '@/lib/api';
import { fmt } from '@/lib/fmt';
import { label, today, type Rows } from '@/lib/sections';
import { Block, Facts, ListDetail, Masked, RecordHeader, Table, Tabs } from '../ListDetail';
import { SettlementStatement } from '../SettlementStatement';

type Opts = { household: string; locale: string };
interface Staff { id: string; membershipId: string | null; name: string; staffType: string; status: string; nationality: string | null; hireDate: string | null;
  probationEndsAt: string | null; weeklyDayOff: number | null; livesIn: boolean | null; payout: { defaultChannel: string | null; ibanLast4: string | null; walletRef: string | null } }
interface Compliance { staffId: string; medical: { status: string; validUntil: string | null; daysLeft: number | null } }
interface Doc { id: string; type: string; numberLast4: string | null; issuingCountry: string | null; expiryDate: string | null; daysLeft: number | null; heldByEmployer: boolean }
interface Contract { startDate: string; endDate: string | null; basicSalary: string; allowances: Array<{ code: string; amount: number }>; monthlyTotal: string; annualLeaveDays: number; isActive: boolean }
interface Leave { accruedDays: number; takenDays: number; balanceDays: number; availableNowDays: number; nextEntitlementDate: string; daysPerYear: number; byType?: Record<string, number> }
interface Pay { id: string; period: string; amount: string; channel: string; status: string; paidAt: string | null; payoutLast4: string | null }
interface Advance { id: string; issuedAt: string; granted: string; repaid: string; outstanding: string; monthlyInstallment: string; installmentsLeft: number }

const TABS = ['profile', 'settlement', 'leave', 'pay', 'documents'] as const;

export async function StaffSection({ opts, id, tab }: { opts: Opts; id: string | null; tab: string | null }) {
  const [t, tl, f] = await Promise.all([getTranslations('ui'), getTranslations('lux'), fmt()]);
  const [list, comp] = await Promise.all([apiGet<Rows<Staff>>('/v1/staff', opts), apiGet<Rows<Compliance>>('/v1/compliance/staff', opts)]);
  const staff = (list?.data ?? []).filter((s) => !['TERMINATED', 'FINAL_EXIT'].includes(s.status));
  const medical = new Map((comp?.data ?? []).map((c) => [c.staffId, c.medical]));
  const sel = id ? staff.find((s) => s.id === id) : staff[0];
  if (id && !sel) notFound();

  const items = staff.map((s) => {
    const m = medical.get(s.id);
    const noMedical = m && m.status !== 'VALID' && m.status !== 'DUE_SOON';
    return { id: s.id, primary: s.name,
      secondary: noMedical ? `${label(tl, 'staffType', s.staffType)} · ${t('staff.noMedical')}` : `${label(tl, 'staffType', s.staffType)} · ${label(tl, 'status', s.status)}`,
      tone: noMedical ? 'critical' as const : undefined };
  });

  let detail = null;
  if (sel) {
    const current = (TABS as readonly string[]).includes(tab ?? '') ? tab! : 'profile';
    const base = `/staff/${sel.id}`;
    const m = medical.get(sel.id);
    let body;
    if (current === 'profile') {
      const [docs, contracts] = await Promise.all([apiGet<Rows<Doc>>(`/v1/staff/${sel.id}/documents`, opts), apiGet<Rows<Contract>>(`/v1/staff/${sel.id}/contracts`, opts)]);
      const idDoc = docs?.data.find((d) => d.type === 'IQAMA') ?? docs?.data.find((d) => d.type === 'PASSPORT');
      const c = contracts?.data.find((x) => x.isActive) ?? contracts?.data[0];
      body = (
        <div className="grid gap-10 xl:grid-cols-2">
          <Block title={t('staff.person')}>
            <Facts rows={[
              [t('staff.role'), label(tl, 'staffType', sel.staffType)],
              [t('staff.status'), label(tl, 'status', sel.status)],
              [t('staff.hired'), f.date(sel.hireDate)],
              sel.probationEndsAt ? [t('staff.probationEnds'), f.date(sel.probationEndsAt)] : null,
              [t('staff.nationality'), sel.nationality ?? '—'],
              [idDoc ? label(t, 'doc', idDoc.type) : t('doc.IQAMA'), <Masked key="id" last4={idDoc?.numberLast4} none={t('notOnFile')} />],
              [t('staff.payout'), label(t, 'channel', sel.payout.defaultChannel)],
              [t('staff.iban'), <Masked key="iban" last4={sel.payout.ibanLast4} none={t('notOnFile')} />],
              [t('staff.medical'), m ? <span key="m" className={m.status === 'VALID' ? undefined : 'text-critical'}>{label(t, 'medical', m.status)}{m.validUntil ? ` · ${f.date(m.validUntil)}` : ''}</span> : '—'],
              [t('staff.health'), t('encrypted')],
            ]} />
          </Block>
          <Block title={t('staff.contract')}>
            {c ? <Facts rows={[
              [t('staff.basic'), f.money(c.basicSalary)],
              ...c.allowances.map((a): [string, string] => [label(t, 'allowance', a.code), f.money(a.amount)]),
              [t('staff.monthly'), <strong key="m" className="font-semibold">{f.money(c.monthlyTotal)}</strong>],
              [t('staff.annualLeave'), t('daysCount', { count: c.annualLeaveDays })],
              [t('staff.since'), f.date(c.startDate)],
            ]} /> : <p className="text-muted-foreground">{t('staff.noContract')}</p>}
          </Block>
          <p className="text-xs text-muted-foreground xl:col-span-2">{t('protectedNote')}</p>
        </div>
      );
    } else if (current === 'settlement') {
      body = <SettlementStatement workers={[{ id: sel.id, name: sel.name }]} initialStaffId={sel.id} defaultAsOf={today()} />;
    } else if (current === 'leave') {
      const lb = await apiGet<Leave>(`/v1/staff/${sel.id}/leave-balance`, opts);
      body = lb ? (
        <Block title={t('staff.leaveTitle')}>
          <Facts rows={[
            [t('staff.accrued'), t('daysCount', { count: Math.round(lb.accruedDays * 10) / 10 })],
            [t('staff.taken'), t('daysCount', { count: lb.takenDays })],
            [t('staff.balance'), <strong key="b" className="font-semibold">{t('daysCount', { count: Math.round(lb.balanceDays * 10) / 10 })}</strong>],
            [t('staff.availableNow'), t('daysCount', { count: lb.availableNowDays })],
            [t('staff.nextEntitlement'), f.date(lb.nextEntitlementDate)],
            [t('staff.rate'), t('staff.rateValue', { count: lb.daysPerYear })],
          ]} />
        </Block>
      ) : <p className="text-muted-foreground">{t('unavailable')}</p>;
    } else if (current === 'pay') {
      const [pays, adv] = await Promise.all([apiGet<Rows<Pay>>(`/v1/staff/${sel.id}/salary-payments`, opts), apiGet<Rows<Advance>>(`/v1/staff/${sel.id}/advances`, opts)]);
      body = (
        <div className="grid gap-10">
          <Block title={t('staff.payments')}>
            <Table head={[t('staff.period'), t('staff.channel'), t('staff.paymentStatus'), t('amount')]} numeric={[3]} empty={t('staff.noPayments')}
              rows={(pays?.data ?? []).map((p) => [p.period, label(t, 'channel', p.channel),
                <span key="s" className={p.status === 'DISPUTED' ? 'text-critical' : p.status === 'RECORDED' ? 'text-muted-foreground' : undefined}>{label(t, 'payStatus', p.status)}</span>, f.money(p.amount)])} />
          </Block>
          <Block title={t('staff.advances')}>
            <Table head={[t('staff.issued'), t('staff.granted'), t('staff.repaid'), t('staff.outstanding'), t('staff.installment')]} numeric={[1, 2, 3, 4]} empty={t('staff.noAdvances')}
              rows={(adv?.data ?? []).map((a) => [f.date(a.issuedAt), f.money(a.granted), f.money(a.repaid), f.money(a.outstanding),
                t('staff.installmentValue', { amount: f.money(a.monthlyInstallment), count: a.installmentsLeft })])} />
          </Block>
        </div>
      );
    } else {
      const docs = await apiGet<Rows<Doc>>(`/v1/staff/${sel.id}/documents`, opts);
      body = (
        <Block title={t('staff.documents')}>
          <Table head={[t('staff.docType'), t('staff.number'), t('staff.expires'), t('staff.daysLeft')]} numeric={[3]} empty={t('staff.noDocuments')}
            rows={(docs?.data ?? []).map((d) => [label(t, 'doc', d.type), <Masked key="n" last4={d.numberLast4} none="—" />, f.date(d.expiryDate),
              d.daysLeft == null ? '—' : <span key="d" className={d.daysLeft < 0 ? 'text-critical' : d.daysLeft <= 30 ? 'text-warning' : undefined}>{f.num(d.daysLeft)}</span>])} />
          <p className="mt-3 text-xs text-muted-foreground">{t('protectedNote')}</p>
        </Block>
      );
    }
    detail = (
      <>
        <RecordHeader title={sel.name} meta={`${label(tl, 'staffType', sel.staffType)} · ${label(tl, 'status', sel.status)}${sel.hireDate ? ` · ${t('staff.sinceDate', { date: f.date(sel.hireDate) })}` : ''}`} />
        <Tabs base={base} current={current} tabs={TABS.map((k) => ({ key: k, label: t(`staff.tab.${k}`) }))} />
        {body}
      </>
    );
  }

  return <ListDetail title={t('nav.staff')} base="/staff" items={items} selectedId={sel?.id ?? null} explicit={!!id} detail={detail} empty={t('empty.staff')} />;
}
