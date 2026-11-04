import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Locale } from '@herp/i18n';
import { AppShell } from '@/components/AppShell';

/** First-time onboarding, mirroring GET /v1/auth/onboarding ({ phone, email, authenticator, next }); sample state. */
const state = { phone: true, email: true, authenticator: false, device: false };
const ORDER = ['phone', 'email', 'authenticator', 'device'] as const;

export default async function Onboarding({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('exec.onboarding');
  const current = ORDER.find((s) => !state[s]);
  return (
    <AppShell title={t('title')} subtitle={t('subtitle')}>
      <ol className="steps">
        {ORDER.map((s) => (
          <li key={s} data-state={state[s] ? 'done' : s === current ? 'current' : 'todo'}>
            <span>{t(`step.${s}`)}</span>
            <span className="spacer" />
            {state[s] ? <span className="chip ok">{t('done')}</span> : s === current ? <button className="button" type="button">{t('next')}</button> : null}
          </li>
        ))}
      </ol>
    </AppShell>
  );
}
