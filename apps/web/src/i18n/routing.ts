import { defineRouting } from 'next-intl/routing';
import { defaultLocale, locales } from '@herp/i18n';

/**
 * /ar/…, /en/…, /hi/…, /tl/…, /am/…, /bn/…
 * The prefix is always present so a shared link opens in the sender's
 * language; "/" negotiates from the NEXT_LOCALE cookie, then Accept-Language.
 */
export const routing = defineRouting({
  locales,
  defaultLocale,
  localePrefix: 'always',
  localeCookie: { name: 'NEXT_LOCALE', maxAge: 60 * 60 * 24 * 365 },
});
