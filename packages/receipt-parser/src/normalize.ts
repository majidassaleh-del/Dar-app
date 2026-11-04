/**
 * OCR output from Arabic receipts mixes scripts and digit systems:
 * "الإجمالي ١٢٣٫٥٠ ر.س" or "Total 123.50 SAR". Normalise before parsing.
 */
const ARABIC_INDIC = 0x0660;   // ٠..٩
const EXTENDED_INDIC = 0x06f0; // ۰..۹ (Persian / Urdu forms, seen on some POS fonts)

export function normalizeDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - ARABIC_INDIC))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - EXTENDED_INDIC))
    .replace(/٫/g, '.')  // Arabic decimal separator ٫
    .replace(/٬/g, ',')  // Arabic thousands separator ٬
    .replace(/،/g, ','); // Arabic comma ،
}

/** For keyword matching only: unify alef/ya/ta-marbuta forms, drop tatweel & diacritics, lowercase Latin. */
export function normalizeForMatch(s: string): string {
  return normalizeDigits(s)
    .replace(/ـ/g, '')               // tatweel ـ
    .replace(/[ً-ْٰ]/g, '') // harakat
    .replace(/[آأإ]/g, 'ا') // آ أ إ → ا
    .replace(/ى/g, 'ي')          // ى → ي
    .replace(/ة/g, 'ه')          // ة → ه
    .replace(/[‎‏‪-‮⁦-⁩]/g, '') // bidi controls OCR leaves behind
    .toLowerCase();
}
