import { describe, expect, it } from 'vitest';
import { decodeZatcaQr, encodeZatcaQr, isValidSaudiVatNumber, toFixed2, decodeTlv, ZatcaQrError, encodeTlv } from '../src';

const sample = {
  sellerName: 'محطة الدريس للمحروقات',
  vatNumber: '310122393500003',
  issuedAt: '2026-11-03T08:15:00Z',
  total: '115.00',
  vat: '15.00',
};

describe('ZATCA QR', () => {
  it('round-trips a Phase 1 QR with an Arabic seller name', () => {
    const qr = decodeZatcaQr(encodeZatcaQr(sample));
    expect(qr).toMatchObject({ phase: 1, sellerName: sample.sellerName, vatNumber: sample.vatNumber,
      issuedAt: '2026-11-03T08:15:00.000Z', total: '115.00', vat: '15.00', warnings: [] });
  });

  it('decodes a golden payload produced by an independent (Python) encoder', () => {
    const b64 = 'ARRBY21lIFRyYWRpbmcgQ28uIExURAIPMzEwMTIyMzkzNTAwMDAzAxQyMDIyLTA0LTI1VDE1OjMwOjAwWgQHMTEwMC4wMAUGMTQzLjQ4';
    const qr = decodeZatcaQr(b64);
    expect(qr.sellerName).toBe('Acme Trading Co. LTD');
    expect(qr.issuedAt).toBe('2022-04-25T15:30:00.000Z');
    expect(qr.total).toBe('1100.00');
    expect(qr.vat).toBe('143.48'); // 1100 × 15/115 = 143.478…
    expect(qr.warnings).toEqual([]);
  });

  it('reads a timestamp without offset as Riyadh time', () => {
    const qr = decodeZatcaQr(encodeZatcaQr({ ...sample, issuedAt: '2026-11-03 11:15:00' }));
    expect(qr.issuedAt).toBe('2026-11-03T08:15:00.000Z');
  });

  it('accepts URL-safe Base64 with whitespace from a scanner', () => {
    const b64 = encodeZatcaQr(sample).replace(/\+/g, '-').replace(/\//g, '_');
    expect(decodeZatcaQr(`  ${b64.slice(0, 10)}\n${b64.slice(10)} `).total).toBe('115.00');
  });

  it('flags VAT that is not 15 %', () => {
    expect(decodeZatcaQr(encodeZatcaQr({ ...sample, vat: '10.00' })).warnings[0]).toMatch(/not 15%/);
  });

  it('flags an invalid VAT registration number', () => {
    expect(decodeZatcaQr(encodeZatcaQr({ ...sample, vatNumber: '123' })).warnings[0]).toMatch(/not a valid Saudi VAT/);
  });

  it('detects Phase 2 tags', () => {
    const b64 = Buffer.from(encodeTlv([
      { tag: 1, value: 'X' }, { tag: 2, value: sample.vatNumber }, { tag: 3, value: sample.issuedAt },
      { tag: 4, value: '115.00' }, { tag: 5, value: '15.00' }, { tag: 6, value: 'aGFzaA==' },
      { tag: 7, value: new Uint8Array(71).fill(7) }, { tag: 8, value: new Uint8Array(88).fill(8) },
    ])).toString('base64');
    const qr = decodeZatcaQr(b64);
    expect(qr.phase).toBe(2);
    expect(qr.signature?.length).toBe(71);
    expect(qr.publicKey?.length).toBe(88);
  });

  it('treats a 129-byte value as a single-byte length, not BER', () => {
    const v = new Uint8Array(129).fill(65);
    expect(decodeTlv(Uint8Array.from([7, 129, ...v]))[0]!.value.length).toBe(129);
  });

  it('falls back to BER long-form lengths from non-conforming encoders', () => {
    const v = new Uint8Array(300).fill(66);
    const fields = decodeTlv(Uint8Array.from([7, 0x82, 0x01, 0x2c, ...v]));
    expect(fields[0]!.value.length).toBe(300);
  });

  it('rejects garbage and missing tags', () => {
    expect(() => decodeZatcaQr('not base64 !!')).toThrow(ZatcaQrError);
    const onlyTwo = Buffer.from(encodeTlv([{ tag: 1, value: 'X' }, { tag: 2, value: '3' }])).toString('base64');
    expect(() => decodeZatcaQr(onlyTwo)).toThrow(/mandatory tag 3/);
  });

  it('helpers', () => {
    expect(isValidSaudiVatNumber('310122393500003')).toBe(true);
    expect(isValidSaudiVatNumber('210122393500003')).toBe(false);
    expect(toFixed2('12.345')).toBe('12.35');
    expect(toFixed2('7')).toBe('7.00');
  });
});
