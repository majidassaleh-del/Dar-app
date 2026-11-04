import { decodeZatcaQr, toHalalas, type ZatcaInvoiceQr, ZatcaQrError } from '@herp/zatca';
import { parseReceiptText, type ParsedReceipt } from './parse';

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
export function extractReceipt(input: { ocrText?: string; qrPayloads?: string[] }, reviewBelow = 0.8): ExtractedReceipt {
  const ocr = parseReceiptText(input.ocrText ?? '');
  let qr: ZatcaInvoiceQr | undefined;
  for (const p of input.qrPayloads ?? []) {
    try { qr = decodeZatcaQr(p); break; } catch (e) {
      if (!(e instanceof ZatcaQrError)) throw e; // a non-ZATCA QR (URL, loyalty code) is just ignored
    }
  }

  if (!qr) {
    const scores = [ocr.fieldConfidence.total ?? 0, ocr.fieldConfidence.date ?? 0.5, ocr.fieldConfidence.merchantName ?? 0.5];
    const confidence = Math.round(Math.min(...scores) * 100) / 100;
    return { ...ocr, source: 'OCR', confidence, needsReview: confidence < reviewBelow };
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
