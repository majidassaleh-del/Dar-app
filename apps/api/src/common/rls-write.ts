import { ForbiddenException, NotFoundException } from '@nestjs/common';

/**
 * Under RLS a refused UPDATE/DELETE is silently "0 rows". Tell the two cases
 * apart: if the caller can SEE the row it is a permission problem (403),
 * otherwise the row does not exist for them (404).
 */
export async function assertWritten(count: number, visible: () => Promise<unknown>, what = 'record'): Promise<void> {
  if (count > 0) return;
  if (await visible()) throw new ForbiddenException(`your role cannot modify this ${what}`);
  throw new NotFoundException(`${what} not found`);
}

export const money = (d: { toFixed(n: number): string } | null | undefined) => (d == null ? null : d.toFixed(2));
export const isoDate = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
