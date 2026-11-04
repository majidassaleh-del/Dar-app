import { isValidSaudiVatNumber, toFixed2, toHalalas } from '@herp/zatca';
import { normalizeDigits, normalizeForMatch } from './normalize';

export interface ParsedReceipt {
  merchantName?: string;
  vatNumber?: string;
  /** ISO date (YYYY-MM-DD) in Gregorian; Hijri dates are converted. */
  date?: string;
  hijriDate?: string;
  total?: string;
  vat?: string;
  subtotal?: string;
  currency: string;
  /** 0..1 per field. */
  fieldConfidence: Partial<Record<'merchantName' | 'vatNumber' | 'date' | 'total' | 'vat', number>>;
  warnings: string[];
}

// Keyword lists are matched against normalizeForMatch() output, so write them
// in normalised form (ا not أ/إ, ه not ة, ي not ى).
const TOTAL_STRONG = ['grand total', 'total incl', 'total (incl', 'total with vat', 'incl. vat', 'incl vat', 'including vat',
  'amount due', 'net amount', 'total due', 'total amount',
  'الاجمالي شامل', 'المجموع شامل', 'الاجمالي مع الضريبه', 'المبلغ المستحق', 'الصافي', 'اجمالي الفاتوره', 'المبلغ الاجمالي'];
const TOTAL_WEAK = ['total', 'الاجمالي', 'اجمالي', 'المجموع', 'الاجمالى'];
const NOT_TOTAL = ['subtotal', 'sub total', 'sub-total', 'before vat', 'excl', 'total vat', 'vat total', 'total tax',
  'المجموع الفرعي', 'قبل الضريبه', 'غير شامل', 'اجمالي الضريبه', 'total qty', 'total items', 'عدد'];
const VAT_WORDS = ['vat', 'tax', 'ضريبه القيمه المضافه', 'الضريبه', 'قيمه الضريبه', 'ض.ق.م'];
const VAT_ID_WORDS = ['vat no', 'vat number', 'vat reg', 'tax no', 'tax id', 'trn', 'الرقم الضريبي', 'رقم التسجيل الضريبي', 'الرقم الضريبى'];
const SUBTOTAL_WORDS = ['subtotal', 'sub total', 'sub-total', 'المجموع الفرعي', 'قبل الضريبه', 'before vat'];

const includesAny = (line: string, words: string[]) => words.some((w) => line.includes(w));

/** Money-looking numbers on a line: 1,234.50 · 1234.50 · 45 · 45.5 — but not dates, times, phone numbers or 15-digit VAT ids. */
export function amountsIn(line: string): string[] {
  const s = normalizeDigits(line)
    .replace(/\b\d{1,4}[/.-]\d{1,2}[/.-]\d{2,4}\b/g, ' ')    // dates
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ')             // times
    .replace(/\d{9,}/g, ' ')                                 // ids, phones
    .replace(/\d+(?:\.\d+)?\s*[%\u066A]/g, ' ');              // rates: "15%", "١٥٪" are never money
  const out: string[] = [];
  for (const m of s.matchAll(/(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,3}))?(?!\d)/g)) {
    const int = m[1]!.replace(/,/g, '');
    if (int.length > 7) continue;
    out.push(toFixed2(m[2] ? `${int}.${m[2]}` : int));
  }
  return out;
}

function hijriToGregorian(y: number, m: number, d: number): string | undefined {
  // Search around the approximate Gregorian date using the Umm al-Qura calendar in Intl.
  const fmt = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' });
  // Days since the Hijri epoch (1 Muharram 1 AH = 19 July 622, proleptic Gregorian), mean month 29.5306 d.
  const approx = Date.UTC(622, 6, 19) + ((y - 1) * 354.36707 + (m - 1) * 29.530589 + (d - 1)) * 86400000;
  for (let off = -60; off <= 60; off++) {
    const t = new Date(approx + off * 86400000);
    const parts = Object.fromEntries(fmt.formatToParts(t).map((p) => [p.type, p.value]));
    if (Number(parts.year) === y && Number(parts.month) === m && Number(parts.day) === d) return t.toISOString().slice(0, 10);
  }
  return undefined;
}

function findDate(lines: string[]): { date?: string; hijri?: string } {
  for (const raw of lines) {
    const l = normalizeDigits(raw);
    let m = l.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);   // Y-M-D
    let y: number, mo: number, d: number;
    if (m) { y = +m[1]!; mo = +m[2]!; d = +m[3]!; }
    else if ((m = l.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/))) { d = +m[1]!; mo = +m[2]!; y = +m[3]!; } // D/M/Y (GCC order)
    else continue;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    if (y >= 1350 && y <= 1500) {
      const g = hijriToGregorian(y, mo, d);
      const hijri = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      return g ? { date: g, hijri } : { hijri };
    }
    if (y >= 2000 && y <= 2100) return { date: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
  }
  return {};
}

