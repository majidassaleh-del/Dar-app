import type { Tx } from '../db/prisma.service';

/**
 * End-of-service benefit (مكافأة نهاية الخدمة) for domestic workers.
 *
 * Source: لائحة عمال الخدمة المنزلية ومن في حكمهم (Council of Ministers Decision
 * 310 of 7/9/1434H), Article 16. A worker who completes four consecutive years
 * with the same employer is owed one month's wage. Published commentary reads
 * the article in two ways, so both are offered and the contract chooses
 * (EmploymentContract.endOfServiceRule):
 *
 *  - SA_DOMESTIC (default, confirmed by the household 2026-11-04 as the primary
 *    strategy): one month's wage for every completed 4-year period
 *    (the reading most commentators use; it is also the safer one for an employer in a
 *    dispute).
 *  - SA_DOMESTIC_SINGLE: one month's wage once 4 consecutive years are reached.
 *  - SA_LABOR_LAW: contracts that grant the general Labor Law formula (Art. 84):
 *    half a month per year for the first five years, a full month per year after,
 *    pro rata for part years. Resignation reductions (Art. 85) are NOT applied.
 *
 * Wage basis: the last contractual monthly wage (basic + fixed allowances).
 * Service: the latest unbroken chain of contracts (a gap of more than one day
 * breaks it), up to `asOf` or the contract end, minus unpaid leave days.
 * Amounts are computed in halalas and rounded half-up.
 */
export type EsbRule = 'SA_DOMESTIC' | 'SA_DOMESTIC_SINGLE' | 'SA_LABOR_LAW';
export interface EsbContract { startDate: Date; endDate: Date | null; basicSalary: number; allowances: Array<{ code: string; amount: number }> }

const DAY = 86_400_000;
const FOUR_YEARS = 1461; // days, including one leap day
const YEAR = 365.25;

export const monthlyWage = (c: Pick<EsbContract, 'basicSalary' | 'allowances'>) =>
  Math.round(c.basicSalary * 100) + c.allowances.reduce((s, a) => s + Math.round(Math.max(0, a.amount) * 100), 0); // halalas

const toSar = (h: number) => (Math.round(h) / 100).toFixed(2);
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function computeEsb(input: { rule?: string; contracts: EsbContract[]; asOf: Date; unpaidLeaveDays?: number }) {
  const rule: EsbRule = input.rule === 'SA_DOMESTIC_SINGLE' || input.rule === 'SA_LABOR_LAW' ? input.rule : 'SA_DOMESTIC';
  const cs = [...input.contracts].filter((c) => c.startDate <= input.asOf).sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
  if (!cs.length) return null;
  // Latest unbroken chain.
  let start = cs[0]!.startDate, end = cs[0]!.endDate;
  for (const c of cs.slice(1)) {
    if (end && c.startDate.getTime() - end.getTime() > DAY) start = c.startDate;
    end = !end || !c.endDate ? (c.endDate ?? null) : (c.endDate > end ? c.endDate : end);
  }
  const last = cs[cs.length - 1]!;
  const until = end && end < input.asOf ? end : input.asOf;
  const calendarDays = Math.max(0, Math.round((until.getTime() - start.getTime()) / DAY) + 1);
  const unpaid = Math.min(calendarDays, Math.max(0, Math.round(input.unpaidLeaveDays ?? 0)));
  const serviceDays = calendarDays - unpaid;
  const wage = monthlyWage(last);

  let vested = 0, provision = 0, nextVestingDate: string | null = null, completedPeriods = 0;
  if (rule === 'SA_LABOR_LAW') {
    const years = serviceDays / YEAR;
    vested = wage * (Math.min(years, 5) * 0.5 + Math.max(0, years - 5));
    provision = vested;
  } else {
    completedPeriods = Math.floor(serviceDays / FOUR_YEARS);
    const counted = rule === 'SA_DOMESTIC_SINGLE' ? Math.min(completedPeriods, 1) : completedPeriods;
    vested = wage * counted;
    provision = rule === 'SA_DOMESTIC_SINGLE' ? wage * Math.min(serviceDays / FOUR_YEARS, 1) : (wage * serviceDays) / FOUR_YEARS;
    if (rule === 'SA_DOMESTIC' || completedPeriods === 0) {
      nextVestingDate = iso(new Date(start.getTime() + ((completedPeriods + 1) * FOUR_YEARS + unpaid - 1) * DAY));
    }
  }
  return {
    rule, serviceStart: iso(start), serviceEnd: iso(until), calendarDays, unpaidLeaveDays: unpaid, serviceDays,
    serviceYears: Math.round((serviceDays / YEAR) * 100) / 100, completedFourYearPeriods: completedPeriods,
    monthlyWage: toSar(wage), vested: toSar(vested), provision: toSar(provision), nextVestingDate,
    basis: rule === 'SA_LABOR_LAW' ? 'Labor Law Art. 84 (by contract)' : 'Domestic Workers Regulation Art. 16',
  };
}

/** (monthly wage / 30) × unpaid days, in halalas, half-up. Days may have one decimal (half days). */
export function unpaidLeaveDeduction(wageHalalas: number, days: number): number {
  const tenths = Math.round(days * 10);
  return Math.floor((wageHalalas * tenths + 150) / 300); // wage × tenths / 300, rounded half-up
}

/** End-of-service for one worker, from their contracts and unpaid leave (all reads under RLS). */
export async function esbFor(tx: Tx, staffId: string, asOf: Date) {
  const contracts = await tx.employmentContract.findMany({ where: { staffId }, orderBy: { startDate: 'asc' } });
  if (!contracts.length) return null;
  const leaves = await tx.leaveRecord.findMany({ where: { staffId, paid: false, startDate: { lte: asOf } } });
  const first = contracts[0]!.startDate;
  const unpaidLeaveDays = leaves.reduce((n, l) => {
    const s = Math.max(l.startDate.getTime(), first.getTime()), e = Math.min(l.endDate.getTime(), asOf.getTime());
    return n + (e >= s ? Math.round((e - s) / DAY) + 1 : 0);
  }, 0);
  const latest = contracts[contracts.length - 1]!;
  return computeEsb({ rule: latest.endOfServiceRule, asOf, unpaidLeaveDays,
    contracts: contracts.map((c) => ({ startDate: c.startDate, endDate: c.endDate, basicSalary: Number(c.basicSalary),
      allowances: (c.allowances as Array<{ code: string; amount: number }>) ?? [] })) });
}

