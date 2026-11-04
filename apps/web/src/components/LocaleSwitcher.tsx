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
    <label className="grid gap-1 text-xs text-sidebar-muted">
      {t('language')}
      <select value={locale} disabled={pending} onChange={(e) => start(() => router.replace(pathname, { locale: e.target.value as Locale }))}
        className="h-8 w-full rounded-md border border-sidebar-border bg-sidebar-accent px-2 text-sm text-sidebar-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        {locales.map((l) => <option key={l} value={l} lang={l}>{localeMeta[l].endonym}</option>)}
      </select>
    </label>
  );
}
