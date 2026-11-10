import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Locale } from '@herp/i18n';
import { Link } from '@/i18n/navigation';
import { Shell } from '@/components/Shell';
import { Notice, OwnerNav } from '@/components/OwnerNav';
import { Dot, PageHead, Panel, Table, type Tone } from '@/components/ListDetail';
import { apiGet } from '@/lib/api';
import { loadSession } from '@/lib/dashboard';
import { fmt } from '@/lib/fmt';
import { createRole, setMemberRole, setMemberStatus } from '@/lib/member-actions';
import { loose, type Rows } from '@/lib/sections';

export const dynamic = 'force-dynamic';

type Status = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
interface Member { id: string; name: string | null; status: Status; roleId: string; joinedAt: string | null; self: boolean; role: { systemRole: string; custom: boolean; name: string } }
interface Role { id: string; systemRole: string; custom: boolean; name: string; baseName: string; members: number }
const TONE: Record<Status, Tone> = { ACTIVE: 'ok', INVITED: 'brass', SUSPENDED: 'critical', REVOKED: 'muted' };
const BASES = ['STAFF', 'DRIVER', 'SPOUSE', 'DEPENDENT', 'ACCOUNTANT', 'GUEST'];

/** Owner only: the roster (role, suspend, remove, permissions) and the household's roles (built-in and custom). */
export default async function MembersPage({ params, searchParams }: { params: Promise<{ locale: Locale }>; searchParams: Promise<{ ok?: string; e?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [sp, session, t0, f] = await Promise.all([searchParams, loadSession(locale), getTranslations('ui'), fmt()]);
  const t = loose(t0);
  const owner = !!session.opts && !!session.current.owner;
  const [members, roles] = owner ? await Promise.all([apiGet<Rows<Member>>('/v1/members', session.opts!), apiGet<Rows<Role>>('/v1/roles', session.opts!)]) : [null, null];
  const rows = members?.data ?? [], roleRows = roles?.data ?? [];
  const hidden = <input type="hidden" name="locale" value={locale} />;
  const act = (id: string, status: Status, label: string, quiet = false) => (
    <form action={setMemberStatus}>{hidden}<input type="hidden" name="id" value={id} /><input type="hidden" name="status" value={status} />
      <button type="submit" className={quiet ? 'link text-sm text-critical' : 'link text-sm'}>{label}</button></form>
  );
  return (
    <Shell current={null} households={session.households} household={session.current} mode={session.mode} pendingRequests={session.pendingRequests} back={`/${locale}/members`}>
      <div className="mx-auto flex max-w-[1280px] flex-col gap-6 px-4 py-8 sm:px-8">
        <PageHead title={t('members.title')} summary={t('members.hint', { household: session.current.name })}
          stats={owner ? [{ label: t('members.st.ACTIVE'), value: f.num(rows.filter((r) => r.status === 'ACTIVE').length), tone: 'ok' },
                          { label: t('members.st.INVITED'), value: f.num(rows.filter((r) => r.status === 'INVITED').length), tone: 'brass' },
                          { label: t('members.st.SUSPENDED'), value: f.num(rows.filter((r) => r.status === 'SUSPENDED').length), tone: 'critical' }] : undefined} />
        {!owner ? <p className="panel px-6 py-5 text-muted-foreground">{t('members.ownerOnly')}</p> : (
          <>
            <OwnerNav current="members" />
            <Notice sp={sp} />
            <Panel title={t('members.roster')} note={t('members.rosterNote')}>
              <Table head={[t('members.person'), t('members.role'), t('members.status'), t('members.since'), '']}
                rows={rows.map((m) => {
                  const locked = m.self || m.status === 'REVOKED';
                  return [
                    <span key="n" className="font-semibold">{m.name ?? '—'}{m.self && <span className="ms-2 text-xs font-normal text-muted-foreground">{t('members.you')}</span>}</span>,
                    locked ? <span key="r">{m.role.name}</span> : (
                      <form key="r" action={setMemberRole} className="flex min-w-0 items-center gap-2">{hidden}<input type="hidden" name="id" value={m.id} />
                        <select name="roleId" defaultValue={m.roleId} aria-label={t('members.role')} className="field h-9 min-w-0 max-w-[14rem]">
                          {roleRows.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                        </select>
                        <button type="submit" className="btn h-9 px-3 text-sm">{t('members.save')}</button>
                      </form>
                    ),
                    <span key="s" className="inline-flex items-center gap-2 whitespace-nowrap"><Dot tone={TONE[m.status]} />{t(`members.st.${m.status}`)}</span>,
                    m.joinedAt ? f.date(m.joinedAt) : '—',
                    m.self ? null : (
                      <span key="a" className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
                        {m.status !== 'REVOKED' && m.role.systemRole !== 'HOUSEHOLD_HEAD' && <Link href={`/members/${m.id}`} className="link text-sm">{t('members.permissions')}</Link>}
                        {m.status === 'ACTIVE' && act(m.id, 'SUSPENDED', t('members.suspend'))}
                        {(m.status === 'SUSPENDED' || m.status === 'REVOKED') && act(m.id, 'ACTIVE', t('members.restore'))}
                        {m.status !== 'REVOKED' && act(m.id, 'REVOKED', t('members.remove'), true)}
                      </span>
                    ),
                  ];
                })} />
            </Panel>
            <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <Panel title={t('members.rolesTitle')} note={t('members.rolesHint')}>
                <Table head={[t('members.role'), t('members.kind'), t('members.holders'), '']} numeric={[2]}
                  rows={roleRows.map((r) => [
                    <span key="n" className="font-semibold">{r.name}</span>,
                    r.custom ? t('members.basedOn', { base: r.baseName }) : t('members.builtIn'),
                    <span key="c" className="tabular">{f.num(r.members)}</span>,
                    r.systemRole === 'HOUSEHOLD_HEAD' ? <span key="l" className="text-xs text-muted-foreground">{t('members.allPermissions')}</span>
                      : <Link key="l" href={`/members/roles/${r.id}`} className="link text-sm">{t('members.permissions')}</Link>,
                  ])} />
              </Panel>
              <Panel title={t('members.newRole')} footer={t('members.newRoleNote')}>
                <form action={createRole} className="flex flex-col gap-3.5">{hidden}
                  <label className="flex flex-col gap-1.5"><span className="text-xs text-muted-foreground">{t('members.roleNameAr')}</span>
                    <input name="nameAr" maxLength={60} dir="rtl" className="field h-11" placeholder="رئيس السائقين" /></label>
                  <label className="flex flex-col gap-1.5"><span className="text-xs text-muted-foreground">{t('members.roleNameEn')}</span>
                    <input name="name" maxLength={60} dir="ltr" className="field h-11 text-start" placeholder="Head Driver" /></label>
                  <label className="flex flex-col gap-1.5"><span className="text-xs text-muted-foreground">{t('members.baseRole')}</span>
                    <select name="baseRole" defaultValue="STAFF" className="field h-11">
                      {BASES.map((b) => <option key={b} value={b}>{roleRows.find((r) => r.systemRole === b && !r.custom)?.name ?? b}</option>)}
                    </select></label>
                  <button type="submit" className="btn btn-primary h-11 text-[15px]">{t('members.createRole')}</button>
                </form>
              </Panel>
            </div>
          </>
        )}
      </div>
    </Shell>
  );
}
