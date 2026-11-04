import { parseAmount, parseDate } from './numbers';
import { StatementParseError, type ParsedStatement } from './types';

/** OFX 1.x (SGML, unclosed leaf tags) and 2.x (XML). */
export function parseOfxStatement(input: string): ParsedStatement {
  const text = input.replace(/^﻿/, '');
  if (!/<OFX>/i.test(text)) throw new StatementParseError('not an OFX file');
  const tag = (block: string, name: string) => block.match(new RegExp(`<${name}>([^<\\r\\n]*)`, 'i'))?.[1]?.trim();
  const blocks = [...text.matchAll(/<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|(?=<\/BANKTRANLIST>))/gi)].map((m) => m[1]!);
  const warnings: string[] = [];
  const raw = blocks.map((b, i) => {
    const date = parseDate(tag(b, 'DTPOSTED'));
    const amount = parseAmount(tag(b, 'TRNAMT'));
    if (!date || amount === undefined) { warnings.push(`STMTTRN ${i + 1}: missing DTPOSTED/TRNAMT, skipped`); return null; }
    const name = tag(b, 'NAME') ?? '', memo = tag(b, 'MEMO') ?? '';
    return { date, amount, description: [name, memo].filter(Boolean).join(' — '), reference: tag(b, 'FITID') };
  }).filter((x): x is NonNullable<typeof x> => !!x && x.amount !== 0);
  if (!raw.length) throw new StatementParseError('no STMTTRN entries');
  const lines = [...raw].sort((a, b) => a.date.localeCompare(b.date)).map((l, i) => ({ ...l, lineNo: i + 1 }));
  const ledger = text.match(/<LEDGERBAL>([\s\S]*?)(?:<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>)/i)?.[1];
  const closingBalance = ledger ? parseAmount(tag(ledger, 'BALAMT')) : undefined;
  const sum = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  return {
    format: 'OFX', lines, currency: tag(text, 'CURDEF'), closingBalance,
    openingBalance: closingBalance !== undefined ? Math.round((closingBalance - sum) * 100) / 100 : undefined,
    periodStart: parseDate(tag(text, 'DTSTART')) ?? lines[0]!.date, periodEnd: parseDate(tag(text, 'DTEND')) ?? lines[lines.length - 1]!.date, warnings,
  };
}
