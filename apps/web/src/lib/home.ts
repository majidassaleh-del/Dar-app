import 'server-only';
import { apiGet } from './api';
import { SAMPLE, loadSession, type Session } from './dashboard';
import { people, today, type Rows } from './sections';

export type Tone = 'critical' | 'warning' | 'task';
export type Decision =
  | { kind: 'unpaid'; names: string[]; paid: number; total: number; period: string }
  | { kind: 'medical'; staffId: string; name: string; staffType: string; status: string; since: string | null }
  | { kind: 'request'; id: string; type: string; name: string; amount: string | null; currency: string; createdAt: string;
      installments?: number; reason?: string; leaveType?: string; from?: string; to?: string };
export interface Upcoming { tone: Tone; days: number; kind: 'task' | 'staffDoc' | 'vehicleDoc' | 'service'; label: string; who?: string; doc?: string; km?: number; href: string }
export interface Car { id: string; name: string; year: number; plate: string; plateAr: string | null; km: number; driver: string | null;
  docs: Array<{ doc: 'REGISTRATION' | 'INSURANCE' | 'INSPECTION'; days: number | null }> }
export interface Home {
  session: Session;
  decisions: Decision[];
  info: Array<{ key: string; count: number; section: string | null }>;
  upcoming: Upcoming[]; offAxis: Upcoming[];
  cars: Car[];
  workforce: { total: number; active: number; probation: number; onLeave: number; medicalValid: number; docsDue: number };
  money: { account: { name: string; balance: string } | null; week: { amount: number; count: number }; float: { name: string; holder: string; balance: string; limit: string } | null;
           esb: { provision: string; vested: string } };
  team: Array<{ id: string; name: string; staffType: string; status: string; alert: boolean }>;
}

