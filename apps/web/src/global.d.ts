import type { Messages } from '@herp/i18n';
import type { routing } from './i18n/routing';

// Type-safe keys: t('dashboard.greeting') autocompletes; a typo is a compile error.
declare module 'next-intl' {
  interface AppConfig {
    Locale: (typeof routing.locales)[number];
    Messages: Messages;
  }
}
