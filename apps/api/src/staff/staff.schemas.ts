import { z } from 'zod';
import { isValidIban, isValidSaudiId, normalizeAlnumUpper, normalizeDigitsOnly } from '@herp/crypto';
import { locales } from '@herp/i18n';

const I18nText = z.partialRecord(z.enum(locales), z.string().trim().max(200)).refine((v) => Object.values(v).some(Boolean), 'at least one language');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').transform((s) => new Date(`${s}T00:00:00Z`));
const country = z.string().regex(/^[A-Z]{2}$/, 'ISO-3166 alpha-2');

export const STAFF_TYPES = ['HOUSEMAID', 'COOK', 'NANNY', 'DRIVER', 'GARDENER', 'SECURITY', 'NURSE', 'TUTOR', 'OTHER'] as const;
export const PAYOUT_CHANNELS = ['MUSANED', 'BANK_TRANSFER', 'CASH', 'DIGITAL_WALLET'] as const;

const staffFields = {
  staffType: z.enum(STAFF_TYPES),
  fullName: I18nText,
  nationality: country,
  gender: z.enum(['F', 'M']).optional(),
  dateOfBirth: isoDate.optional(),
  religion: z.string().max(40).optional(),
  preferredLocale: z.enum(locales).optional(),
  phone: z.string().regex(/^\+\d{8,15}$/, 'E.164, e.g. +639171234567').optional(),
  recruitmentAgency: z.string().max(120).optional(),
  musanedRef: z.string().max(60).optional(),
  borderNumber: z.string().transform(normalizeDigitsOnly).pipe(z.string().regex(/^\d{10}$/, 'border number is 10 digits')).optional(),
  hireDate: isoDate.optional(),
  probationEndsAt: isoDate.optional(),
  weeklyDayOff: z.number().int().min(0).max(6).optional(),
  livesIn: z.boolean().optional(),
  notes: z.string().max(2000).optional(),
  membershipId: z.guid().optional(),
  defaultPayoutChannel: z.enum(PAYOUT_CHANNELS).optional(),
  payoutIban: z.string().refine(isValidIban, 'invalid IBAN (mod-97 check failed)').optional(),
  payoutWalletRef: z.string().max(60).optional(),
};

export const CreateStaff = z.object(staffFields).strict()
  .refine((s) => s.defaultPayoutChannel !== 'BANK_TRANSFER' || s.payoutIban, { message: 'BANK_TRANSFER needs payoutIban', path: ['payoutIban'] });
export const UpdateStaff = z.object(staffFields).partial().strict();

export const STAFF_STATUSES = ['RECRUITING', 'ON_PROBATION', 'ACTIVE', 'ON_LEAVE', 'ABSCONDED', 'TERMINATED', 'FINAL_EXIT'] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];
/** Allowed lifecycle moves. FINAL_EXIT is terminal; ABSCONDED (huroob) can be withdrawn back to ACTIVE. */
export const STATUS_TRANSITIONS: Record<StaffStatus, StaffStatus[]> = {
  RECRUITING: ['ON_PROBATION', 'ACTIVE', 'TERMINATED'],
  ON_PROBATION: ['ACTIVE', 'TERMINATED', 'ABSCONDED'],
  ACTIVE: ['ON_LEAVE', 'ABSCONDED', 'TERMINATED', 'FINAL_EXIT'],
  ON_LEAVE: ['ACTIVE', 'ABSCONDED', 'TERMINATED', 'FINAL_EXIT'],
  ABSCONDED: ['ACTIVE', 'TERMINATED', 'FINAL_EXIT'],
  TERMINATED: ['FINAL_EXIT'],
  FINAL_EXIT: [],
};
export const ChangeStatus = z.object({
  status: z.enum(STAFF_STATUSES), effectiveDate: isoDate.optional(), reason: z.string().max(500).optional(),
}).strict();

export const DOC_TYPES = ['PASSPORT', 'NATIONAL_ID', 'IQAMA', 'VISA', 'EXIT_REENTRY_VISA', 'WORK_PERMIT', 'DRIVING_LICENSE',
  'MEDICAL_INSURANCE', 'MEDICAL_CERTIFICATE', 'CONTRACT', 'OTHER'] as const;
export type DocType = (typeof DOC_TYPES)[number];

