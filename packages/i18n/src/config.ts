/**
 * Single source of truth for languages. Imported by the Next.js app
 * (next-intl routing), the mobile app (use-intl + I18nManager) and the API
 * (Accept-Language negotiation, notification rendering).
 */
export const locales = ['ar', 'en', 'hi', 'tl', 'am', 'bn'] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = 'ar';

export const rtlLocales: ReadonlySet<Locale> = new Set<Locale>(['ar']);

export type Direction = 'rtl' | 'ltr';

export const localeMeta: Record<Locale, {
  /** Name in its own language, for the language switcher. */
  endonym: string;
  dir: Direction;
  /** BCP-47 tag used for Intl formatting (numbers, dates, plurals). */
  intlTag: string;
  /** Font stack; subsets are loaded per locale. */
  fontStack: string;
}> = {
  ar: { endonym: 'العربية', dir: 'rtl', intlTag: 'ar-SA', fontStack: '"IBM Plex Sans Arabic", "Noto Sans Arabic", Tahoma, sans-serif' },
  en: { endonym: 'English', dir: 'ltr', intlTag: 'en-SA', fontStack: '"Inter", system-ui, sans-serif' },
  hi: { endonym: 'हिन्दी', dir: 'ltr', intlTag: 'hi-IN', fontStack: '"Noto Sans Devanagari", system-ui, sans-serif' },
  tl: { endonym: 'Tagalog', dir: 'ltr', intlTag: 'fil-PH', fontStack: '"Inter", system-ui, sans-serif' },
  am: { endonym: 'አማርኛ', dir: 'ltr', intlTag: 'am-ET', fontStack: '"Noto Sans Ethiopic", system-ui, sans-serif' },
  bn: { endonym: 'বাংলা', dir: 'ltr', intlTag: 'bn-BD', fontStack: '"Noto Sans Bengali", system-ui, sans-serif' },
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (locales as readonly string[]).includes(value);
}

export function getDirection(locale: Locale): Direction {
  return localeMeta[locale].dir;
}

/** Map a device/browser language tag (e.g. "fil-PH", "ar-EG", "en-US") to a supported locale. */
export function matchLocale(tag: string | null | undefined): Locale | undefined {
  if (!tag) return undefined;
  const base = tag.toLowerCase().split(/[-_]/)[0];
  if (base === 'fil') return 'tl';
  return isLocale(base) ? base : undefined;
}

/** Negotiate from an Accept-Language header ("tl,en;q=0.8,ar;q=0.5"). */
export function negotiateLocale(acceptLanguage: string | null | undefined, fallback: Locale = defaultLocale): Locale {
  if (!acceptLanguage) return fallback;
  const ranked = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { tag: tag ?? '', q: q ? Number(q.slice(2)) : 1 };
    })
    .filter((x) => x.tag && !Number.isNaN(x.q))
    .sort((a, b) => b.q - a.q);
  for (const { tag } of ranked) {
    const m = matchLocale(tag);
    if (m) return m;
  }
  return fallback;
}
