import { decodeZatcaQr, isValidSaudiVatNumber, toHalalas, type ZatcaInvoiceQr, ZatcaQrError } from '@herp/zatca';
import { parseReceiptText, type ParsedReceipt } from './parse';
import type { ReceiptFields } from './ocr/provider';

type FieldKey = 'merchantName' | 'vatNumber' | 'date' | 'total' | 'vat';
const MONEY = /^\d{1,9}(\.\d{1,2})?$/;

/** Validate a vision-read field; undefined if it is not plausible. */
function clean(k: FieldKey, v: string | undefined): string | undefined {
  if (!v) return undefined;
  if (k === 'total' || k === 'vat') { const n = v.replace(/,/g, ''); return MONEY.test(n) ? Number(n).toFixed(2) : undefined; }
  if (k === 'vatNumber') { const d = v.replace(/\D/g, ''); return isValidSaudiVatNumber(d) ? d : undefined; }
  if (k === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined;
  return v.slice(0, 120);
}
const same = (k: FieldKey, a: string, b: string) => (k === 'total' || k === 'vat') ? toHalalas(a) === toHalalas(b) : a.toLowerCase() === b.toLowerCase();

/**
 * Combine the deterministic text parse with fields a vision model read directly.
 * Agreement raises confidence; disagreement is surfaced as a warning and lowers it
 * (so the expense goes to review); a field only the model read gets 0.9.
 */
export function mergeVisionFields(ocr: ParsedReceipt, fields?: ReceiptFields): ParsedReceipt {
  if (!fields) return ocr;
  const r: ParsedReceipt = { ...ocr, fieldConfidence: { ...ocr.fieldConfidence }, warnings: [...ocr.warnings] };
  for (const k of ['merchantName', 'vatNumber', 'date', 'total', 'vat'] as const) {
    const v = clean(k, fields[k]);
    const mine = r[k];
    if (!v) continue;
    if (!mine) { r[k] = v; r.fieldConfidence[k] = 0.9; continue; }
    if (same(k, mine, v)) { r.fieldConfidence[k] = Math.max(r.fieldConfidence[k] ?? 0, 0.97); continue; }
    if (k === 'merchantName') { // spelling / script variants are normal: trust the model over a weak first-line guess
      if ((r.fieldConfidence.merchantName ?? 0) < 0.8) { r.merchantName = v; r.fieldConfidence.merchantName = 0.9; }
      continue;
    }
    r.warnings.push(`${k}: text parser read ${mine}, vision read ${v}`);
    r[k] = v; r.fieldConfidence[k] = 0.6;
  }
  if (fields.currency && /^[A-Z]{3}$/.test(fields.currency)) r.currency = fields.currency;
  // Standard-rated Saudi receipts: VAT = total × 15/115 (±5 halalas). Zero-rated or mixed baskets differ, so only warn.
  if (r.total && r.vat && Math.abs(Number(toHalalas(r.vat)) - Math.round((Number(toHalalas(r.total)) * 15) / 115)) > 5) {
    r.warnings.push(`VAT ${r.vat} is not 15% of ${r.total}`);
  }
  return r;
}

export interface ExtractedReceipt extends ParsedReceipt {
  source: 'ZATCA_QR' | 'OCR' | 'ZATCA_QR+OCR';
  zatca?: Omit<ZatcaInvoiceQr, 'signature' | 'publicKey' | 'stampSignature'> & { signed: boolean };
  /** Overall 0..1; below ~0.8 the expense goes to human review. */
  confidence: number;
  needsReview: boolean;
}

/**
 * Combine OCR text with any QR payloads found on the receipt. A valid ZATCA
 * QR is authoritative for seller, VAT number, timestamp, total and VAT; OCR
 * fills the rest and is cross-checked against it.
 */
export function extractReceipt(input: { ocrText?: string; qrPayloads?: string[]; fields?: ReceiptFields }, reviewBelow = 0.8): ExtractedReceipt {
  const ocr = mergeVisionFields(parseReceiptText(input.ocrText ?? ''), input.fields);
  let qr: ZatcaInvoiceQr | undefined;
  for (const p of input.qrPayloads ?? []) {
    try { qr = decodeZatcaQr(p); break; } catch (e) {
      if (!(e instanceof ZatcaQrError)) throw e; // a non-ZATCA QR (URL, loyalty code) is just ignored
    }
  }

  if (!qr) {
    const scores = [ocr.fieldConfidence.total ?? 0, ocr.fieldConfidence.date ?? 0.5, ocr.fieldConfidence.merchantName ?? 0.5];
    const confidence = Math.round(Math.min(...scores) * 100) / 100;
    return { ...ocr, source: 'OCR', confidence, needsReview: confidence < reviewBelow || ocr.warnings.some((w) => w.includes('vision read')) };
  }

  const warnings = [...qr.warnings.map((w) => `QR: ${w}`), ...ocr.warnings.filter((w) => !w.startsWith('no total keyword'))];
  if (ocr.total && toHalalas(ocr.total) !== toHalalas(qr.total)) {
    warnings.push(`printed total ${ocr.total} differs from QR total ${qr.total}`);
  }
  if (ocr.vatNumber && ocr.vatNumber !== qr.vatNumber) warnings.push(`printed VAT number ${ocr.vatNumber} differs from QR`);

  const { signature, publicKey, stampSignature, ...rest } = qr;
  const confidence = qr.warnings.length ? 0.85 : 0.99;
  return {
    ...ocr,
    merchantName: qr.sellerName || ocr.merchantName,
    vatNumber: qr.vatNumber,
    date: qr.issuedAt.slice(0, 10),
    total: qr.total,
    vat: qr.vat,
    fieldConfidence: { ...ocr.fieldConfidence, merchantName: 0.99, vatNumber: 0.99, date: 0.99, total: 0.99, vat: 0.99 },
    warnings,
    source: input.ocrText ? 'ZATCA_QR+OCR' : 'ZATCA_QR',
    zatca: { ...rest, signed: !!(signature && publicKey) },
    confidence: warnings.length ? Math.min(confidence, 0.85) : confidence,
    needsReview: warnings.length > 0 && Math.min(confidence, 0.85) < reviewBelow,
  };
}
