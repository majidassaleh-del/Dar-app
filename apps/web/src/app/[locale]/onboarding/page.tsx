import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Check, Fingerprint, KeyRound, Mail, Smartphone } from 'lucide-react';
import type { Locale } from '@herp/i18n';
import { AppShell } from '@/components/AppShell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** First-time onboarding, mirroring GET /v1/auth/onboarding; sample state. */
const state = { phone: true, email: true, authenticator: false, device: false };
const STEPS = [{ key: 'phone', Icon: Smartphone }, { key: 'email', Icon: Mail }, { key: 'authenticator', Icon: KeyRound }, { key: 'device', Icon: Fingerprint }] as const;

export default async function Onboarding({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('exec.onboarding');
  const current = STEPS.find((s) => !state[s.key])?.key;
  return (
    <AppShell title={t('title')} subtitle={t('subtitle')}>
      <Card className="max-w-2xl py-2">
        <CardContent className="px-0">
          <ol className="divide-y divide-slate-200 dark:divide-slate-800">
            {STEPS.map(({ key, Icon }, i) => {
              const done = state[key], active = key === current;
              return (
                <li key={key} className="flex items-center gap-4 px-5 py-4">
                  <span className={cn('grid size-9 shrink-0 place-items-center rounded-full border text-sm font-medium tabular-nums',
                    done ? 'border-transparent bg-ok-soft text-ok' : active ? 'border-transparent bg-primary text-primary-foreground' : 'border-slate-200 text-muted-foreground dark:border-slate-800')}>
                    {done ? <Check className="size-4" aria-hidden="true" /> : i + 1}
                  </span>
                  <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className={cn('flex-1 text-sm', !done && !active && 'text-muted-foreground')}>{t(`step.${key}`)}</span>
                  {done ? <Badge variant="ok">{t('done')}</Badge> : active ? <Button size="sm">{t('next')}</Button> : null}
                </li>
              );
            })}
          </ol>
        </CardContent>
      </Card>
    </AppShell>
  );
}
