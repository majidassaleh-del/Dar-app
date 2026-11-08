import 'server-only';
import { apiGet } from './api';

/** The app's sections, in navigation order. `''` is the daily brief. */
export const SECTIONS = ['staff', 'requests', 'finance', 'petty-cash', 'fleet', 'work-orders'] as const;
export type Section = (typeof SECTIONS)[number];
export const isSection = (s: string): s is Section => (SECTIONS as readonly string[]).includes(s);

/** Pulse deep links (herp://…) → the section that handles them. */
export function sectionForDeepLink(link: string): Section | null {
  const p = link.replace(/^herp:\/\//, '');
  if (/^(staff|compliance|salary-payments|payroll-runs)/.test(p)) return 'staff';
  if (p.startsWith('requests')) return 'requests';
  if (p.startsWith('work-orders')) return 'work-orders';
  if (p.startsWith('petty-cash')) return 'petty-cash';
  if (p.startsWith('fleet')) return 'fleet';
  if (/^(budgets|funding-clearing|transactions)/.test(p)) return 'finance';
  return null;
}

type Opts = { household: string; locale: string };
export type Rows<T> = { data: T[] };

/** membershipId → a name a person recognises: the worker's name, else the member's display name, else their role. */
export async function people(opts: Opts): Promise<Map<string, string>> {
  const [staff, members] = await Promise.all([
    apiGet<Rows<{ membershipId: string | null; name: string }>>('/v1/staff', opts),
    apiGet<Rows<{ id: string; displayName: string | null; role: { name: string } | null }>>('/v1/members', opts),
  ]);
  const m = new Map<string, string>();
  for (const x of members?.data ?? []) m.set(x.id, x.displayName ?? x.role?.name ?? '—');
  for (const s of staff?.data ?? []) if (s.membershipId) m.set(s.membershipId, s.name);
  return m;
}

/** A translated enum label, or a readable fallback for values the catalogue does not list yet. */
type AnyTranslator = { has: (k: never) => boolean; (k: never): string };
type Loose = { has: (k: string) => boolean; (k: string, v?: Record<string, string | number | Date>): string };
/** For keys built at runtime (enum values, section names); the catalogue test keeps every locale complete. */
export const loose = (t: AnyTranslator) => t as unknown as Loose;

export function label(t: AnyTranslator, ns: string, value: string | null | undefined): string {
  if (!value) return '—';
  const k = `${ns}.${value}`, l = loose(t);
  return l.has(k) ? l(k) : value.toLowerCase().replace(/_/g, ' ');
}

export const today = () => new Date().toISOString().slice(0, 10);
