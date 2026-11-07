/**
 * Sample-mode settlement (no API connected): the same formulas the API uses
 * (apps/api/src/hr/esb.ts), applied to the sample contracts, so the calculator
 * is interactive in a demo. Live mode always uses the API's own numbers.
 */
const DAY = 86_400_000, FOUR_YEARS = 1461, YEAR = 365.25;
const CONTRACTS: Record<string, { start: string; wage: number; taken: number; advances: number }> = {
  s1: { start: '2021-03-01', wage: 2300, taken: 30, advances: 600 }, s2: { start: '2022-06-15', wage: 1700, taken: 15, advances: 0 },
  s3: { start: '2020-01-10', wage: 2100, taken: 45, advances: 0 }, s4: { start: '2024-09-01', wage: 2000, taken: 0, advances: 300 },
  s5: { start: '2026-08-20', wage: 1800, taken: 0, advances: 0 },
};
const iso = (d: Date) => d.toISOString().slice(0, 10);
const f2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

export function sampleSettlement(staffId: string, asOf: string) {
  const c = CONTRACTS[staffId];
  if (!c) return null;
  const start = new Date(`${c.start}T00:00:00Z`), until = new Date(`${asOf}T00:00:00Z`);
  const serviceDays = Math.max(0, Math.round((until.getTime() - start.getTime()) / DAY) + 1);
  const end = new Date(until.getTime() + DAY);
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
  if (end.getUTCDate() < start.getUTCDate()) months--;
  const periods = Math.floor(serviceDays / FOUR_YEARS);
  const ann = (k: number) => { const d = new Date(start); d.setUTCFullYear(d.getUTCFullYear() + 2 * k); return new Date(d.getTime() - DAY); };
  let cycles = 0; while (ann(cycles + 1) <= until) cycles++;
  const accrued = Math.round(((15 * serviceDays) / YEAR) * 100) / 100;
  const balance = Math.round((accrued - c.taken) * 100) / 100;
  const payout = Math.max(0, (c.wage / 30) * balance);
  const vested = c.wage * periods;
  return {
    esb: { rule: 'SA_DOMESTIC', basis: 'Domestic Workers Regulation Art. 16', serviceStart: c.start, serviceDays, serviceMonths: Math.max(0, months),
           serviceYears: Math.round((serviceDays / YEAR) * 100) / 100, completedFourYearPeriods: periods, monthlyWage: f2(c.wage), vested: f2(vested),
           provision: f2((c.wage * Math.max(0, months)) / 48), monthlyProvision: f2(c.wage / 48),
           nextVestingDate: iso(new Date(start.getTime() + ((periods + 1) * FOUR_YEARS - 1) * DAY)) },
    leave: { daysPerYear: 15, daysPerTwoYears: 30, accruedDays: accrued, takenDays: c.taken, balanceDays: balance, completedTwoYearCycles: cycles,
             vestedDays: cycles * 30, nextEntitlementDate: iso(ann(cycles + 1)), dailyRate: f2(c.wage / 30), unusedLeavePayout: f2(payout) },
    settlement: { totalDue: f2(vested + payout), advancesOutstanding: f2(c.advances), totalAfterAdvances: f2(Math.max(0, vested + payout - c.advances)) },
  };
}
