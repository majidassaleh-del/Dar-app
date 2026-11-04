import { IntlMessageFormat } from 'intl-messageformat';
import { loadMessages, localeMeta, type Locale } from '@herp/i18n';

export type ReminderKind = 'document' | 'medical' | 'training' | 'handover';

/** Render a reminder in the recipient's language from the shared ICU catalogue. */
export async function renderReminder(locale: Locale, kind: ReminderKind, p: { name: string; itemKey: string; days: number }) {
  const m = (await loadMessages(locale)) as unknown as { notify: { title: Record<ReminderKind, string>; item: Record<string, string> } & Record<ReminderKind, string> };
  const item = m.notify.item[p.itemKey] ?? m.notify.item[kind === 'document' ? 'DOCUMENT' : kind === 'training' ? 'TRAINING' : 'ITEM'] ?? p.itemKey;
  const body = new IntlMessageFormat(m.notify[kind], localeMeta[locale].intlTag).format({ name: p.name, item, days: Math.max(0, p.days) }) as string;
  return { title: m.notify.title[kind], body, item };
}

/**
 * WhatsApp Cloud API language codes for our locales. Tagalog templates are
 * registered as Filipino ("fil"). Amharic falls back to English templates: I
 * could not confirm Amharic support for WhatsApp message templates; push and
 * in-app still go out in Amharic.
 */
export const WHATSAPP_LANG: Record<Locale, string> = { ar: 'ar', en: 'en_US', hi: 'hi', tl: 'fil', bn: 'bn', am: 'en_US' };
export const WHATSAPP_TEMPLATE: Record<ReminderKind, string> = {
  document: 'herp_document_expiry', medical: 'herp_medical_due', training: 'herp_training_due', handover: 'herp_item_return',
};
