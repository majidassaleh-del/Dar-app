/**
 * Mobile (Expo) i18n root — SOURCE ONLY, not built in this repo yet
 * (apps/mobile is outside the pnpm workspace until the Expo toolchain is set up).
 *
 * next-intl is Next.js-specific (routing, middleware, RSC). The mobile app
 * uses `use-intl`, the framework-agnostic core next-intl is built on, so
 * screens call the same `useTranslations('dashboard')` API and read the
 * same ICU catalogues from @herp/i18n.
 */
import { useEffect, type ReactNode } from 'react';
import { I18nManager } from 'react-native';
import * as Updates from 'expo-updates';
import { getLocales } from 'expo-localization';
import { IntlProvider } from 'use-intl';
import { defaultLocale, getDirection, localeMeta, matchLocale, type Locale } from '@herp/i18n';
import ar from '@herp/i18n/messages/ar.json';
import en from '@herp/i18n/messages/en.json';
import hi from '@herp/i18n/messages/hi.json';
import tl from '@herp/i18n/messages/tl.json';
import am from '@herp/i18n/messages/am.json';
import bn from '@herp/i18n/messages/bn.json';

const catalogues = { ar, en, hi, tl, am, bn } satisfies Record<Locale, unknown>;

/** Server preference (users.preferredLocale) wins; else the device language; else Arabic. */
export function pickLocale(userPreferred?: Locale | null): Locale {
  return userPreferred ?? getLocales().map((l) => matchLocale(l.languageTag)).find(Boolean) ?? defaultLocale;
}

export function IntlRoot({ locale, children }: { locale: Locale; children: ReactNode }) {
  useEffect(() => {
    // React Native applies RTL at startup only: flip and reload when it changes.
    const rtl = getDirection(locale) === 'rtl';
    if (I18nManager.isRTL !== rtl) {
      I18nManager.allowRTL(rtl);
      I18nManager.forceRTL(rtl);
      void Updates.reloadAsync();
    }
  }, [locale]);

  return (
    <IntlProvider locale={localeMeta[locale].intlTag} messages={catalogues[locale]} timeZone="Asia/Riyadh">
      {children}
    </IntlProvider>
  );
}
