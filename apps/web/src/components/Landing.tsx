import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { openInvitation } from '@/lib/invite-actions';
import { loose } from '@/lib/sections';

/**
 * The public front door (nobody signed in): the owner's entry, the members' entry, and a place
 * to open an invitation. There is no sign-up: without an owner-issued invitation the only
 * answers are "access denied".
 */
export async function Landing({ locale, error }: { locale: string; error?: string }) {
  const t = loose(await getTranslations('ui'));
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="bg-header text-header-foreground">
        <div className="mx-auto flex max-w-[1080px] items-center justify-between gap-4 px-4 py-4 sm:px-8">
          <div className="flex items-center gap-3.5">
            <span aria-hidden="true" className="grid size-12 place-items-center rounded-full border-[1.5px] border-brass outline outline-1 outline-offset-[3px] outline-brass">
              <span className="font-display text-[15px] tracking-[0.06em] text-[#e6cf9c]">DAR</span>
            </span>
            <span className="leading-tight"><span className="block font-display text-xl">{t('office')}</span><span className="block text-xs text-header-muted">{t('officeTagline')}</span></span>
          </div>
          <LocaleSwitcher />
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-[1080px] flex-1 flex-col gap-8 px-4 py-10 sm:px-8 sm:py-16">
        <div className="max-w-[40rem]">
          <h1 className="text-4xl leading-tight sm:text-5xl">{t('landing.title')}</h1>
          <p className="mt-3 text-lg text-muted-foreground">{t('landing.lead')}</p>
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <section className="panel flex flex-col gap-4 border-primary/40 px-6 py-6">
            <div>
              <h2 className="font-display text-2xl">{t('landing.ownerTitle')}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{t('landing.ownerBody')}</p>
            </div>
            <Link href="/sign-in?as=owner" className="btn btn-primary mt-auto h-12 text-base">{t('landing.ownerCta')}</Link>
          </section>
          <section className="panel flex flex-col gap-4 px-6 py-6">
            <div>
              <h2 className="font-display text-2xl">{t('landing.memberTitle')}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{t('landing.memberBody')}</p>
            </div>
            <Link href="/sign-in?as=member" className="btn mt-auto h-12 text-base">{t('landing.memberCta')}</Link>
          </section>
        </div>
        <section className="panel px-6 py-5">
          <h2 className="font-display text-xl">{t('landing.inviteTitle')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('landing.inviteBody')}</p>
          {error === 'token' && <p role="alert" className="mt-3 rounded-md bg-critical-soft px-3 py-2 text-sm text-critical">{t('landing.tokenMissing')}</p>}
          <form action={openInvitation} className="mt-4 flex flex-col gap-3 sm:flex-row">
            <input type="hidden" name="locale" value={locale} />
            <input name="token" required dir="ltr" autoComplete="off" spellCheck={false} aria-label={t('landing.tokenLabel')} placeholder={t('landing.tokenLabel')}
              className="field h-11 w-full min-w-0 shrink-0 text-start text-sm sm:w-auto sm:flex-1 sm:shrink" />
            <button type="submit" className="btn h-11 px-6">{t('landing.inviteCta')}</button>
          </form>
        </section>
      </main>
      <footer className="border-t border-hairline px-4 py-4 text-center text-xs text-muted-foreground">{t('landing.closed')}</footer>
    </div>
  );
}
