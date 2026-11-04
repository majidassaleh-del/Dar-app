import { describe, expect, it } from 'vitest';
import { matchStatementLines, parseAmount, parseDate, parseStatement, StatementParseError } from '../src';

const ARABIC_CSV = `كشف حساب
رقم الحساب,SA4420000001234567891234
التاريخ,البيان,مدين,دائن,الرصيد
٠٣/١١/٢٠٢٦,"بنده، الرياض",١٢٠٫٠٠,,٩٬٨٨٠٫٠٠
٠٤/١١/٢٠٢٦,راتب,,١٥٬٠٠٠٫٠٠,٢٤٬٨٨٠٫٠٠
٠٥/١١/٢٠٢٦,سحب صراف آلي,٤٠٠٫٠٠,,٢٤٬٤٨٠٫٠٠`;

const NEWEST_FIRST = `Transaction Date;Description;Amount;Balance;Reference
05/11/2026;ATM WITHDRAWAL;-400,00;24480,00;FT26309001
04/11/2026;SALARY ACME;15000,00;24880,00;FT26308777
03/11/2026;PANDA RIYADH;-120,00;9880,00;FT26307555`;

const OFX_SGML = `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>SAR
<BANKTRANLIST><DTSTART>20261101<DTEND>20261105
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261103120000<TRNAMT>-120.00<FITID>A1<NAME>PANDA
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261104<TRNAMT>15000.00<FITID>A2<NAME>SALARY<MEMO>November
</BANKTRANLIST><LEDGERBAL><BALAMT>24880.00<DTASOF>20261105</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

const OFX_XML = `<?xml version="1.0"?><OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>SAR</CURDEF><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261103</DTPOSTED><TRNAMT>-45.50</TRNAMT><FITID>X9</FITID><NAME>STC</NAME></STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>954.50</BALAMT></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

describe('numbers & dates', () => {
  it('amounts in every shape banks print', () => {
    expect(parseAmount('1,234.50')).toBe(1234.5);
    expect(parseAmount('(1,234.50)')).toBe(-1234.5);
    expect(parseAmount('45.00 DR')).toBe(-45);
    expect(parseAmount('SAR 1.234,50')).toBe(1234.5);
    expect(parseAmount('١٬٢٣٤٫٥٠')).toBe(1234.5);
    expect(parseAmount('12-')).toBe(-12);
    expect(parseAmount('abc')).toBeUndefined();
  });
  it('dates: day-first by default, ISO, OFX, month names; impossible dates rejected', () => {
    expect(parseDate('03/04/2026')).toBe('2026-04-03');
    expect(parseDate('03/04/2026', 'MDY')).toBe('2026-03-04');
    expect(parseDate('2026-11-03')).toBe('2026-11-03');
    expect(parseDate('20261103120000')).toBe('2026-11-03');
    expect(parseDate('03 Nov 2026')).toBe('2026-11-03');
    expect(parseDate('31/02/2026')).toBeUndefined();
  });
});

describe('CSV', () => {
  it('Arabic headers, Arabic-Indic digits, debit/credit columns, preamble rows', () => {
    const s = parseStatement(ARABIC_CSV);
    expect(s.lines.map((l) => [l.date, l.amount])).toEqual([['2026-11-03', -120], ['2026-11-04', 15000], ['2026-11-05', -400]]);
    expect(s.lines[0]!.description).toBe('بنده، الرياض');
    expect(s).toMatchObject({ openingBalance: 10000, closingBalance: 24480, periodStart: '2026-11-03', periodEnd: '2026-11-05', warnings: [] });
  });
  it('semicolons, EU decimals, newest-first export and a reference column', () => {
    const s = parseStatement(NEWEST_FIRST);
    expect(s.lines.map((l) => [l.lineNo, l.date, l.amount, l.reference])).toEqual([
      [1, '2026-11-03', -120, 'FT26307555'], [2, '2026-11-04', 15000, 'FT26308777'], [3, '2026-11-05', -400, 'FT26309001']]);
    expect(s.openingBalance).toBe(10000);
  });
  it('flags an inconsistent running balance', () => {
    const s = parseStatement(ARABIC_CSV.replace('٢٤٬٤٨٠٫٠٠', '٢٤٬٠٠٠٫٠٠'));
    expect(s.warnings[0]).toMatch(/running balance/);
  });
  it('detects month-first files from the data', () => {
    const s = parseStatement('Date,Description,Amount\n11/13/2026,A,-1\n11/14/2026,B,-2');
    expect(s.lines[0]!.date).toBe('2026-11-13');
  });
  it('refuses files without date/amount columns', () => {
    expect(() => parseStatement('foo,bar\n1,2')).toThrow(StatementParseError);
  });
});

describe('OFX', () => {
  it('SGML 1.x with unclosed tags', () => {
    const s = parseStatement(OFX_SGML);
    expect(s).toMatchObject({ format: 'OFX', currency: 'SAR', closingBalance: 24880, openingBalance: 10000, periodStart: '2026-11-01', periodEnd: '2026-11-05' });
    expect(s.lines.map((l) => [l.reference, l.amount, l.description])).toEqual([['A1', -120, 'PANDA'], ['A2', 15000, 'SALARY — November']]);
  });
  it('XML 2.x', () => {
    const s = parseStatement(OFX_XML);
    expect(s.lines).toEqual([{ lineNo: 1, date: '2026-11-03', amount: -45.5, description: 'STC', reference: 'X9' }]);
    expect(s.openingBalance).toBe(1000);
  });
});

describe('matching', () => {
  const lines = [
    { id: 'L1', date: '2026-11-03', amount: -120, description: 'PANDA RIYADH' },
    { id: 'L2', date: '2026-11-04', amount: -120, description: 'SOMETHING' },
    { id: 'L3', date: '2026-11-10', amount: -50, reference: 'FT1' },
    { id: 'L4', date: '2026-11-20', amount: -999 },
  ];
  const cands = [
    { id: 'T1', date: '2026-11-04', amount: -120, merchantName: 'Panda' },
    { id: 'T2', date: '2026-11-03', amount: -120 },
    { id: 'T3', date: '2026-11-01', amount: -50, externalRef: 'FT1' },
    { id: 'T4', date: '2026-11-11', amount: -999 },
    { id: 'T5', date: '2026-10-01', amount: -999 },
  ];
  it('one-to-one, best score first; reference beats date; > 3 days never matches without a reference', () => {
    const m = matchStatementLines(lines, cands);
    expect(Object.fromEntries(m.map((x) => [x.lineId, x.transactionId]))).toEqual({ L1: 'T2', L2: 'T1', L3: 'T3' });
  });
});
