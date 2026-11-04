import { defaultLocale, isLocale, type Locale } from './config';

/** Shape of every `*I18n` JSONB column, e.g. `{ "ar": "تصليح المكيف", "tl": "Ayusin ang AC" }`. */
export type I18nText = Partial<Record<Locale, string>>;

/**
 * Resolve user-entered multilingual text for display.
 * Order: requested → viewer's own → original → Arabic → first non-empty.
 * `translated` is true when the text shown is not the original, so the UI
 * can show a "translated" chip with a toggle back to the original.
 */
export function resolveI18n(
  value: I18nText | null | undefined,
  opts: { locale: Locale; userLocale?: Locale; originalLocale?: Locale },
): { text: string; locale: Locale | undefined; translated: boolean } {
  const v = value ?? {};
  const order = [opts.locale, opts.userLocale, opts.originalLocale, defaultLocale];
  for (const l of order) {
    if (l && v[l]?.trim()) return { text: v[l]!, locale: l, translated: !!opts.originalLocale && l !== opts.originalLocale };
  }
  for (const [l, text] of Object.entries(v)) {
    if (isLocale(l) && text?.trim()) return { text, locale: l, translated: !!opts.originalLocale && l !== opts.originalLocale };
  }
  return { text: '', locale: undefined, translated: false };
}

/** Locales still missing a translation (drives the translation queue). */
export function missingLocales(value: I18nText | null | undefined, wanted: readonly Locale[]): Locale[] {
  return wanted.filter((l) => !value?.[l]?.trim());
}
