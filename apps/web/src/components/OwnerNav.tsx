import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { loose } from '@/lib/sections';

/** The owner's two screens, side by side: members (with roles and permissions) and invitations. */
export async function OwnerNav({ current }: { current: 'members' | 'invitations' }) {
  const t = loose(await getTranslations('ui'));
  const item = (key: 'members' | 'invitations', label: string) => (
    <Link href={`/${key}`} aria-current={key === current ? 'page' : undefined}
      className={`border-b-[3px] px-1 pb-2 text-[15px] ${key === current ? 'border-brass font-semibold text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>{label}</Link>
  );
  return <nav className="flex gap-6 border-b border-hairline">{item('members', t('members.nav'))}{item('invitations', t('invite.nav'))}</nav>;
}

/** Outcome of the last action (a redirect carries ?ok=1 or ?e=code). */
export async function Notice({ sp }: { sp: { ok?: string; e?: string } }): Promise<ReactNode> {
  const t = loose(await getTranslations('ui'));
  const E = ['owner', 'inUse', 'rule', 'failed', 'name'];
  if (sp.e && E.includes(sp.e)) return <p role="alert" className="rounded-md bg-critical-soft px-3 py-2 text-sm text-critical">{t(`members.e.${sp.e}`)}</p>;
  if (sp.ok) return <p role="status" className="rounded-md bg-selected px-3 py-2 text-sm text-primary">{t('members.saved')}</p>;
  return null;
}
