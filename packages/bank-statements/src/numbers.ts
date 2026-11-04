const ARABIC = /[٠-٩]/g, PERSIAN = /[۰-۹]/g;

export function normalizeDigits(s: string): string {
  return s.replace(ARABIC, (d) => String(d.charCodeAt(0) - 0x0660)).replace(PERSIAN, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.').replace(/٬/g, ',');
}

/**
 * "1,234.50" · "(1,234.50)" · "-45" · "45.00 CR" · "SAR 1.234,50" (EU style) · "١٬٢٣٤٫٥٠" → number, or undefined.
 */
export function parseAmount(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  let s = normalizeDigits(raw).trim();
  if (!s) return undefined;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  if (/\b(DR|D|مدين)\s*$/i.test(s)) { sign = -1; s = s.replace(/\b(DR|D|مدين)\s*$/i, ''); }
  s = s.replace(/\b(CR|C|دائن)\s*$/i, '');
  s = s.replace(/[A-Za-z؀-ۿ\s]/g, ''); // currency codes / words
  if (s.startsWith('-')) { sign *= -1; s = s.slice(1); }
  if (s.endsWith('-')) { sign *= -1; s = s.slice(0, -1); }
  if (!/^[\d.,]+$/.test(s)) return undefined;
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastComma > lastDot && /,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,50
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(sign * n * 100) / 100 : undefined;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Dates as GCC banks print them. `order` resolves 03/04/2026 (default day-first). */
export function parseDate(raw: string | undefined, order: 'DMY' | 'MDY' = 'DMY'): string | undefined {
  if (!raw) return undefined;
  const s = normalizeDigits(raw).trim();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ok = (y: number, m: number, d: number) => {
    if (y < 100) y += 2000;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : undefined;
  };
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return ok(+m[1]!, +m[2]!, +m[3]!);
  m = s.match(/^(\d{4})(\d{2})(\d{2})/); // 20261103 (OFX)
  if (m) return ok(+m[1]!, +m[2]!, +m[3]!);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) { const a = +m[1]!, b = +m[2]!, y = +m[3]!; return order === 'DMY' ? ok(y, b, a) : ok(y, a, b); }
  m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s,]+(\d{2,4})/);
  if (m && MONTHS[m[2]!.toLowerCase()]) return ok(+m[3]!, MONTHS[m[2]!.toLowerCase()]!, +m[1]!);
  return undefined;
}
