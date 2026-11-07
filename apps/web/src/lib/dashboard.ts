import 'server-only';
import { notFound } from 'next/navigation';
import { apiGet, authToken, currentTenantSlug, requestHost, resolveHousehold } from './api';
import { tenantOrigin } from './config';

export type Severity = 'critical' | 'warning' | 'info';
/** `origin` is set when tenant subdomains are configured: the switcher then links to https://<slug>.<base>. */
export interface Household { id: string; name: string; role: string; badge: string; tone: 'emerald' | 'gold' | 'platinum'; origin?: string | null }
export interface StaffRow {
  id: string; name: string; staffType: string; status: string; hireDate: string | null;
  identity: { type: string; last4: string | null } | null; ibanLast4: string | null;
}
export interface VehicleCard {
  id: string; make: string; model: string; year: number; plateNumber: string; plateNumberAr: string | null; odometerKm: number; status: string;
  docs: Array<{ doc: 'REGISTRATION' | 'INSURANCE' | 'INSPECTION'; daysLeft: number }>;
  maintenance: Array<{ type: string; status: 'OK' | 'DUE_SOON' | 'OVERDUE' | 'INACTIVE'; kmLeft: number | null; daysLeft: number | null }>;
  drivers: number;
}
export interface Dashboard {
  mode: 'live' | 'sample';
  households: Household[]; current: Household;
  attention: Array<{ severity: Severity; key: string; count: number; deepLink: string }>;
  medical: { workers: number; needsAction: number };
  staff: StaffRow[];
  vehicles: VehicleCard[];
  esb: { totalVested: string; totalProvision: string; workers: number };
}

const TONES: Household['tone'][] = ['emerald', 'gold', 'platinum'];
/** "EFA Private Office" → EFA; "AFA Household" → AFA; else initials. */
export function badgeFor(name: string) {
  const acronym = name.match(/\b[A-Z]{2,4}\b/)?.[0];
  if (acronym) return acronym;
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '•';
}
const household = (id: string, name: string, role: string, i: number, origin?: string | null): Household =>
  ({ id, name, role, badge: badgeFor(name), tone: TONES[i % TONES.length]!, origin });

interface PulseResponse {
  attention: Dashboard['attention'];
  medical: { workers: number; overdue: number; missing: number; dueSoon: number };
}
interface StaffResponse { data: Array<{ id: string; name: string; staffType: string; status: string; hireDate: string | null; payout: { ibanLast4: string | null } }> }
interface DocsResponse { data: Array<{ type: string; numberLast4: string | null }> }
interface VehicleResponse {
  id: string; make: string; model: string; year: number; plateNumber: string; plateNumberAr: string | null; odometerKm: number; status: string;
  registration: { daysLeft?: number | null }; insurance: { daysLeft?: number | null }; inspection: { daysLeft?: number | null };
  maintenance?: VehicleCard['maintenance']; drivers?: unknown[];
}

/**
 * Everything the executive dashboard shows, read from the API under the user's
 * session and the active household. Falls back to a labelled sample when no API
 * session is configured (the page says "Sample data").
 */
export async function loadDashboard(locale: string): Promise<Dashboard> {
  const ctx = await resolveHousehold(locale);
  // A tenant subdomain the signed-in user is not a member of: 404, never another household's data or a sample.
  if (!ctx) { if (await authToken() && await currentTenantSlug()) notFound(); return SAMPLE; }
  const host = await requestHost();
  const households = ctx.households.map((h, i) => household(h.householdId, h.name, h.role, i, tenantOrigin(h.slug, host)));
  const current = households.find((h) => h.id === ctx.id)!;
  const opts = { household: current.id, locale };
  const [pulse, staff, vehicles, esb] = await Promise.all([
    apiGet<PulseResponse>('/v1/dashboard/pulse', opts),
    apiGet<StaffResponse>('/v1/staff', opts),
    apiGet<{ data: VehicleResponse[] }>('/v1/vehicles', opts),
    apiGet<{ totalVested: string; totalProvision: string; workers: number }>('/v1/hr/end-of-service', opts),
  ]);
  const staffRows = await Promise.all((staff?.data ?? []).filter((s) => !['TERMINATED', 'FINAL_EXIT'].includes(s.status)).map(async (s): Promise<StaffRow> => {
    // Data minimisation: only the identity document list (last 4 + type). The health record is never fetched
    // here: reading it decrypts it, and the dashboard only signals that it is protected.
    const docs = await apiGet<DocsResponse>(`/v1/staff/${s.id}/documents`, opts);
    const id = docs?.data.find((d) => d.type === 'IQAMA') ?? docs?.data.find((d) => d.type === 'PASSPORT') ?? null;
    return { id: s.id, name: s.name, staffType: s.staffType, status: s.status, hireDate: s.hireDate, ibanLast4: s.payout.ibanLast4,
             identity: id ? { type: id.type, last4: id.numberLast4 } : null };
  }));
  const vehicleCards = await Promise.all((vehicles?.data ?? []).map(async (v): Promise<VehicleCard> => {
    const full = await apiGet<VehicleResponse>(`/v1/vehicles/${v.id}`, opts);
    const docs = ([['REGISTRATION', v.registration.daysLeft], ['INSURANCE', v.insurance.daysLeft], ['INSPECTION', v.inspection.daysLeft]] as const)
      .filter(([, d]) => d != null).map(([doc, d]) => ({ doc, daysLeft: d as number }));
    return { id: v.id, make: v.make, model: v.model, year: v.year, plateNumber: v.plateNumber, plateNumberAr: v.plateNumberAr, odometerKm: v.odometerKm, status: v.status,
             docs, maintenance: full?.maintenance ?? [], drivers: full?.drivers?.length ?? 0 };
  }));
  return {
    mode: 'live', households, current,
    // The API's keys are message ids ('pulse.medicalOverdue'); the UI adds the namespace itself.
    attention: (pulse?.attention ?? []).map((a) => ({ ...a, key: a.key.replace(/^pulse\./, '') })),
    medical: { workers: pulse?.medical.workers ?? 0, needsAction: (pulse?.medical.overdue ?? 0) + (pulse?.medical.missing ?? 0) },
    staff: staffRows, vehicles: vehicleCards,
    esb: esb ?? { totalVested: '0.00', totalProvision: '0.00', workers: 0 },
  };
}

