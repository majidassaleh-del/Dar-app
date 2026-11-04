'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { useTranslations } from 'next-intl';
import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/utils';

const OPTIONS = [{ value: 'light', Icon: Sun }, { value: 'dark', Icon: Moon }, { value: 'system', Icon: Monitor }] as const;

export function ThemeToggle() {
  const t = useTranslations('exec.theme');
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div role="radiogroup" aria-label={t('toggle')} className="inline-flex rounded-md border border-sidebar-border p-0.5">
      {OPTIONS.map(({ value, Icon }) => (
        <button key={value} type="button" role="radio" aria-checked={mounted && theme === value} title={t(value)} onClick={() => setTheme(value)}
          className={cn('inline-flex size-7 items-center justify-center rounded-sm text-sidebar-muted transition-colors hover:text-sidebar-foreground',
            mounted && theme === value && 'bg-sidebar-accent text-sidebar-foreground')}>
          <Icon className="size-3.5" aria-hidden="true" /><span className="sr-only">{t(value)}</span>
        </button>
      ))}
    </div>
  );
}