/** Per-type number validation; returns an error message or null. */
export function validateDocNumber(type: DocType, raw: string): string | null {
  if (type === 'IQAMA') return isValidSaudiId(raw) && normalizeDigitsOnly(raw).startsWith('2') ? null : 'invalid Iqama number (10 digits starting with 2, check digit)';
  if (type === 'NATIONAL_ID') return isValidSaudiId(raw) && normalizeDigitsOnly(raw).startsWith('1') ? null : 'invalid Saudi national ID (10 digits starting with 1, check digit)';
  if (type === 'PASSPORT') return /^[A-Z0-9]{6,12}$/.test(normalizeAlnumUpper(raw)) ? null : 'invalid passport number (6–12 letters/digits)';
  return normalizeAlnumUpper(raw).length >= 3 ? null : 'document number too short';
}

const alertDays = z.array(z.number().int().min(1).max(365)).min(1).max(6)
  .transform((a) => [...new Set(a)].sort((x, y) => y - x));

export const CreateDocument = z.object({
  type: z.enum(DOC_TYPES),
  number: z.string().min(3).max(40),
  issuingCountry: country.optional(),
  issueDate: isoDate.optional(),
  expiryDate: isoDate.optional(),
  heldByEmployer: z.boolean().optional(),
  alertDays: alertDays.optional(),
}).strict().superRefine((d, ctx) => {
  const err = validateDocNumber(d.type, d.number);
  if (err) ctx.addIssue({ code: 'custom', path: ['number'], message: err });
  if (d.issueDate && d.expiryDate && d.expiryDate <= d.issueDate) ctx.addIssue({ code: 'custom', path: ['expiryDate'], message: 'must be after issueDate' });
});
export const UpdateDocument = z.object({
  number: z.string().min(3).max(40).optional(),
  issueDate: isoDate.optional(),
  expiryDate: isoDate.optional(),
  heldByEmployer: z.boolean().optional(),
  alertDays: alertDays.optional(),
}).strict();

export const LookupDocument = z.object({ type: z.enum(DOC_TYPES), number: z.string().min(3).max(40) });
export const ExpiringQuery = z.object({ withinDays: z.coerce.number().int().min(0).max(365).optional() });

export const CreateContract = z.object({
  startDate: isoDate,
  endDate: isoDate.optional(),
  basicSalary: z.number().positive().max(1_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/).default('SAR'),
  allowances: z.array(z.object({ code: z.string().max(30), amount: z.number().min(0) })).default([]),
  /** Art. 10: paid leave accrued per year. Statutory 15 (= 30 days per 2 completed years); a contract may grant more, never less. */
  annualLeaveDays: z.number().int().min(15, 'Domestic Workers Regulation Art. 10: at least 15 days a year (30 per 2 years)').max(60).default(15),
  ticketEntitlement: z.boolean().default(true),
  workingHoursPerDay: z.number().int().min(1).max(24).optional(),
  /** End-of-service strategy (see hr/esb.ts). Default: Domestic Workers Regulation Art. 16, one month per 4 years. */
  endOfServiceRule: z.enum(['SA_DOMESTIC', 'SA_DOMESTIC_SINGLE', 'SA_LABOR_LAW']).default('SA_DOMESTIC'),
}).strict();

export const RecordSalaryPayment = z.object({
  periodYear: z.number().int().min(2000).max(2100),
  periodMonth: z.number().int().min(1).max(12),
  /** Defaults to the active contract's basic salary + allowances. */
  amount: z.number().positive().max(1_000_000).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  /** Defaults to the worker's defaultPayoutChannel. */
  channel: z.enum(PAYOUT_CHANNELS).optional(),
  externalRef: z.string().trim().min(1).max(80).optional(),
  paidAt: z.string().datetime({ offset: true }).transform((s) => new Date(s)).optional(),
  note: z.string().max(500).optional(),
  proofFileId: z.guid().optional(),
}).strict();
export const SalaryListQuery = z.object({
  year: z.coerce.number().int().optional(), month: z.coerce.number().int().min(1).max(12).optional(),
  staffId: z.guid().optional(), status: z.enum(['RECORDED', 'ACKNOWLEDGED', 'DISPUTED', 'REVERSED']).optional(),
});
export const Acknowledge = z.object({ method: z.enum(['TAP_TO_ACCEPT', 'TYPED_NAME', 'DRAWN_SIGNATURE', 'OTP_CONFIRMED']).optional() }).strict();
export const Reason = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