/** Shown when no API session is configured; clearly labelled "Sample data" in the UI. */
export const SAMPLE: Dashboard = {
  mode: 'sample',
  households: [household('sample-efa', 'EFA Private Office', 'EFA office', 0), household('sample-afa', 'AFA Household', 'EFA office', 1)],
  current: household('sample-efa', 'EFA Private Office', 'EFA office', 0),
  attention: [
    { severity: 'critical', key: 'medicalOverdue', count: 1, deepLink: '/compliance/staff' },
    { severity: 'warning', key: 'vehicleDocsDue', count: 1, deepLink: '/fleet/overview' },
    { severity: 'warning', key: 'approvalsWaiting', count: 2, deepLink: '/requests' },
    { severity: 'info', key: 'pettyCashToReview', count: 3, deepLink: '/petty-cash' },
  ],
  medical: { workers: 5, needsAction: 1 },
  staff: [
    { id: 's1', name: 'Rahim Uddin', staffType: 'DRIVER', status: 'ACTIVE', hireDate: '2021-03-01', identity: { type: 'IQAMA', last4: '4821' }, ibanLast4: '0123' },
    { id: 's2', name: 'Maria Santos', staffType: 'HOUSEMAID', status: 'ACTIVE', hireDate: '2022-06-15', identity: { type: 'IQAMA', last4: '7710' }, ibanLast4: null },
    { id: 's3', name: 'Sunita Rao', staffType: 'COOK', status: 'ON_LEAVE', hireDate: '2020-01-10', identity: { type: 'IQAMA', last4: '3305' }, ibanLast4: '9902' },
    { id: 's4', name: 'Tigist Bekele', staffType: 'NANNY', status: 'ACTIVE', hireDate: '2024-09-01', identity: { type: 'PASSPORT', last4: '5518' }, ibanLast4: null },
    { id: 's5', name: 'Samir Hassan', staffType: 'GARDENER', status: 'ON_PROBATION', hireDate: '2026-08-20', identity: null, ibanLast4: null },
  ],
  vehicles: [
    { id: 'v1', make: 'GMC', model: 'Yukon Denali', year: 2024, plateNumber: 'ABC 1234', plateNumberAr: 'أ ب ح ١٢٣٤', odometerKm: 38410, status: 'ACTIVE',
      docs: [{ doc: 'REGISTRATION', daysLeft: 212 }, { doc: 'INSURANCE', daysLeft: 24 }, { doc: 'INSPECTION', daysLeft: 140 }],
      maintenance: [{ type: 'OIL_CHANGE', status: 'DUE_SOON', kmLeft: 590, daysLeft: 40 }], drivers: 1 },
    { id: 'v2', make: 'Toyota', model: 'Camry', year: 2023, plateNumber: 'XYZ 5678', plateNumberAr: 'ص ي ز ٥٦٧٨', odometerKm: 61200, status: 'ACTIVE',
      docs: [{ doc: 'REGISTRATION', daysLeft: 301 }, { doc: 'INSURANCE', daysLeft: 188 }, { doc: 'INSPECTION', daysLeft: 77 }],
      maintenance: [{ type: 'TIRES', status: 'OK', kmLeft: 4300, daysLeft: null }], drivers: 1 },
  ],
  esb: { totalVested: '9200.00', totalProvision: '21462.50', workers: 5 },
};
