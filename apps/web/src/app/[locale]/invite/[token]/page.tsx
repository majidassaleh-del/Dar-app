import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Locale } from '@herp/i18n';
import { Link } from '@/i18n/navigation';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { apiPublic } from '@/lib/api';
import { acceptInvitation } from '@/lib/invite-actions';
import { fmt } from '@/lib/fmt';
import { loose } from '@/lib/sections';

export const dynamic = 'force-dynamic';
// The address carries the token: keep it out of search engines and out of Referer headers.
export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: 'no-referrer' };

interface Preview { household: string; role: string; phone: string | null; email: string | null; expiresAt: string }

/**
 * An invitation link. Opening it only shows who is inviting (link previews in chat apps open
 * links too, so nothing is consumed here); the button accepts. Without a live token: access denied.
 */
export default async function InvitePage({ params, searchParams }: { params: Promise<{ locale: Locale; token: string }>; searchParams: Promise<{ e?: string }> }) {
  const { locale, token } = await params;
  setRequestLocale(locale);
  const [sp, t0, f, p] = await Promise.all([searchParams, getTranslations('ui'), fmt(), apiPublic<Preview>('/v1/auth/invitations/preview', { token }, locale)]);
  const t = loose(t0);
  const ok = p.status === 200 && !!p.body.household;
  const state = ok ? (sp.e === 'member' ? 'member' : sp.e === 'unavailable' ? 'unavailable' : 'ready') : p.status === 403 ? 'denied' : 'unavailable';
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="bg-header text-header-foreground">
        <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-4 px-4 py-4 sm:px-8">
          <div className="flex items-center gap-3.5">
            <span aria-hidden="true" className="grid size-12 place-items-center rounded-full border-[1.5px] border-brass outline outline-1 outline-offset-[3px] outline-brass">
              <span className="font-display text-[15px] tracking-[0.06em] text-[#e6cf9c]">DAR</span>
            </span>
            <span className="leading-tight"><span className="block font-display text-xl">{t('office')}</span><span className="block text-xs text-header-muted">{t('officeTagline')}</span></span>
          </div>
          <LocaleSwitcher />
        </div>
      </header>
      <main className="flex flex-1 items-start justify-center px-4 py-10 sm:py-16">
        <section className="panel w-full max-w-[460px] overflow-hidden">
          <div className="border-b border-hairline px-6 py-5">
            <h1 className="text-2xl">{t(state === 'denied' ? 'invite.deniedTitle' : 'invite.title')}</h1>
            <p className="text-sm text-muted-foreground">{state === 'denied' ? t('invite.deniedBody') : state === 'unavailable' && !ok ? t('auth.e.unavailable') : t('invite.body', { household: p.body.household, role: p.body.role })}</p>
          </div>
          {ok ? (
            <div className="flex flex-col gap-4 px-6 py-5">
              {state !== 'ready' && <p role="alert" className="rounded-md bg-critical-soft px-3 py-2 text-sm text-critical">{t(state === 'member' ? 'invite.e.member' : 'auth.e.unavailable')}</p>}
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">{t('invite.household')}</dt><dd className="font-semibold">{p.body.household}</dd>
                <dt className="text-muted-foreground">{t('invite.role')}</dt><dd>{p.body.role}</dd>
                <dt className="text-muted-foreground">{t('invite.signInWith')}</dt>
                <dd dir="ltr" className="text-start tabular">{[p.body.phone, p.body.email].filter(Boolean).join(' · ')}</dd>
                <dt className="text-muted-foreground">{t('invite.validUntil')}</dt><dd>{f.date(p.body.expiresAt)}</dd>
              </dl>
              <form action={acceptInvitation}>
                <input type="hidden" name="locale" value={locale} /><input type="hidden" name="token" value={token} />
                <button type="submit" className="btn btn-primary h-11 w-full text-[15px]">{t('invite.accept')}</button>
              </form>
            </div>
          ) : state === 'denied' ? (
            <div className="px-6 py-5"><Link href="/sign-in" className="link text-sm">{t('invite.haveAccount')}</Link></div>
          ) : null}
          <p className="border-t border-hairline bg-muted px-6 py-3 text-xs text-muted-foreground">{t(ok ? 'invite.acceptNote' : 'invite.deniedNote')}</p>
        </section>
      </main>
    </div>
  );
}
