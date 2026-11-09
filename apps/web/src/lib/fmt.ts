import { getFormatter, getLocale } from 'next-intl/server';
import { localeMeta, type Locale } from '@herp/i18n';

/** Locale-aware money, numbers and dates for server components. */
export async function fmt() {
  const [f, locale] = await Promise.all([getFormatter(), getLocale()]);
  const hijriFmt = new Intl.DateTimeFormat(`${localeMeta[locale as Locale]?.intlTag ?? locale}-u-ca-islamic-umalqura`, { dateStyle: 'long', timeZone: 'Asia/Riyadh' });
  const d = (v: string | null | undefined, style: 'medium' | 'long' = 'medium') =>
    v ? f.dateTime(new Date(v.length === 10 ? `${v}T12:00:00Z` : v), { dateStyle: style }) : '—';
  return {
    money: (v: string | number | null | undefined, currency = 'SAR') => (v == null ? '—' : f.number(Number(v), { style: 'currency', currency })),
    num: (v: number | string | null | undefined, digits = 0) => (v == null ? '—' : f.number(Number(v), { maximumFractionDigits: digits })),
    date: d,
    hijri: (v: string) => hijriFmt.format(new Date(`${v}T12:00:00Z`)),
    weekday: (v: string) => f.dateTime(new Date(`${v}T12:00:00Z`), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    monthName: (v: string) => f.dateTime(new Date(`${v.slice(0, 10)}T12:00:00Z`), { month: 'long', year: 'numeric' }),
    monthShort: (v: string) => f.dateTime(new Date(`${v.slice(0, 10)}T12:00:00Z`), { month: 'short' }),
    dayMonth: (v: string) => f.dateTime(new Date(v.length === 10 ? `${v}T12:00:00Z` : v), { day: 'numeric', month: 'long' }),
  };
}
