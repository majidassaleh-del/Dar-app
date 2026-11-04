import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IntlMessageFormat } from 'intl-messageformat';
import { getDirection, localeMeta, locales, negotiateLocale, matchLocale, resolveI18n, missingLocales, type Locale } from '../src';

const load = (l: Locale) => JSON.parse(readFileSync(new URL(`../messages/${l}.json`, import.meta.url), 'utf8'));
const flatten = (o: Record<string, unknown>, p = ''): Record<string, string> =>
  Object.entries(o).reduce<Record<string, string>>((acc, [k, v]) =>
    typeof v === 'string' ? { ...acc, [p + k]: v } : { ...acc, ...flatten(v as Record<string, unknown>, `${p}${k}.`) }, {});

describe('catalogues', () => {
  const ref = Object.keys(flatten(load('en'))).sort();
  it.each(locales)('%s has exactly the same keys as en', (l) => {
    expect(Object.keys(flatten(load(l))).sort()).toEqual(ref);
  });
  it.each(locales)('%s: every message is valid ICU and formats', (l) => {
    for (const [key, msg] of Object.entries(flatten(load(l)))) {
      const out = new IntlMessageFormat(msg, localeMeta[l].intlTag).format({ name: 'X', count: 3, days: 30, date: 'D', amount: 'A', language: 'L' });
      expect(String(out), key).not.toMatch(/\{|\}/);
    }
  });
  it('Arabic uses the dual and few/many plural forms correctly', () => {
    const msg = load('ar').dashboard.pendingApprovals;
    const f = (count: number) => new IntlMessageFormat(msg, 'ar-SA').format({ count });
    expect(f(0)).toBe('لا توجد طلبات بانتظار موافقتك');
    expect(f(1)).toBe('طلب واحد بانتظار موافقتك');
    expect(f(2)).toBe('طلبان بانتظار موافقتك');
    expect(f(5)).toMatch(/طلبات/);   // few: 3–10
    expect(f(11)).toMatch(/طلباً/);  // many: 11–99
  });
});

describe('direction & negotiation', () => {
  it('only Arabic is RTL', () => {
    expect(locales.filter((l) => getDirection(l) === 'rtl')).toEqual(['ar']);
  });
  it('maps device tags', () => {
    expect(matchLocale('fil-PH')).toBe('tl');
    expect(matchLocale('ar-EG')).toBe('ar');
    expect(matchLocale('fr-FR')).toBeUndefined();
  });
  it('negotiates Accept-Language by q', () => {
    expect(negotiateLocale('fr;q=1, bn;q=0.9, en;q=0.8')).toBe('bn');
    expect(negotiateLocale('de, fr')).toBe('ar');
    expect(negotiateLocale(undefined, 'en')).toBe('en');
  });
});

describe('resolveI18n', () => {
  const v = { ar: 'أحمد لديه حساسية من الفول السوداني', tl: 'May allergy sa mani si Ahmed' };
  it('shows the requested translation and flags it', () => {
    expect(resolveI18n(v, { locale: 'tl', originalLocale: 'ar' })).toEqual({ text: v.tl, locale: 'tl', translated: true });
  });
  it('falls back to the original when the requested locale is missing', () => {
    expect(resolveI18n(v, { locale: 'bn', originalLocale: 'ar' })).toMatchObject({ locale: 'ar', translated: false });
  });
  it('lists missing translations', () => {
    expect(missingLocales(v, ['ar', 'tl', 'bn', 'hi'])).toEqual(['bn', 'hi']);
  });
});
