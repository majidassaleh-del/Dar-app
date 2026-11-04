import { z } from 'zod';
import type { Tx } from '../db/prisma.service';

export const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
export const money = z.number().positive().max(100_000_000);
export const iso = z.string().datetime({ offset: true });

export async function household(tx: Tx, id: string) {
  const h = await tx.household.findFirst({ where: { id }, select: { baseCurrency: true, timezone: true } });
  return { currency: h?.baseCurrency ?? 'SAR', timezone: h?.timezone ?? 'Asia/Riyadh' };
}

/** [start, end) of the budget period that contains `today` (dates are household-local, UTC-midnight encoded). */
export function periodWindow(startsOn: Date, period: 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY', today: Date): { start: Date; end: Date } {
  const step = (d: Date, n: number) => {
    const x = new Date(d);
    if (period === 'WEEKLY') x.setUTCDate(x.getUTCDate() + 7 * n);
    else x.setUTCMonth(x.getUTCMonth() + n * (period === 'MONTHLY' ? 1 : period === 'QUARTERLY' ? 3 : 12));
    return x;
  };
  let start = new Date(startsOn);
  if (today < start) return { start, end: step(start, 1) };
  // jump close, then walk (bounded)
  for (let i = 0; i < 10_000 && step(start, 1) <= today; i++) start = step(start, 1);
  return { start, end: step(start, 1) };
}

/** Next occurrence for recurring bills; month steps clamp to the month's last day (31 Jan → 28/29 Feb). */
export function nextOccurrence(from: Date, frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY', interval: number, dayOfPeriod?: number | null): Date {
  const x = new Date(from);
  if (frequency === 'DAILY') { x.setUTCDate(x.getUTCDate() + interval); return x; }
  if (frequency === 'WEEKLY') { x.setUTCDate(x.getUTCDate() + 7 * interval); return x; }
  const months = interval * (frequency === 'MONTHLY' ? 1 : frequency === 'QUARTERLY' ? 3 : 12);
  const wantDay = dayOfPeriod ?? from.getUTCDate();
  const y = x.getUTCFullYear(), m = x.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(wantDay, last), x.getUTCHours(), x.getUTCMinutes()));
}
