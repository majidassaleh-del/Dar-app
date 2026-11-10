import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Locale } from '@herp/i18n';
import { Link } from '@/i18n/navigation';
import { Shell } from '@/components/Shell';
import { Notice } from '@/components/OwnerNav';
import { PageHead, Panel } from '@/components/ListDetail';
import { PermissionGrid } from '@/components/PermissionGrid';
import { apiGet } from '@/lib/api';
import { loadSession } from '@/lib/dashboard';
import { deleteRole, renameRole, saveRolePermissions } from '@/lib/member-actions';
import { SCOPES } from '@/lib/permissions';
import { loose, type Rows } from '@/lib/sections';

export const dynamic = 'force-dynamic';

interface View { role: { id: string; systemRole: string; custom: boolean; name: string; baseName: string | null; members: number; locked: boolean };
  permissions: Array<{ id: string; module: string; description: string | null; scope: string | null }> }

/** Owner only: what a role may do. Custom roles can also be renamed, and deleted once nobody holds them. */
export default async function RolePage({ params, searchParams }: { params: Promise<{ locale: Locale; id: string }>; searchParams: Promise<{ ok?: string; e?: string }> }) {
  const { locale, id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  setRequestLocale(locale);
  const [sp, session, t0] = await Promise.all([searchParams, loadSession(locale), getTranslations('ui')]);
  const t = loose(t0);
  const owner = !!session.opts && !!session.current.owner;
  const [v, roles] = owner ? await Promise.all([apiGet<View>(`/v1/roles/${id}/permissions`, session.opts!), apiGet<Rows<{ id: string; nameI18n: Record<string, string> }>>('/v1/roles', session.opts!)]) : [null, null];
  if (!v) notFound();
  const names = roles?.data.find((r) => r.id === id)?.nameI18n ?? {};
  const granted = v.permissions.filter((p) => p.scope).length;
  const hidden = <><input type="hidden" name="locale" value={locale} /><input type="hidden" name="id" value={id} /></>;
  return (
    <Shell current={null} households={session.households} household={session.current} mode={session.mode} pendingRequests={session.pendingRequests} back={`/${locale}/members/roles/${id}`}>
      <div className="mx-auto flex max-w-[960px] flex-col gap-6 px-4 py-8 sm:px-8">
        <Link href="/members" className="link text-sm">{t('members.back')}</Link>
        <PageHead title={t('members.permsOfRole', { role: v.role.name })}
          summary={v.role.custom ? t('members.basedOn', { base: v.role.baseName ?? v.role.systemRole }) : t('members.builtIn')}
          stats={[{ label: t('members.holders'), value: String(v.role.members) }, { label: t('members.granted'), value: `${granted} / ${v.permissions.length}` }]} />
        <Notice sp={sp} />
        {v.role.custom && (
          <Panel title={t('members.roleName')}>
            <form action={renameRole} className="grid gap-3.5 sm:grid-cols-[1fr_1fr_auto] sm:items-end">{hidden}
              <label className="flex min-w-0 flex-col gap-1.5"><span className="text-xs text-muted-foreground">{t('members.roleNameAr')}</span>
                <input name="nameAr" maxLength={60} dir="rtl" defaultValue={names.ar ?? ''} className="field h-11 min-w-0" /></label>
              <label className="flex min-w-0 flex-col gap-1.5"><span className="text-xs text-muted-foreground">{t('members.roleNameEn')}</span>
                <input name="name" maxLength={60} dir="ltr" defaultValue={names.en ?? ''} className="field h-11 min-w-0 text-start" /></label>
              <button type="submit" className="btn h-11 px-5">{t('members.save')}</button>
            </form>
            <form action={deleteRole} className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-4">{hidden}
              <span className="text-xs text-muted-foreground">{t('members.deleteHint')}</span>
              <button type="submit" className="link text-sm text-critical">{t('members.deleteRole')}</button>
            </form>
          </Panel>
        )}
        {v.role.locked ? <p className="panel px-6 py-5 text-muted-foreground">{t('members.locked')}</p> : (
          <form action={saveRolePermissions} className="flex flex-col gap-6">{hidden}
            <p className="text-sm text-muted-foreground">{t('members.permsRoleHint')}</p>
            <PermissionGrid controlHead={t('members.scopeLabel')}
              rows={v.permissions.map((p) => ({ id: p.id, module: p.module, description: p.description,
                control: (
                  <select name={`p:${p.id}`} defaultValue={p.scope ?? ''} aria-label={t('members.scopeLabel')} className={`field h-9 w-full ${p.scope ? 'font-semibold' : 'text-muted-foreground'}`}>
                    <option value="">{t('members.notGranted')}</option>
                    {SCOPES.map((s) => <option key={s} value={s}>{t(`members.scope.${s}`)}</option>)}
                  </select>
                ) }))} />
            <div className="sticky bottom-0 -mx-4 flex justify-end border-t border-hairline bg-background/95 px-4 py-3 sm:-mx-8 sm:px-8">
              <button type="submit" className="btn btn-primary h-11 px-8 text-[15px]">{t('members.savePerms')}</button>
            </div>
          </form>
        )}
      </div>
    </Shell>
  );
}
