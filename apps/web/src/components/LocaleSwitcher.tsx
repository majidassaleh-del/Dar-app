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
    <label className="flex items-center gap-2 text-xs text-header-muted">
      <span className="sr-only sm:not-sr-only">{t('language')}</span>
      <select value={locale} disabled={pending} onChange={(e) => start(() => router.replace(pathname, { locale: e.target.value as Locale }))}
        className="h-8 rounded-lg border border-white/10 bg-white/5 px-2 text-sm text-header-foreground outline-none focus-visible:ring-2 focus-visible:ring-[#d97706]/60 [&>option]:text-[#022c22]">
        {locales.map((l) => <option key={l} value={l} lang={l}>{localeMeta[l].endonym}</option>)}
      </select>
    </label>
  );
}
