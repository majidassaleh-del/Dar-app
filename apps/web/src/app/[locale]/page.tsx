import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { localeMeta, resolveI18n, type I18nText, type Locale } from '@herp/i18n';
import { Link } from '@/i18n/navigation';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';

// Demo data standing in for API responses.
const instruction: { textI18n: I18nText; originalLocale: Locale } = {
  textI18n: { ar: 'أحمد لديه حساسية من الفول السوداني', en: 'Ahmed is allergic to peanuts', tl: 'May allergy sa mani si Ahmed' },
  originalLocale: 'ar',
};

export default async function Dashboard({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const format = await getFormatter();
  const today = new Date('2026-11-04T09:00:00+03:00');
  const shown = resolveI18n(instruction.textI18n, { locale, originalLocale: instruction.originalLocale });

  return (
    <>
      <header>
        <strong>{t('app.name')}</strong>
        <nav aria-label="main">
          <ul>
            {(['dashboard', 'staff', 'finance', 'pettyCash', 'workOrders', 'travel', 'policies'] as const).map((k) => (
              <li key={k}><Link href="/">{t(`nav.${k}`)}</Link></li>
            ))}
          </ul>
        </nav>
        <LocaleSwitcher />
      </header>
      <main>
        <section className="card">
          <h2>{t('dashboard.greeting', { name: locale === 'ar' ? 'ماجد' : 'Majid' })}</h2>
          <p className="muted">
            {t('dashboard.today', { date: format.dateTime(today, { dateStyle: 'full' }) })}
            {' · '}
            {new Intl.DateTimeFormat(`${localeMeta[locale].intlTag}-u-ca-islamic-umalqura-nu-latn`, { dateStyle: 'long', timeZone: 'Asia/Riyadh' }).format(today)}
          </p>
        </section>
        <section className="card">
          <p>{t('dashboard.pendingApprovals', { count: 2 })}</p>
          <p>{t('dashboard.expiringDocuments', { count: 3, days: 30 })}</p>
        </section>
        <section className="card">
          <h2>{t('nav.pettyCash')}</h2>
          <p>{t('pettyCash.balance', { amount: format.number(380, 'sar') })} <span className="badge">{t('pettyCash.pendingReview')}</span></p>
        </section>
        <section className="card">
          <h2>{t('nav.workOrders')} <span className="badge">{t('workOrder.status.ASSIGNED')}</span></h2>
          <p><bdi>{shown.text}</bdi></p>
          {shown.translated && (
            <p className="muted">{t('workOrder.translatedBadge', { language: localeMeta[instruction.originalLocale].endonym })}</p>
          )}
        </section>
      </main>
    </>
  );
}
