import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Locale } from '@herp/i18n';
import { Link } from '@/i18n/navigation';
import { Shell } from '@/components/Shell';
import { Notice } from '@/components/OwnerNav';
import { PageHead } from '@/components/ListDetail';
import { PermissionGrid } from '@/components/PermissionGrid';
import { apiGet } from '@/lib/api';
import { loadSession } from '@/lib/dashboard';
import { saveMemberPermissions } from '@/lib/member-actions';
import { SCOPES } from '@/lib/permissions';
import { loose } from '@/lib/sections';

export const dynamic = 'force-dynamic';

interface View { member: { id: string; name: string | null; status: string; role: { name: string }; locked: boolean };
  permissions: Array<{ id: string; module: string; description: string | null; role: string | null; override: { granted: boolean; scope: string | null } | null }> }

/** Owner only: one member's permissions. Each line follows the role unless the owner denies it or grants it here. */
export default async function MemberPermissionsPage({ params, searchParams }: { params: Promise<{ locale: Locale; id: string }>; searchParams: Promise<{ ok?: string; e?: string }> }) {
  const { locale, id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  setRequestLocale(locale);
  const [sp, session, t0] = await Promise.all([searchParams, loadSession(locale), getTranslations('ui')]);
  const t = loose(t0);
  const v = session.opts && session.current.owner ? await apiGet<View>(`/v1/members/${id}/permissions`, session.opts) : null;
  if (!v) notFound();
  const changed = v.permissions.filter((p) => p.override).length;
  return (
    <Shell current={null} households={session.households} household={session.current} mode={session.mode} pendingRequests={session.pendingRequests} back={`/${locale}/members/${id}`}>
      <form action={saveMemberPermissions} className="mx-auto flex max-w-[960px] flex-col gap-6 px-4 py-8 sm:px-8">
        <input type="hidden" name="locale" value={locale} /><input type="hidden" name="id" value={id} />
        <Link href="/members" className="link text-sm">{t('members.back')}</Link>
        <PageHead title={t('members.permsOfMember', { name: v.member.name ?? '—' })} summary={t('members.permsMemberHint', { role: v.member.role.name })}
          stats={[{ label: t('members.role'), value: v.member.role.name }, { label: t('members.overrides'), value: String(changed), tone: changed ? 'brass' : undefined }]} />
        <Notice sp={sp} />
        {v.member.locked ? <p className="panel px-6 py-5 text-muted-foreground">{t('members.locked')}</p> : (
          <>
            <PermissionGrid noteHead={t('members.fromRole')} controlHead={t('members.override')}
              rows={v.permissions.map((p) => ({ id: p.id, module: p.module, description: p.description,
                note: `${t('members.fromRole')}: ${p.role ? t(`members.scope.${p.role}`) : t('members.notGranted')}`,
                control: (
                  <select name={`o:${p.id}`} defaultValue={p.override ? (p.override.granted ? p.override.scope ?? 'ALL' : 'DENY') : ''} aria-label={t('members.override')}
                    className={`field h-9 w-full ${p.override ? 'border-brass font-semibold' : ''}`}>
                    <option value="">{t('members.inherit')}</option>
                    <option value="DENY">{t('members.deny')}</option>
                    {SCOPES.map((s) => <option key={s} value={s}>{t('members.allow', { scope: t(`members.scope.${s}`) })}</option>)}
                  </select>
                ) }))} />
            <div className="sticky bottom-0 -mx-4 flex justify-end border-t border-hairline bg-background/95 px-4 py-3 sm:-mx-8 sm:px-8">
              <button type="submit" className="btn btn-primary h-11 px-8 text-[15px]">{t('members.savePerms')}</button>
            </div>
          </>
        )}
      </form>
    </Shell>
  );
}