export function parseReceiptText(ocrText: string): ParsedReceipt {
  const lines = ocrText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const norm = lines.map(normalizeForMatch);
  const r: ParsedReceipt = { currency: 'SAR', fieldConfidence: {}, warnings: [] };

  // --- amount on a keyword line, or on the following line (two-column receipts)
  const amountAt = (i: number) => amountsIn(lines[i]!).at(-1) ?? (lines[i + 1] && !/[a-z؀-ۿ]{3}/i.test(norm[i + 1]!) ? amountsIn(lines[i + 1]!).at(-1) : undefined);

  // --- VAT registration number
  const vatIdLine = norm.findIndex((l) => includesAny(l, VAT_ID_WORDS));
  const allIds = [...normalizeDigits(ocrText).matchAll(/(?<!\d)(3\d{13}3)(?!\d)/g)].map((m) => m[1]!);
  if (allIds.length) {
    const near = vatIdLine >= 0 ? normalizeDigits(lines[vatIdLine]! + ' ' + (lines[vatIdLine + 1] ?? '')).match(/3\d{13}3/)?.[0] : undefined;
    r.vatNumber = near ?? allIds[0];
    r.fieldConfidence.vatNumber = near ? 0.95 : 0.75;
  } else if (vatIdLine >= 0) {
    const cand = normalizeDigits(lines[vatIdLine]!).match(/\d{15}/)?.[0];
    if (cand && !isValidSaudiVatNumber(cand)) r.warnings.push(`VAT number ${cand} fails the 3…3 format`);
  }

  // --- totals
  let best: { amount: string; score: number; idx: number } | undefined;
  norm.forEach((l, i) => {
    if (includesAny(l, NOT_TOTAL) || includesAny(l, VAT_ID_WORDS)) return;
    const score = includesAny(l, TOTAL_STRONG) ? 3 : includesAny(l, TOTAL_WEAK) ? 2 : 0;
    if (!score) return;
    const amount = amountAt(i);
    if (!amount) return;
    // Higher keyword strength wins; among equals, the later (receipts print the grand total last).
    if (!best || score > best.score || (score === best.score && i > best.idx)) best = { amount, score, idx: i };
  });
  norm.forEach((l, i) => {
    if (includesAny(l, VAT_ID_WORDS)) return;
    if (includesAny(l, SUBTOTAL_WORDS)) {        // "Sub Total", "المجموع الفرعي", "قبل الضريبة"
      if (!r.subtotal) r.subtotal = amountAt(i);
      return;
    }
    if (includesAny(l, VAT_WORDS) && !includesAny(l, TOTAL_STRONG) && !r.vat) {
      const a = amountAt(i);                     // amountsIn() already drops the "15%" rate
      if (a) r.vat = a;
    }
  });

  if (best) {
    r.total = best.amount;
    r.fieldConfidence.total = best.score === 3 ? 0.85 : 0.7;
  } else {
    const all = lines.flatMap(amountsIn).sort((a, b) => Number(toHalalas(b) - toHalalas(a)));
    if (all[0]) { r.total = all[0]; r.fieldConfidence.total = 0.35; r.warnings.push('no total keyword found; used the largest amount'); }
  }

  // --- arithmetic cross-checks raise or lower confidence
  if (r.total && r.vat) {
    const T = toHalalas(r.total), V = toHalalas(r.vat);
    const expected = (T * 15n + 57n) / 115n;
    if ((V > expected ? V - expected : expected - V) <= 2n) {
      r.fieldConfidence.total = Math.max(r.fieldConfidence.total ?? 0, 0.95);
      r.fieldConfidence.vat = 0.95;
    } else if (r.subtotal && toHalalas(r.subtotal) + V === T) {
      r.fieldConfidence.total = 0.95; r.fieldConfidence.vat = 0.9;
    } else {
      r.fieldConfidence.vat = 0.5;
      r.warnings.push(`VAT ${r.vat} is not 15% of total ${r.total}`);
    }
  }

  // --- date
  const { date, hijri } = findDate(lines);
  if (date) { r.date = date; r.fieldConfidence.date = 0.8; }
  if (hijri) r.hijriDate = hijri;

  // --- merchant: first line among the top 4 that is mostly letters and not boilerplate
  const boiler = ['simplified tax invoice', 'tax invoice', 'فاتوره ضريبيه', 'فاتوره ضريبيه مبسطه', 'welcome', 'اهلا', 'receipt', 'cash'];
  const m = lines.slice(0, 4).find((l, i) => {
    const n = norm[i]!;
    const letters = (n.match(/[a-zء-ي]/g) ?? []).length;
    return letters >= 3 && letters / n.replace(/\s/g, '').length > 0.6 && !includesAny(n, boiler) && !includesAny(n, VAT_ID_WORDS);
  });
  if (m) { r.merchantName = m; r.fieldConfidence.merchantName = 0.6; }

  return r;
}
