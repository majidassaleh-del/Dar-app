import type { Locale } from './config';
import type en from '../messages/en.json';

export type Messages = typeof en;

/** One explicit import per locale so bundlers (webpack, Metro) emit one lazy chunk each. */
const loaders: Record<Locale, () => Promise<{ default: Messages }>> = {
  ar: () => import('../messages/ar.json'),
  en: () => import('../messages/en.json'),
  hi: () => import('../messages/hi.json'),
  tl: () => import('../messages/tl.json'),
  am: () => import('../messages/am.json'),
  bn: () => import('../messages/bn.json'),
};

export async function loadMessages(locale: Locale): Promise<Messages> {
  return (await loaders[locale]()).default;
}
