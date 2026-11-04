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
    <label>
      <span className="muted" style={{ marginInlineEnd: '.5rem' }}>{t('language')}</span>
      <select
        value={locale}
        disabled={pending}
        onChange={(e) => start(() => router.replace(pathname, { locale: e.target.value as Locale }))}
      >
        {locales.map((l) => <option key={l} value={l} lang={l}>{localeMeta[l].endonym}</option>)}
      </select>
    </label>
  );
}
