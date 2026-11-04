export * from './types';
export * from './numbers';
export * from './csv';
export * from './ofx';
export * from './match';
import { parseCsvStatement, type CsvOptions } from './csv';
import { parseOfxStatement } from './ofx';
import type { ParsedStatement } from './types';

export function parseStatement(content: string, format?: 'CSV' | 'OFX', csv?: CsvOptions): ParsedStatement {
  const f = format ?? (/<OFX>/i.test(content) || /^OFXHEADER/m.test(content) ? 'OFX' : 'CSV');
  return f === 'OFX' ? parseOfxStatement(content) : parseCsvStatement(content, csv);
}
