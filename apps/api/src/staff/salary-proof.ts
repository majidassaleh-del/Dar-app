import { BadRequestException } from '@nestjs/common';
import type { Tx } from '../db/prisma.service';

/** The household's pay day (1–28), from households.settings.payDay; 28 unless configured. */
export async function payDayOf(tx: Tx, householdId: string): Promise<number> {
  const h = await tx.household.findFirst({ where: { id: householdId }, select: { settings: true } });
  const d = Number((h?.settings as { payDay?: unknown } | null)?.payDay);
  return Number.isInteger(d) && d >= 1 && d <= 28 ? d : 28;
}

/** A transfer screenshot must be an uploaded file of this worker. Unknown / other-household ids are left to the DB's reference check. */
export async function assertProof(tx: Tx, fileId: string | undefined, staffId: string) {
  if (!fileId) return;
  const a = await tx.attachment.findFirst({ where: { id: fileId }, select: { status: true, staffId: true, entityId: true } });
  if (!a) return; // not in this household: the database refuses the reference (422 INVALID_REFERENCE)
  if (a.status !== 'UPLOADED') throw new BadRequestException('proofFileId: upload the transfer screenshot first');
  if (a.staffId !== staffId && a.entityId !== staffId) throw new BadRequestException('proofFileId: this file belongs to another worker');
}

/** Musaned / bank transfers need the transfer reference or a screenshot of the transfer. */
export function proofProblem(channel: string, externalRef?: string | null, proofFileId?: string | null): string | null {
  if ((channel === 'MUSANED' || channel === 'BANK_TRANSFER') && !externalRef && !proofFileId)
    return `${channel} needs externalRef (the transfer reference) or proofFileId (a screenshot of the transfer)`;
  return null;
}
