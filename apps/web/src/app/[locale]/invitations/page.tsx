import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Locale } from '@herp/i18n';
import { Shell } from '@/components/Shell';
import { OwnerNav } from '@/components/OwnerNav';
import { Dot, PageHead, Panel, Table, type Tone } from '@/components/ListDetail';
import { apiGet } from '@/lib/api';
import { loadSession } from '@/lib/dashboard';
import { fmt } from '@/lib/fmt';
import { createInvitation, newInvitationLink, revokeInvitation } from '@/lib/invite-actions';
import { loose, type Rows } from '@/lib/sections';

export const dynamic = 'force-dynamic';

interface Invitation { id: string; phone: string | null; email: string | null; displayName: string | null; expiresAt: string; createdAt: string;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED'; role: { name: string } }
interface Role { id: string; systemRole: string; name: string; isDefault: boolean; custom: boolean; baseName: string }
const TONE: Record<Invitation['status'], Tone> = { PENDING: 'brass', ACCEPTED: 'ok', REVOKED: 'muted', EXPIRED: 'critical' };
const ERR = ['phone', 'email', 'contact', 'owner', 'failed'];
const LANGS: Array<[string, string]> = [['ar', 'العربية'], ['en', 'English'], ['hi', 'हिन्दी'], ['tl', 'Filipino'], ['am', 'አማርኛ'], ['bn', 'বাংলা']];

/** Owner only: invite a person (the one way an account is created), see and revoke invitations. */
export default async function InvitationsPage({ params, searchParams }: { params: Promise<{ locale: Locale }>; searchParams: Promise<{ e?: string; created?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [sp, session, t0, f] = await Promise.all([searchParams, loadSession(locale), getTranslations('ui'), fmt()]);
  const t = loose(t0);
  const owner = !!session.opts && !!session.current.owner;
  const [list, roles, fresh] = owner
    ? await Promise.all([apiGet<Rows<Invitation>>('/v1/invitations', session.opts!), apiGet<Rows<Role>>('/v1/roles', session.opts!), sp.created ? newInvitationLink() : null])
    : [null, null, null];
  const rows = list?.data ?? [];
  const pick = roles?.data ?? []; // built-in and custom roles alike
  const err = ERR.includes(sp.e ?? '') ? sp.e! : null;
  const link = fresh ? (fresh.url ?? fresh.path) : null;
  return (
    <Shell current={null} households={session.households} household={session.current} mode={session.mode} pendingRequests={session.pendingRequests} back={`/${locale}/invitations`}>
      <div className="mx-auto flex max-w-[1280px] flex-col gap-6 px-4 py-8 sm:px-8">
        <PageHead title={t('invite.pageTitle')} summary={t('invite.pageHint', { household: session.current.name })}
          stats={owner ? [{ label: t('invite.status.PENDING'), value: f.num(rows.filter((r) => r.status === 'PENDING').length), tone: 'brass' },
                          { label: t('invite.status.ACCEPTED'), value: f.num(rows.filter((r) => r.status === 'ACCEPTED').length), tone: 'ok' }] : undefined} />
        {!owner ? <p className="panel px-6 py-5 text-muted-foreground">{t('invite.ownerOnly')}</p> : (
          <>
            <OwnerNav current="invitations" />
            {link && (
              <section className="panel border-brass px-5 py-4 sm:px-6" role="status">
                <h2 className="font-display text-xl">{t('invite.linkTitle')}</h2>
                <p className="text-sm text-muted-foreground">{t('invite.linkHint', { phone: fresh!.to })}</p>
                <p dir="ltr" className="mt-3 select-all break-all rounded-md bg-muted px-3 py-2 text-start font-mono text-sm">{link}</p>
              </section>
            )}
            <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <Panel title={t('invite.newTitle')} footer={t('invite.newNote')}>
                <form action={createInvitation} className="flex flex-col gap-3.5">
                  <input type="hidden" name="locale" value={locale} />
                  {err && <p role="alert" className="rounded-md bg-critical-soft px-3 py-2 text-sm text-critical">{t(`invite.e.${err}`)}</p>}
                  <label className="flex flex-col gap-1.5"><span className="text-xs text-muted-foreground">{t('invite.name')}</span>
                    <input name="name" maxLength={80} className="field h-11" /></label>
                  <label className="flex flex-col gap-1.5"><span className="text-xs text-muted-foreground">{t('auth.phoneLabel')}</span>
                    <input name="phone" dir="ltr" inputMode="tel" placeholder="05xxxxxxxx" className="field h-11 text-start" /></label>
                  <label className="flex flex-col gap-1.5"><span className="text-xs text-muted-foreground">{t('invite.emailOr')}</span>
                    <input name="email" dir="ltr" inputMode="email" placeholder="name@example.com" className="field h-11 text-start" /></label>
                  <div className="grid gap-3.5 sm:grid-cols-2">
                    <label className="flex min-w-0 flex-col gap-1.5"><span className="text-xs text-muted-foreground">{t('invite.role')}</span>
                      <select name="roleId" required defaultValue={pick.find((r) => r.systemRole === 'STAFF')?.id} className="field h-11 min-w-0">
                        {pick.map((r) => <option key={r.id} value={r.id}>{r.custom ? `${r.name} (${r.baseName})` : r.name}</option>)}
                      </select></label>
                    <label className="flex min-w-0 flex-col gap-1.5"><span className="text-xs text-muted-foreground">{t('invite.language')}</span>
                      <select name="language" defaultValue={locale} className="field h-11 min-w-0">
                        {LANGS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
                      </select></label>
                  </div>
                  <label className="flex flex-col gap-1.5"><span className="text-xs text-muted-foreground">{t('invite.validFor')}</span>
                    <select name="hours" defaultValue="72" className="field h-11">
                      {[24, 72, 168].map((h) => <option key={h} value={h}>{t('daysCount', { count: h / 24 })}</option>)}
                    </select></label>
                  <button type="submit" className="btn btn-primary h-11 text-[15px]">{t('invite.create')}</button>
                </form>
              </Panel>
              <Panel title={t('invite.listTitle')}>
                <Table empty={t('invite.empty')} head={[t('invite.person'), t('invite.role'), t('invite.statusLabel'), t('invite.validUntil'), '']}
                  rows={rows.map((r) => [
                    <span key="p"><span className="block font-semibold">{r.displayName ?? '—'}</span><span dir="ltr" className="block text-xs text-muted-foreground tabular">{[r.phone, r.email].filter(Boolean).join(' · ')}</span></span>,
                    r.role.name,
                    <span key="s" className="inline-flex items-center gap-2"><Dot tone={TONE[r.status]} />{t(`invite.status.${r.status}`)}</span>,
                    f.date(r.expiresAt),
                    r.status === 'PENDING' ? (
                      <form key="r" action={revokeInvitation}><input type="hidden" name="locale" value={locale} /><input type="hidden" name="id" value={r.id} />
                        <button type="submit" className="link text-sm">{t('invite.revoke')}</button></form>
                    ) : null,
                  ])} />
              </Panel>
            </div>
          </>
        )}
      </div>
    </Shell>
  );
}
