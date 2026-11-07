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

/** The latest unbroken chain of contracts, up to `asOf` (or the contract end), minus unpaid leave days. */
export function serviceSpan(contracts: EsbContract[], asOf: Date, unpaidLeaveDays = 0) {
  const cs = [...contracts].filter((c) => c.startDate <= asOf).sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
  if (!cs.length) return null;
  let start = cs[0]!.startDate, end = cs[0]!.endDate;
  for (const c of cs.slice(1)) {
    if (end && c.startDate.getTime() - end.getTime() > DAY) start = c.startDate;
    end = !end || !c.endDate ? (c.endDate ?? null) : (c.endDate > end ? c.endDate : end);
  }
  const until = end && end < asOf ? end : asOf;
  const calendarDays = Math.max(0, Math.round((until.getTime() - start.getTime()) / DAY) + 1);
  const unpaid = Math.min(calendarDays, Math.max(0, Math.round(unpaidLeaveDays)));
  const serviceDays = calendarDays - unpaid;
  // Completed calendar months of service, with the end pushed back by the unpaid days.
  const effEnd = new Date(until.getTime() - unpaid * DAY + DAY); // exclusive
  let months = (effEnd.getUTCFullYear() - start.getUTCFullYear()) * 12 + (effEnd.getUTCMonth() - start.getUTCMonth());
  if (effEnd.getUTCDate() < start.getUTCDate()) months--;
  return { start, until, calendarDays, unpaid, serviceDays, serviceMonths: Math.max(0, months), last: cs[cs.length - 1]! };
}

export function computeEsb(input: { rule?: string; contracts: EsbContract[]; asOf: Date; unpaidLeaveDays?: number }) {
  const rule: EsbRule = input.rule === 'SA_DOMESTIC_SINGLE' || input.rule === 'SA_LABOR_LAW' ? input.rule : 'SA_DOMESTIC';
  const span = serviceSpan(input.contracts, input.asOf, input.unpaidLeaveDays);
  if (!span) return null;
  const { start, until, calendarDays, unpaid, serviceDays, serviceMonths, last } = span;
  const wage = monthlyWage(last);

  let vested = 0, provision = 0, monthlyProvision = 0, nextVestingDate: string | null = null, completedPeriods = 0;
  if (rule === 'SA_LABOR_LAW') {
    const years = serviceDays / YEAR;
    vested = wage * (Math.min(years, 5) * 0.5 + Math.max(0, years - 5));
    provision = vested;
    monthlyProvision = wage * (years < 5 ? 0.5 : 1) / 12;
  } else {
    completedPeriods = Math.floor(serviceDays / FOUR_YEARS);
    const counted = rule === 'SA_DOMESTIC_SINGLE' ? Math.min(completedPeriods, 1) : completedPeriods;
    vested = wage * counted;
    // Liability provisioning: monthly wage / 48 for every completed month of service, so the
    // provision reaches one month's wage exactly when the 4-year entitlement vests.
    monthlyProvision = rule === 'SA_DOMESTIC_SINGLE' && serviceMonths >= 48 ? 0 : wage / 48;
    provision = rule === 'SA_DOMESTIC_SINGLE' ? wage * Math.min(serviceMonths / 48, 1) : (wage * serviceMonths) / 48;
    if (rule === 'SA_DOMESTIC' || completedPeriods === 0) {
      nextVestingDate = iso(new Date(start.getTime() + ((completedPeriods + 1) * FOUR_YEARS + unpaid - 1) * DAY));
    }
  }
  return {
    rule, serviceStart: iso(start), serviceEnd: iso(until), calendarDays, unpaidLeaveDays: unpaid, serviceDays, serviceMonths,
    serviceYears: Math.round((serviceDays / YEAR) * 100) / 100, completedFourYearPeriods: completedPeriods,
    monthlyWage: toSar(wage), vested: toSar(vested), provision: toSar(provision), monthlyProvision: toSar(monthlyProvision), nextVestingDate,
    basis: rule === 'SA_LABOR_LAW' ? 'Labor Law Art. 84 (contract override)' : 'Domestic Workers Regulation Art. 16',
  };
}

