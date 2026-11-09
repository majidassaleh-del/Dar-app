'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { localeMeta, locales, type Locale } from '@herp/i18n';
import { usePathname, useRouter } from '@/i18n/navigation';

export function LocaleSwitcher() {
  const t = useTranslations('common');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const pathname = usePathname();
  const [pending, start] = useTransition();
  return (
    <select aria-label={t('language')} value={locale} disabled={pending} className="field-header"
      onChange={(e) => start(() => router.replace(pathname, { locale: e.target.value as Locale }))}>
      {locales.map((l) => <option key={l} value={l} lang={l}>{localeMeta[l].endonym}</option>)}
    </select>
  );
}
