import { normalizeDigits, parseAmount, parseDate } from './numbers';
import { StatementParseError, type ParsedStatement, type StatementLine } from './types';

/** RFC-4180-ish split with quotes, for one delimiter. */
export function splitCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === delimiter) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = ''; if (row.some((x) => x.trim())) rows.push(row); row = [];
    } else cell += c;
  }
  row.push(cell); if (row.some((x) => x.trim())) rows.push(row);
  return rows.map((r) => r.map((x) => x.trim()));
}

const SYNONYMS: Record<string, string[]> = {
  date: ['date', 'transaction date', 'posting date', 'booking date', 'trans date', 'value date', 'التاريخ', 'تاريخ العملية', 'تاريخ المعاملة', 'تاريخ القيد'],
  description: ['description', 'details', 'narrative', 'particulars', 'transaction details', 'remarks', 'البيان', 'الوصف', 'التفاصيل', 'تفاصيل العملية'],
  debit: ['debit', 'withdrawal', 'withdrawals', 'debit amount', 'money out', 'paid out', 'مدين', 'سحب', 'المدين', 'مسحوبات'],
  credit: ['credit', 'deposit', 'deposits', 'credit amount', 'money in', 'paid in', 'دائن', 'إيداع', 'ايداع', 'الدائن', 'إيداعات'],
  amount: ['amount', 'transaction amount', 'المبلغ', 'مبلغ العملية'],
  balance: ['balance', 'running balance', 'available balance', 'الرصيد', 'الرصيد المتاح'],
  reference: ['reference', 'ref', 'ref no', 'ref.', 'reference number', 'transaction id', 'الرقم المرجعي', 'رقم المرجع', 'المرجع'],
};
const norm = (h: string) => normalizeDigits(h).toLowerCase().replace(/[ً-ْ]/g, '').replace(/[^\p{L}\p{N} .]/gu, '').replace(/\s+/g, ' ').trim();

export interface CsvOptions { dateOrder?: 'DMY' | 'MDY'; delimiter?: string; columns?: Partial<Record<keyof typeof SYNONYMS, number>> }

export function parseCsvStatement(input: string, opts: CsvOptions = {}): ParsedStatement {
  const text = input.replace(/^﻿/, '');
  const delimiter = opts.delimiter ?? [',', ';', '\t', '|'].map((d) => [d, (text.split('\n')[0] ?? '').split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows = splitCsv(text, delimiter);
  const warnings: string[] = [];

  // Header = first row (within the first 15) that has a date column and an amount-ish column.
  let headerIdx = -1; let cols: Partial<Record<string, number>> = {};
  for (let i = 0; i < Math.min(rows.length, 15) && headerIdx < 0; i++) {
    const found: Partial<Record<string, number>> = {};
    rows[i]!.forEach((h, j) => {
      const n = norm(h);
      for (const [key, words] of Object.entries(SYNONYMS)) if (found[key] === undefined && words.some((w) => n === w || n.startsWith(w + ' '))) found[key] = j;
    });
    if (found.date !== undefined && (found.amount !== undefined || found.debit !== undefined || found.credit !== undefined)) { headerIdx = i; cols = found; }
  }
  if (opts.columns) { cols = { ...cols, ...opts.columns }; if (headerIdx < 0) headerIdx = -1; }
  if (cols.date === undefined || (cols.amount === undefined && cols.debit === undefined && cols.credit === undefined)) {
    throw new StatementParseError('could not find date and amount (or debit/credit) columns; pass `columns` explicitly');
  }

  // Day-first unless the data proves month-first.
  let order: 'DMY' | 'MDY' = opts.dateOrder ?? 'DMY';
  if (!opts.dateOrder) {
    const firsts = rows.slice(headerIdx + 1).map((r) => normalizeDigits(r[cols.date!] ?? '').match(/^(\d{1,2})[-/.](\d{1,2})[-/.]/)).filter(Boolean) as RegExpMatchArray[];
    if (firsts.some((m) => +m[2]! > 12) && !firsts.some((m) => +m[1]! > 12)) order = 'MDY';
  }

  const parsed: Omit<StatementLine, 'lineNo'>[] = [];
  rows.slice(headerIdx + 1).forEach((r, i) => {
    const date = parseDate(r[cols.date!], order);
    if (!date) { if (r.some((x) => x)) warnings.push(`row ${headerIdx + 2 + i}: no date, skipped`); return; }
    let amount: number | undefined;
    if (cols.amount !== undefined) amount = parseAmount(r[cols.amount]);
    else {
      const dr = parseAmount(r[cols.debit ?? -1]), cr = parseAmount(r[cols.credit ?? -1]);
      if (dr || cr) amount = Math.round(((cr ? Math.abs(cr) : 0) - (dr ? Math.abs(dr) : 0)) * 100) / 100;
    }
    if (amount === undefined || amount === 0) { warnings.push(`row ${headerIdx + 2 + i}: no amount, skipped`); return; }
    const balance = cols.balance !== undefined ? parseAmount(r[cols.balance]) : undefined;
    const reference = cols.reference !== undefined ? r[cols.reference] || undefined : undefined;
    parsed.push({ date, amount, description: cols.description !== undefined ? r[cols.description] ?? '' : '', reference, balance });
  });
  if (!parsed.length) throw new StatementParseError('no transactions found');

  // Many Saudi banks export newest-first: sort oldest-first, keeping same-day order stable.
  const newestFirst = parsed.length > 1 && parsed[0]!.date > parsed[parsed.length - 1]!.date;
  const ordered = newestFirst ? [...parsed].reverse() : parsed;
  const lines = ordered.map((l, i) => ({ ...l, lineNo: i + 1 }));

  const withBal = lines.filter((l) => l.balance !== undefined);
  let openingBalance: number | undefined, closingBalance: number | undefined;
  if (withBal.length === lines.length) {
    openingBalance = Math.round((lines[0]!.balance! - lines[0]!.amount) * 100) / 100;
    closingBalance = lines[lines.length - 1]!.balance;
    for (let i = 1; i < lines.length; i++) {
      const expect = Math.round((lines[i - 1]!.balance! + lines[i]!.amount) * 100) / 100;
      if (Math.abs(expect - lines[i]!.balance!) > 0.005) { warnings.push(`line ${i + 1}: running balance ${lines[i]!.balance} ≠ expected ${expect}`); break; }
    }
  }
  return { format: 'CSV', lines, openingBalance, closingBalance, periodStart: lines[0]!.date, periodEnd: lines[lines.length - 1]!.date, warnings };
}
