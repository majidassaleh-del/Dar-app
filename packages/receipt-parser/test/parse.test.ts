import { describe, expect, it } from 'vitest';
import QRCode from 'qrcode';
import { encodeZatcaQr } from '@herp/zatca';
import { amountsIn, extractReceipt, JsQrDetector, normalizeDigits, parseReceiptText, processReceiptImage, type OcrProvider } from '../src';

const FUEL_AR = `
محطة الدريس للمحروقات
فاتورة ضريبية مبسطة
الرقم الضريبي: ٣١٠١٢٢٣٩٣٥٠٠٠٠٣
التاريخ: ٢٠٢٦/١١/٠٣  ١١:١٥
بنزين ٩١   ٤٥٫٠٠ لتر
المجموع الفرعي   ١٠٠٫٠٠
ضريبة القيمة المضافة ١٥٪   ١٥٫٠٠
الإجمالي شامل الضريبة   ١١٥٫٠٠ ر.س
شكراً لزيارتكم`;

const MARKET_EN = `Welcome
LULU HYPERMARKET - RIYADH
VAT No: 300055555500003
Date: 03/11/2026 19:42
Milk 2L            2 x 9.50     19.00
Bread                            4.75
Basmati rice 5kg                61.25
Sub Total                       73.04
VAT 15%                         10.96
TOTAL                           84.00
Cash                           100.00
Change                          16.00`;

describe('normalisation', () => {
  it('converts Arabic-Indic and Persian digits and separators', () => {
    expect(normalizeDigits('١٢٣٫٥٠ و ۴۵٬۰۰۰')).toBe('123.50 و 45,000');
  });
  it('finds money amounts but not dates, times or ids', () => {
    expect(amountsIn('03/11/2026 19:42 total 1,234.50 VAT 310122393500003')).toEqual(['1234.50']);
  });
});

describe('parseReceiptText', () => {
  it('Arabic fuel receipt with Arabic-Indic digits', () => {
    const r = parseReceiptText(FUEL_AR);
    expect(r).toMatchObject({ merchantName: 'محطة الدريس للمحروقات', vatNumber: '310122393500003', date: '2026-11-03',
      total: '115.00', vat: '15.00', subtotal: '100.00', warnings: [] });
    expect(r.fieldConfidence.total).toBeGreaterThanOrEqual(0.95);
  });

  it('English supermarket: picks TOTAL, not Cash/Change/Sub Total, and ignores the 15% rate', () => {
    const r = parseReceiptText(MARKET_EN);
    expect(r).toMatchObject({ merchantName: 'LULU HYPERMARKET - RIYADH', vatNumber: '300055555500003',
      date: '2026-11-03', total: '84.00', vat: '10.96', subtotal: '73.04' });
    expect(r.warnings).toEqual([]);
  });

  it('two-column layout: amount on the line after the label', () => {
    const r = parseReceiptText('Pharmacy Al Nahdi\nGrand Total\n230.00\nVAT\n30.00');
    expect(r.total).toBe('230.00');
    expect(r.vat).toBe('30.00');
  });

  it('converts a Hijri (Umm al-Qura) date', () => {
    const r = parseReceiptText('بقالة الحي\nالتاريخ ١٤٤٨/٠٥/١٢ هـ\nالإجمالي ٢٣٫٠٠');
    expect(r.hijriDate).toBe('1448-05-12');
    expect(r.date).toBe('2026-10-23'); // ICU Umm al-Qura: 1448-05-24 = 2026-11-04
  });

  it('falls back to the largest amount, with low confidence and a warning', () => {
    const r = parseReceiptText('Car wash\n35.00\n5.25');
    expect(r.total).toBe('35.00');
    expect(r.fieldConfidence.total).toBeLessThan(0.5);
    expect(r.warnings[0]).toMatch(/no total keyword/);
  });

  it('warns when VAT does not reconcile', () => {
    expect(parseReceiptText('Shop\nTOTAL 100.00\nVAT 20.00').warnings[0]).toMatch(/not 15%/);
  });
});

describe('extractReceipt (OCR + ZATCA QR)', () => {
  const qr = encodeZatcaQr({ sellerName: 'محطة الدريس للمحروقات', vatNumber: '310122393500003',
    issuedAt: '2026-11-03T08:15:00Z', total: '115.00', vat: '15.00' });

  it('QR is authoritative and agrees with OCR → high confidence, no review', () => {
    const r = extractReceipt({ ocrText: FUEL_AR, qrPayloads: ['https://loyalty.example/123', qr] });
    expect(r).toMatchObject({ source: 'ZATCA_QR+OCR', total: '115.00', vat: '15.00', confidence: 0.99, needsReview: false });
    expect(r.zatca?.phase).toBe(1);
  });

  it('flags a printed total that disagrees with the QR', () => {
    const r = extractReceipt({ ocrText: FUEL_AR.replace('١١٥٫٠٠', '١١٩٫٠٠'), qrPayloads: [qr] });
    expect(r.total).toBe('115.00');
    expect(r.warnings.join()).toMatch(/differs from QR total/);
    expect(r.confidence).toBeLessThan(0.99);
  });

  it('OCR-only receipts with weak signals go to review', () => {
    expect(extractReceipt({ ocrText: 'Car wash\n35.00' }).needsReview).toBe(true);
  });
});

describe('end-to-end: QR image → JsQrDetector → extraction', () => {
  it('reads a ZATCA QR from a PNG and merges it with OCR text', async () => {
    const payload = encodeZatcaQr({ sellerName: 'LULU HYPERMARKET', vatNumber: '300055555500003',
      issuedAt: '2026-11-03T16:42:00Z', total: '84.00', vat: '10.96' });
    const png = await QRCode.toBuffer(payload, { type: 'png', errorCorrectionLevel: 'M', margin: 4, scale: 6 });
    const fakeOcr: OcrProvider = { name: 'fake', recognize: async () => ({ text: MARKET_EN, provider: 'fake' }) };
    const r = await processReceiptImage(new Uint8Array(png), 'image/png', { ocr: fakeOcr, qr: new JsQrDetector() });
    expect(r.qrPayload).toBe(payload);
    expect(r).toMatchObject({ source: 'ZATCA_QR+OCR', merchantName: 'LULU HYPERMARKET', total: '84.00', needsReview: false });
  });
});
