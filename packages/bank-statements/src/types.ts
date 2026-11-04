export interface StatementLine {
  /** 1-based position in the file (after sorting oldest-first). */
  lineNo: number;
  /** Booking date, YYYY-MM-DD. */
  date: string;
  /** Signed, account's point of view: money in > 0, money out < 0. Two decimals. */
  amount: number;
  description: string;
  /** Bank's own id when the format has one (OFX FITID, CSV reference column). */
  reference?: string;
  /** Running balance after this line, when the bank prints it. */
  balance?: number;
}

export interface ParsedStatement {
  format: 'CSV' | 'OFX';
  lines: StatementLine[];
  currency?: string;
  openingBalance?: number;
  closingBalance?: number;
  periodStart?: string;
  periodEnd?: string;
  warnings: string[];
}

export class StatementParseError extends Error {
  constructor(message: string) { super(message); this.name = 'StatementParseError'; }
}