/**
 * Art. 10 leave: 30 paid days for every 2 completed years of service, accruing at
 * 15 days a year, unless the contract grants more (`annualLeaveDays` = days per year,
 * never below the statutory 15). Taken = paid ANNUAL and VACATION_TRAVEL days within
 * the service chain. Unused days are paid at exit at (monthly wage / 30) per day.
 */
export const STATUTORY_LEAVE_DAYS_PER_YEAR = 15;
export function computeLeave(input: { contracts: Array<EsbContract & { annualLeaveDays: number }>; asOf: Date; unpaidLeaveDays?: number; takenDays: number }) {
  const span = serviceSpan(input.contracts, input.asOf, input.unpaidLeaveDays);
  if (!span) return null;
  const perYear = Math.max(STATUTORY_LEAVE_DAYS_PER_YEAR, (span.last as unknown as { annualLeaveDays?: number }).annualLeaveDays ?? STATUTORY_LEAVE_DAYS_PER_YEAR);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const accrued = r2((perYear * span.serviceDays) / YEAR);
  // Completed 2-year cycles by calendar anniversary (a cycle completes at the end of the day before
  // the anniversary); unpaid leave pushes the anniversaries back.
  const anniversary = (k: number) => { const d = new Date(span.start); d.setUTCFullYear(d.getUTCFullYear() + 2 * k); return new Date(d.getTime() + (span.unpaid - 1) * DAY); };
  let cycles = 0;
  while (anniversary(cycles + 1) <= span.until) cycles++;
  const vested = cycles * perYear * 2;
  const balance = r2(accrued - input.takenDays);
  const wage = monthlyWage(span.last);
  const payout = balance > 0 ? Math.floor((wage * Math.round(balance * 100) + 1500) / 3000) : 0; // wage / 30 × days, halalas
  return {
    basis: perYear === STATUTORY_LEAVE_DAYS_PER_YEAR ? 'Domestic Workers Regulation Art. 10 (30 days per 2 years)' : 'Contract (above the Art. 10 minimum)',
    daysPerYear: perYear, daysPerTwoYears: perYear * 2, serviceStart: iso(span.start), serviceDays: span.serviceDays,
    accruedDays: accrued, takenDays: r2(input.takenDays), balanceDays: balance,
    completedTwoYearCycles: cycles, vestedDays: vested, availableNowDays: r2(vested - input.takenDays),
    nextEntitlementDate: iso(anniversary(cycles + 1)),
    monthlyWage: toSar(wage), dailyRate: toSar(wage / 30), unusedLeavePayout: toSar(payout),
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


/** Art. 10 leave position for one worker (reads under the caller's RLS). */
export async function leaveFor(tx: Tx, staffId: string, asOf: Date) {
  const contracts = await tx.employmentContract.findMany({ where: { staffId }, orderBy: { startDate: 'asc' } });
  if (!contracts.length) return null;
  const leaves = await tx.leaveRecord.findMany({ where: { staffId, startDate: { lte: asOf, gte: contracts[0]!.startDate } } });
  const days = (l: { startDate: Date; endDate: Date }) => Math.round((Math.min(l.endDate.getTime(), asOf.getTime()) - l.startDate.getTime()) / DAY) + 1;
  const unpaidLeaveDays = leaves.filter((l) => !l.paid).reduce((n, l) => n + days(l), 0);
  const takenDays = leaves.filter((l) => l.paid && (l.type === 'ANNUAL' || l.type === 'VACATION_TRAVEL')).reduce((n, l) => n + Math.min(Number(l.days), days(l)), 0);
  return computeLeave({ asOf, unpaidLeaveDays, takenDays,
    contracts: contracts.map((c) => ({ startDate: c.startDate, endDate: c.endDate, basicSalary: Number(c.basicSalary), annualLeaveDays: c.annualLeaveDays,
      allowances: (c.allowances as Array<{ code: string; amount: number }>) ?? [] })) });
}
