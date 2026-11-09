'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { useTranslations } from 'next-intl';

/** Light / dark / follow the device, as a plain select. */
export function ThemeToggle() {
  const t = useTranslations('exec.theme');
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <select aria-label={t('toggle')} value={mounted ? theme : 'system'} onChange={(e) => setTheme(e.target.value)} className="field-header">
      {(['system', 'light', 'dark'] as const).map((v) => <option key={v} value={v}>{t(v)}</option>)}
    </select>
  );
}
