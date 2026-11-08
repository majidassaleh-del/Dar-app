import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Locale } from '@herp/i18n';
import { Shell } from '@/components/Shell';
import { loadSession } from '@/lib/dashboard';
import { cn } from '@/lib/utils';

/** First-time onboarding, mirroring GET /v1/auth/onboarding; sample state. */
const state = { phone: true, email: true, authenticator: false, device: false };
const STEPS = ['phone', 'email', 'authenticator', 'device'] as const;

export default async function Onboarding({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [t, s] = await Promise.all([getTranslations('exec.onboarding'), loadSession(locale)]);
  const current = STEPS.find((k) => !state[k]);
  return (
    <Shell current={null} households={s.households} household={s.current} mode={s.mode} back={`/${locale}/onboarding`}>
      <div className="max-w-xl px-5 py-8 sm:px-8">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground">{t('subtitle')}</p>
        <ol className="mt-6 grid list-decimal ps-6">
          {STEPS.map((k) => {
            const done = state[k], active = k === current;
            return (
              <li key={k} className="border-t py-3">
                <span className="flex items-center justify-between gap-4">
                  <span className={cn(!done && !active && 'text-muted-foreground', active && 'font-semibold')}>{t(`step.${k}`)}</span>
                  {done ? <span className="text-xs text-ok">{t('done')}</span> : active ? <button type="button" className="btn btn-primary h-8">{t('next')}</button> : null}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </Shell>
  );
}
