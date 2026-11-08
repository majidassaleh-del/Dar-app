import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { apiGet } from '@/lib/api';
import { decideRequest } from '@/lib/actions';
import { fmt } from '@/lib/fmt';
import { label, people, type Rows } from '@/lib/sections';
import { Block, Facts, ListDetail, RecordHeader, Table } from '../ListDetail';

type Opts = { household: string; locale: string };
interface Req { id: string; type: string; status: string; priority: string; requesterId: string; amount: string | null; currency: string; createdAt: string; resolvedAt: string | null;
  payload: Record<string, unknown> | null; approvals: Array<{ id: string; step: number; approverId: string; decision: string; comment: string | null; decidedAt: string | null }> }

const OPEN = ['SUBMITTED', 'IN_REVIEW'];

export async function RequestsSection({ opts, id }: { opts: Opts; id: string | null; tab: string | null }) {
  const [t, f, names, list, locale] = await Promise.all([getTranslations('ui'), fmt(), people(opts), apiGet<Rows<Req>>('/v1/requests', opts), getLocale()]);
  const rows = [...(list?.data ?? [])].sort((a, b) => Number(OPEN.includes(b.status)) - Number(OPEN.includes(a.status)) || b.createdAt.localeCompare(a.createdAt));
  const sel = id ? rows.find((r) => r.id === id) : rows[0];
  if (id && !sel) notFound();

  const items = rows.map((r) => ({
    id: r.id, primary: `${label(t, 'requestType', r.type)} · ${names.get(r.requesterId) ?? '—'}`,
    secondary: `${label(t, 'requestStatus', r.status)} · ${f.date(r.createdAt)}`, tone: OPEN.includes(r.status) ? 'warning' as const : undefined,
  }));

  let detail = null;
  if (sel) {
    const p = (sel.payload ?? {}) as Record<string, string | number | undefined>;
    const open = OPEN.includes(sel.status);
    detail = (
      <>
        <RecordHeader title={`${label(t, 'requestType', sel.type)}${sel.amount ? ` · ${f.money(sel.amount, sel.currency)}` : ''}`}
          meta={`${names.get(sel.requesterId) ?? '—'} · ${f.date(sel.createdAt)} · ${label(t, 'requestStatus', sel.status)}`}
          actions={open ? (
            <form action={decideRequest} className="flex gap-2">
              <input type="hidden" name="id" value={sel.id} /><input type="hidden" name="locale" value={locale} />
              <button type="submit" name="decision" value="approve" className="btn btn-primary">{t('requests.approve')}</button>
              <button type="submit" name="decision" value="reject" className="btn">{t('requests.reject')}</button>
            </form>
          ) : null} />
        <div className="grid gap-10">
          <Block title={t('requests.details')}>
            <Facts rows={[
              sel.amount ? [t('amount'), f.money(sel.amount, sel.currency)] : null,
              p.installments != null ? [t('requests.installments'), f.num(p.installments)] : null,
              p.leaveType ? [t('requests.leaveType'), label(t, 'leaveType', String(p.leaveType))] : null,
              p.startDate ? [t('requests.from'), f.date(String(p.startDate))] : null,
              p.endDate ? [t('requests.to'), f.date(String(p.endDate))] : null,
              p.reason ? [t('requests.reason'), String(p.reason)] : null,
              [t('requests.priority'), label(t, 'priority', sel.priority)],
              sel.resolvedAt ? [t('requests.resolved'), f.date(sel.resolvedAt)] : null,
            ]} />
          </Block>
          <Block title={t('requests.approvals')}>
            <Table head={[t('requests.step'), t('requests.approver'), t('requests.decision'), t('requests.when')]}
              rows={sel.approvals.map((a) => [f.num(a.step), names.get(a.approverId) ?? '—',
                <span key="d" className={a.decision === 'REJECTED' ? 'text-critical' : a.decision === 'PENDING' ? 'text-muted-foreground' : undefined}>{label(t, 'decision', a.decision)}</span>,
                a.decidedAt ? f.date(a.decidedAt) : '—'])} />
          </Block>
        </div>
      </>
    );
  }
  return <ListDetail title={t('nav.requests')} base="/requests" items={items} selectedId={sel?.id ?? null} explicit={!!id} detail={detail} empty={t('empty.requests')} />;
}
