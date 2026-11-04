import { resolveI18n, type I18nText, type Locale } from '@herp/i18n';
import type { IdentityDocument, Prisma, SalaryPayment, StaffProfile } from '@prisma/client';
import { isoDate, money } from '../common/rls-write';

/** Calendar date "today" in a household's time zone (documents expire on local dates). */
export function todayIn(timeZone: string, now = new Date()): Date {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return new Date(`${ymd}T00:00:00Z`);
}

export function alertTier(daysLeft: number | null, tiers: number[]): string | null {
  if (daysLeft == null) return null;
  if (daysLeft < 0) return 'EXPIRED';
  const t = [...tiers].sort((a, b) => a - b).find((x) => daysLeft <= x);
  return t == null ? null : String(t);
}

/** Never returns ciphertexts or blind indexes: only last-4 and flags. */
export function staffDto(s: StaffProfile, locale: Locale) {
  return {
    id: s.id, membershipId: s.membershipId, staffType: s.staffType, status: s.status,
    name: resolveI18n(s.fullNameI18n as I18nText, { locale }).text, fullName: s.fullNameI18n,
    nationality: s.nationality, gender: s.gender, dateOfBirth: isoDate(s.dateOfBirth), preferredLocale: s.preferredLocale,
    phone: s.phone, recruitmentAgency: s.recruitmentAgency, musanedRef: s.musanedRef,
    hasBorderNumber: !!s.borderNumberCiphertext, hireDate: isoDate(s.hireDate), probationEndsAt: isoDate(s.probationEndsAt),
    terminationDate: isoDate(s.terminationDate), weeklyDayOff: s.weeklyDayOff, livesIn: s.livesIn,
    payout: { defaultChannel: s.defaultPayoutChannel, ibanLast4: s.payoutIbanLast4, walletRef: s.payoutWalletRef },
    createdAt: s.createdAt,
  };
}

export function documentDto(d: IdentityDocument, today: Date) {
  const daysLeft = d.expiryDate ? Math.round((d.expiryDate.getTime() - today.getTime()) / 86_400_000) : null;
  return {
    id: d.id, staffId: d.staffId, type: d.type, numberLast4: d.numberLast4, issuingCountry: d.issuingCountry,
    issueDate: isoDate(d.issueDate), expiryDate: isoDate(d.expiryDate), heldByEmployer: d.heldByEmployer,
    alertDays: d.alertDays, daysLeft, alertTier: alertTier(daysLeft, d.alertDays),
  };
}

export function salaryDto(p: SalaryPayment) {
  return {
    id: p.id, staffId: p.staffId, period: `${p.periodYear}-${String(p.periodMonth).padStart(2, '0')}`,
    periodYear: p.periodYear, periodMonth: p.periodMonth, amount: money(p.amount), currency: p.currency,
    channel: p.channel, status: p.status, externalRef: p.externalRef, payoutLast4: p.payoutLast4, paidAt: p.paidAt,
    note: p.note, proofFileId: p.proofFileId, acknowledgedAt: p.acknowledgedAt, ackMethod: p.ackMethod,
    disputeReason: p.disputeReason, reversedAt: p.reversedAt, reversalReason: p.reversalReason,
  };
}

/** Monthly amount due under a contract: basic + allowances. */
export function contractMonthly(c: { basicSalary: Prisma.Decimal; allowances: Prisma.JsonValue }): number {
  const allow = Array.isArray(c.allowances) ? c.allowances.reduce<number>((s, a) => s + Number((a as { amount?: number })?.amount ?? 0), 0) : 0;
  return Math.round((Number(c.basicSalary) + allow) * 100) / 100;
}