const DAY = 86_400_000;
const daysUntil = (iso: string, from = today()) => Math.round((Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
const lastMonth = () => { const d = new Date(`${today()}T00:00:00Z`); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, end: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10) }; };
const WORKING = ['ACTIVE', 'ON_PROBATION', 'ON_LEAVE'];
const OPEN = ['SUBMITTED', 'IN_REVIEW'];
const DONE = ['COMPLETED', 'VERIFIED', 'CANCELLED'];
const sectionOf = (link: string) => {
  const p = link.replace(/^herp:\/\//, '');
  if (p.startsWith('petty-cash')) return 'petty-cash';
  if (/^(funding-clearing|budgets|transactions)/.test(p)) return 'finance';
  if (/^(staff|compliance|salary-payments|payroll-runs)/.test(p)) return 'staff';
  if (p.startsWith('fleet')) return 'fleet';
  if (p.startsWith('work-orders')) return 'work-orders';
  if (p.startsWith('requests')) return 'requests';
  return null;
};

interface Staff { id: string; membershipId: string | null; name: string; staffType: string; status: string; hireDate: string | null }
interface Vehicle { id: string; make: string; model: string; year: number; plateNumber: string; plateNumberAr: string | null; odometerKm: number;
  registration: { daysLeft?: number | null }; insurance: { daysLeft?: number | null }; inspection: { daysLeft?: number | null };
  drivers?: Array<{ driverId: string; isPrimary: boolean }>; maintenance?: Array<{ type: string; daysLeft: number | null; kmLeft: number | null }> }

export async function loadHome(locale: string): Promise<Home> {
  const session = await loadSession(locale);
  if (!session.opts) return sampleHome(session);
  const opts = session.opts;
  const lm = lastMonth();
  const [pulse, staffR, comp, pays, reqs, wos, docs, vehs, accts, txs, floats, esb, names] = await Promise.all([
    apiGet<{ attention: Array<{ severity: string; key: string; count: number; deepLink: string }> }>('/v1/dashboard/pulse', opts),
    apiGet<Rows<Staff>>('/v1/staff', opts),
    apiGet<Rows<{ staffId: string; medical: { status: string } }>>('/v1/compliance/staff', opts),
    apiGet<Rows<{ staffId: string; status: string }>>(`/v1/salary-payments?year=${lm.y}&month=${lm.m}`, opts),
    apiGet<Rows<{ id: string; type: string; status: string; requesterId: string; amount: string | null; currency: string; createdAt: string; payload: Record<string, unknown> | null }>>('/v1/requests', opts),
    apiGet<Rows<{ id: string; title: string; status: string; dueAt: string | null; assigneeId: string | null }>>('/v1/work-orders', opts),
    apiGet<Rows<{ type: string; daysLeft: number; staff: { id: string; name: string } }>>('/v1/staff/documents/expiring', opts),
    apiGet<Rows<Vehicle>>('/v1/vehicles', opts),
    apiGet<Rows<{ name: string; balance: string; isActive: boolean; type: string }>>('/v1/accounts', opts),
    apiGet<Rows<{ type: string; amount: string; occurredAt: string; status: string }>>('/v1/transactions', opts),
    apiGet<Rows<{ name: string; custodianId: string; balance: string; floatLimit: string; isActive: boolean }>>('/v1/petty-cash', opts),
    apiGet<{ totalVested: string; totalProvision: string }>('/v1/hr/end-of-service', opts),
    people(opts),
  ]);
  const staff = (staffR?.data ?? []).filter((s) => WORKING.includes(s.status));
  const medical = new Map((comp?.data ?? []).map((c) => [c.staffId, c.medical.status]));
  const medOk = (id: string) => ['VALID', 'DUE_SOON', 'NOT_REQUIRED'].includes(medical.get(id) ?? '');

  // Needs your decision: unpaid salaries, missing medicals, open requests.
  const decisions: Decision[] = [];
  const paidIds = new Set((pays?.data ?? []).filter((p) => p.status !== 'REVERSED').map((p) => p.staffId));
  const due = staff.filter((s) => s.hireDate && s.hireDate <= lm.end);
  const unpaid = due.filter((s) => !paidIds.has(s.id));
  if (unpaid.length) decisions.push({ kind: 'unpaid', names: unpaid.map((s) => s.name), paid: due.length - unpaid.length, total: due.length, period: `${lm.y}-${String(lm.m).padStart(2, '0')}-01` });
  for (const s of staff) if (medical.has(s.id) && !medOk(s.id)) decisions.push({ kind: 'medical', staffId: s.id, name: s.name, staffType: s.staffType, status: s.status, since: s.hireDate });
  for (const r of (reqs?.data ?? []).filter((x) => OPEN.includes(x.status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const p = (r.payload ?? {}) as Record<string, string | number | undefined>;
    decisions.push({ kind: 'request', id: r.id, type: r.type, name: names.get(r.requesterId) ?? '—', amount: r.amount, currency: r.currency, createdAt: r.createdAt,
      installments: p.installments != null ? Number(p.installments) : undefined, reason: p.reason ? String(p.reason) : undefined,
      leaveType: p.leaveType ? String(p.leaveType) : undefined, from: p.startDate ? String(p.startDate) : undefined, to: p.endDate ? String(p.endDate) : undefined });
  }
  const info = (pulse?.attention ?? []).filter((a) => a.severity === 'info').map((a) => ({ key: a.key.replace(/^pulse\./, ''), count: a.count, section: sectionOf(a.deepLink) }));

  // The next 30 days.
  const cars: Car[] = [];
  const upcoming: Upcoming[] = [], offAxis: Upcoming[] = [];
  for (const w of wos?.data ?? []) {
    if (!w.dueAt || DONE.includes(w.status)) continue;
    const d = daysUntil(w.dueAt);
    if (d <= 30) upcoming.push({ tone: d < 0 ? 'critical' : 'task', days: Math.max(0, d), kind: 'task', label: w.title, who: w.assigneeId ? names.get(w.assigneeId) : undefined, href: `/work-orders/${w.id}` });
  }
  for (const doc of docs?.data ?? []) if (doc.daysLeft >= 0 && doc.daysLeft <= 30)
    upcoming.push({ tone: 'critical', days: doc.daysLeft, kind: 'staffDoc', label: doc.staff.name, doc: doc.type, href: `/staff/${doc.staff.id}?tab=documents` });
  const vehicles = await Promise.all((vehs?.data ?? []).map((v) => apiGet<Vehicle>(`/v1/vehicles/${v.id}`, opts).then((full) => full ?? v)));
  for (const v of vehicles) {
    const name = `${v.make} ${v.model}`;
    const docsOf: Car['docs'] = [{ doc: 'REGISTRATION', days: v.registration.daysLeft ?? null }, { doc: 'INSURANCE', days: v.insurance.daysLeft ?? null }, { doc: 'INSPECTION', days: v.inspection.daysLeft ?? null }];
    for (const d of docsOf) if (d.days != null && d.days >= 0 && d.days <= 30) upcoming.push({ tone: 'warning', days: d.days, kind: 'vehicleDoc', label: name, doc: d.doc, href: `/fleet/${v.id}` });
    for (const m of v.maintenance ?? []) {
      if (m.daysLeft != null && m.daysLeft <= 30) upcoming.push({ tone: 'warning', days: Math.max(0, m.daysLeft), kind: 'service', label: name, doc: m.type, href: `/fleet/${v.id}` });
      else if (m.kmLeft != null && m.kmLeft <= 1000) offAxis.push({ tone: 'warning', days: 0, kind: 'service', label: name, doc: m.type, km: Math.max(0, m.kmLeft), href: `/fleet/${v.id}` });
    }
    const primary = v.drivers?.find((x) => x.isPrimary) ?? v.drivers?.[0];
    cars.push({ id: v.id, name, year: v.year, plate: v.plateNumber, plateAr: v.plateNumberAr, km: v.odometerKm, driver: primary ? names.get(primary.driverId) ?? null : null, docs: docsOf });
  }
  upcoming.sort((a, b) => a.days - b.days);

  const weekAgo = new Date(Date.now() - 7 * DAY).toISOString();
  const spent = (txs?.data ?? []).filter((x) => x.type === 'EXPENSE' && x.status !== 'REVERSED' && x.occurredAt >= weekAgo);
  const account = (accts?.data ?? []).find((a) => a.isActive && a.type.startsWith('BANK')) ?? null;
  const float = (floats?.data ?? []).find((x) => x.isActive) ?? null;
  return {
    session, decisions, info, upcoming, offAxis, cars,
    workforce: { total: staff.length, active: staff.filter((s) => s.status === 'ACTIVE').length, probation: staff.filter((s) => s.status === 'ON_PROBATION').length,
                 onLeave: staff.filter((s) => s.status === 'ON_LEAVE').length, medicalValid: staff.filter((s) => medOk(s.id)).length,
                 docsDue: (docs?.data ?? []).filter((d) => d.daysLeft <= 30).length },
    money: { account: account ? { name: account.name, balance: account.balance } : null,
             week: { amount: spent.reduce((n, x) => n + Number(x.amount), 0), count: spent.length },
             float: float ? { name: float.name, holder: names.get(float.custodianId) ?? '—', balance: float.balance, limit: float.floatLimit } : null,
             esb: { provision: esb?.totalProvision ?? '0', vested: esb?.totalVested ?? '0' } },
    team: staff.map((s) => ({ id: s.id, name: s.name, staffType: s.staffType, status: s.status, alert: medical.has(s.id) && !medOk(s.id) })),
  };
}

/** Without an API session: the same page from the labelled sample. */
function sampleHome(session: Session): Home {
  const st = SAMPLE.staff;
  const cars = SAMPLE.vehicles.map((v) => ({ id: v.id, name: `${v.make} ${v.model}`, year: v.year, plate: v.plateNumber, plateAr: v.plateNumberAr, km: v.odometerKm, driver: st[0]!.name,
    docs: v.docs.map((d) => ({ doc: d.doc, days: d.daysLeft })) }));
  const upcoming: Upcoming[] = SAMPLE.vehicles.flatMap((v) => v.docs.filter((d) => d.daysLeft <= 30)
    .map((d) => ({ tone: 'warning' as const, days: d.daysLeft, kind: 'vehicleDoc' as const, label: `${v.make} ${v.model}`, doc: d.doc, href: '/fleet' })));
  return {
    session, info: [], upcoming, cars,
    offAxis: [{ tone: 'warning', days: 0, kind: 'service', label: `${SAMPLE.vehicles[0]!.make} ${SAMPLE.vehicles[0]!.model}`, doc: 'OIL_CHANGE', km: 590, href: '/fleet' }],
    decisions: [{ kind: 'medical', staffId: 's5', name: st[4]!.name, staffType: st[4]!.staffType, status: st[4]!.status, since: st[4]!.hireDate }],
    workforce: { total: st.length, active: st.filter((s) => s.status === 'ACTIVE').length, probation: st.filter((s) => s.status === 'ON_PROBATION').length,
                 onLeave: st.filter((s) => s.status === 'ON_LEAVE').length, medicalValid: SAMPLE.medical.workers - SAMPLE.medical.needsAction, docsDue: 0 },
    money: { account: null, week: { amount: 0, count: 0 }, float: null, esb: { provision: SAMPLE.esb.totalProvision, vested: SAMPLE.esb.totalVested } },
    team: st.map((s) => ({ id: s.id, name: s.name, staffType: s.staffType, status: s.status, alert: s.id === 's5' })),
  };
}
