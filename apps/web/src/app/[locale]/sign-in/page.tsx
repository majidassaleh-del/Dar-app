import QRCode from 'qrcode';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Locale } from '@herp/i18n';
import { Link } from '@/i18n/navigation';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { enrolConfirm, enrolStart, finishSignIn, resendCode, setupStart, setupVerify, signInState, startSignIn, verifySignIn } from '@/lib/auth-actions';
import { loose } from '@/lib/sections';

export const dynamic = 'force-dynamic';

const STEPS = ['address', 'code', 'setup-phone', 'setup-phone-code', 'setup-email', 'setup-email-code', 'enrol', 'enrol-scan', 'totp'] as const;
type Step = (typeof STEPS)[number];
const ERRORS = ['address', 'code', 'expired', 'unavailable', 'tooMany', 'locked', 'used', 'resent', 'enrolled', 'signedOut', 'denied', 'invited'] as const;
const INFO = ['resent', 'enrolled', 'signedOut', 'invited'];

/** Sign-in: provider code → (first time: phone, email, authenticator) → authenticator code → session. */
export default async function SignIn({ params, searchParams }: { params: Promise<{ locale: Locale }>; searchParams: Promise<{ step?: string; e?: string; expired?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [sp, t0, s] = await Promise.all([searchParams, getTranslations('ui'), signInState()]);
  const t = loose(t0);
  let step: Step = (STEPS as readonly string[]).includes(sp.step ?? '') ? (sp.step as Step) : 'address';
  if (step !== 'address' && step !== 'code' && !s.hasProviderToken) step = 'address';
  if (step === 'code' && !s.address) step = 'address';
  const err = sp.expired ? 'expired' : (ERRORS as readonly string[]).includes(sp.e ?? '') ? sp.e! : null;
  const qr = step === 'enrol-scan' && s.otpauthUri ? await QRCode.toString(s.otpauthUri, { type: 'svg', margin: 1, width: 196, color: { dark: '#0f3d2e', light: '#ffffff' } }) : null;
  const secret = s.otpauthUri ? new URL(s.otpauthUri).searchParams.get('secret') : null;
  const phase = step === 'address' || step === 'code' ? 1 : step === 'totp' ? 3 : 2;

  const hidden = <input type="hidden" name="locale" value={locale} />;
  const codeInput = (autoFocus = true) => (
    <input name="code" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9٠-٩ ]{6,7}" maxLength={7} autoFocus={autoFocus}
      className="field h-12 w-full text-center text-xl tracking-[0.4em] tabular" dir="ltr" placeholder="••••••" aria-label={t('auth.codeLabel')} />
  );
  const submit = (label: string) => <button type="submit" className="btn btn-primary h-11 w-full text-[15px]">{label}</button>;

  let body;
  if (step === 'address') body = (
    <form action={startSignIn} className="flex flex-col gap-4">{hidden}
      <label className="flex flex-col gap-1.5"><span className="text-xs text-muted-foreground">{t('auth.addressLabel')}</span>
        <input name="address" required autoFocus autoComplete="username" dir="ltr" className="field h-11 text-start" placeholder="05xxxxxxxx · name@example.com" /></label>
      {submit(t('auth.sendCode'))}
    </form>
  );
  else if (step === 'code') body = (
    <>
      <form action={verifySignIn} className="flex flex-col gap-4">{hidden}{codeInput()}{submit(t('auth.verify'))}</form>
      <div className="flex justify-between gap-3 text-sm">
        <form action={resendCode}>{hidden}<button type="submit" className="link">{t('auth.resend')}</button></form>
        <Link href="/sign-in" className="link">{t('auth.changeAddress')}</Link>
      </div>
    </>
  );
  else if (step === 'setup-phone' || step === 'setup-email') {
    const kind = step === 'setup-phone' ? 'phone' : 'email';
    body = (
      <form action={setupStart} className="flex flex-col gap-4">{hidden}<input type="hidden" name="kind" value={kind} />
        <label className="flex flex-col gap-1.5"><span className="text-xs text-muted-foreground">{t(kind === 'phone' ? 'auth.phoneLabel' : 'auth.emailLabel')}</span>
          <input name="address" required autoFocus dir="ltr" defaultValue={(kind === 'phone' ? s.rawPhone : s.rawEmail) ?? ''} className="field h-11 text-start"
            inputMode={kind === 'phone' ? 'tel' : 'email'} placeholder={kind === 'phone' ? '05xxxxxxxx' : 'name@example.com'} /></label>
        {submit(t('auth.sendCode'))}
      </form>
    );
  } else if (step === 'setup-phone-code' || step === 'setup-email-code') body = (
    <form action={setupVerify} className="flex flex-col gap-4">{hidden}{codeInput()}{submit(t('auth.verify'))}</form>
  );
  else if (step === 'enrol') body = (
    <form action={enrolStart} className="flex flex-col gap-4">{hidden}
      <ol className="list-decimal space-y-1.5 ps-5 text-sm text-muted-foreground">
        <li>{t('auth.enrolStep1')}</li><li>{t('auth.enrolStep2')}</li><li>{t('auth.enrolStep3')}</li>
      </ol>
      {submit(t('auth.enrolStart'))}
    </form>
  );
  else if (step === 'enrol-scan') body = (
    <form action={enrolConfirm} className="flex flex-col items-center gap-4">{hidden}
      {qr ? <div className="rounded-lg border border-border bg-white p-2" dangerouslySetInnerHTML={{ __html: qr }} /> : <p className="text-critical">{t('auth.e.expired')}</p>}
      {secret && <p className="text-center text-xs text-muted-foreground">{t('auth.manualKey')}<br /><span dir="ltr" className="select-all break-all font-mono text-foreground">{secret.match(/.{1,4}/g)?.join(' ')}</span></p>}
      <div className="w-full">{codeInput(false)}</div>
      {submit(t('auth.enrolConfirm'))}
    </form>
  );
  else body = (
    <form action={finishSignIn} className="flex flex-col gap-4">{hidden}{codeInput()}{submit(t('auth.signIn'))}</form>
  );

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
        <section className="panel w-full max-w-[440px] overflow-hidden">
          <div className="border-b border-hairline px-6 py-5">
            <div className="mb-3 flex gap-1.5" aria-label={t('auth.progress', { step: phase, total: 3 })}>
              {[1, 2, 3].map((n) => <span key={n} className={`h-1 flex-1 rounded-full ${n <= phase ? 'bg-brass' : 'bg-track'}`} />)}
            </div>
            <h1 className="text-2xl">{t(`auth.title.${step}`)}</h1>
            <p className="text-sm text-muted-foreground">{t(`auth.hint.${step}`, { address: (step.startsWith('setup') && step.endsWith('code') ? s.setupTo : s.address) ?? '' })}</p>
          </div>
          <div className="flex flex-col gap-4 px-6 py-5">
            {err && <p role={INFO.includes(err) ? 'status' : 'alert'} className={`rounded-md px-3 py-2 text-sm ${INFO.includes(err) ? 'bg-selected text-primary' : 'bg-critical-soft text-critical'}`}>{t(`auth.e.${err}`)}</p>}
            {body}
          </div>
          <p className="border-t border-hairline bg-muted px-6 py-3 text-xs text-muted-foreground">{t('auth.footer')}</p>
        </section>
      </main>
    </div>
  );
}
