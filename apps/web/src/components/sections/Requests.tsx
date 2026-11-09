import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { apiGet } from '@/lib/api';
import { decideRequest } from '@/lib/actions';
import { fmt } from '@/lib/fmt';
import { label, loose, people, today, type Rows } from '@/lib/sections';
import { Avatar, Dot, Facts, ListDetail, Panel, RecordHeader, Steps, type Tone } from '../ListDetail';

type Opts = { household: string; locale: string };
interface Req { id: string; type: string; status: string; priority: string; requesterId: string; amount: string | null; currency: string; createdAt: string; resolvedAt: string | null;
  currentStep: number | null; payload: Record<string, unknown> | null;
  approvals: Array<{ id: string; step: number; approverId: string; decision: string; comment: string | null; decidedAt: string | null }> }

const OPEN = ['SUBMITTED', 'IN_REVIEW'];
const toneOf = (s: string): Tone => (OPEN.includes(s) ? 'brass' : s === 'REJECTED' ? 'critical' : s === 'APPROVED' || s === 'FULFILLED' ? 'ok' : 'muted');
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;

export async function RequestsSection({ opts, id }: { opts: Opts; id: string | null; tab: string | null }) {
  const [t0, f, names, list, locale] = await Promise.all([getTranslations('ui'), fmt(), people(opts), apiGet<Rows<Req>>('/v1/requests', opts), getLocale()]);
  const t = loose(t0);
  const rows = [...(list?.data ?? [])].sort((a, b) => Number(OPEN.includes(b.status)) - Number(OPEN.includes(a.status)) || b.createdAt.localeCompare(a.createdAt));
  const sel = id ? rows.find((r) => r.id === id) : rows[0];
  if (id && !sel) notFound();
  const month = today().slice(0, 7);
  const open = rows.filter((r) => OPEN.includes(r.status)).length;
  const approved = rows.filter((r) => ['APPROVED', 'FULFILLED'].includes(r.status) && (r.resolvedAt ?? '').startsWith(month)).length;
  const rejected = rows.filter((r) => r.status === 'REJECTED' && (r.resolvedAt ?? '').startsWith(month)).length;

  const items = rows.map((r) => ({
    id: r.id, lead: <Dot tone={toneOf(r.status)} />, primary: `${label(t0, 'requestType', r.type)} · ${names.get(r.requesterId) ?? '—'}`,
    secondary: `${label(t0, 'requestStatus', r.status)} · ${f.dayMonth(r.createdAt)}`, tone: OPEN.includes(r.status) ? 'warning' as const : undefined,
    trail: r.amount ? f.money(r.amount, r.currency) : null,
  }));

  let detail = null;
  if (sel) {
    const p = (sel.payload ?? {}) as Record<string, string | number | undefined>;
    const isOpen = OPEN.includes(sel.status);
    const leaveDays = p.startDate && p.endDate ? days(String(p.startDate), String(p.endDate)) : null;
    const steps = [...sel.approvals].sort((a, b) => a.step - b.step);
    const decided = steps.filter((a) => a.decision !== 'PENDING').length;
    const who = names.get(sel.requesterId) ?? '—';
    detail = (
      <>
        <RecordHeader title={`${label(t0, 'requestType', sel.type)}${sel.amount ? ` · ${f.money(sel.amount, sel.currency)}` : ''}`}
          lead={<Avatar name={who} tone={toneOf(sel.status)} size="lg" />}
          meta={`${who} · ${f.date(sel.createdAt)}`}
          actions={isOpen ? (
            <form action={decideRequest} className="flex gap-2">
              <input type="hidden" name="id" value={sel.id} /><input type="hidden" name="locale" value={locale} />
              <button type="submit" name="decision" value="approve" className="btn btn-primary">{t('requests.approve')}</button>
              <button type="submit" name="decision" value="reject" className="btn">{t('requests.reject')}</button>
            </form>
          ) : null}
          stats={[
            { label: t('staff.paymentStatus'), value: label(t0, 'requestStatus', sel.status), tone: toneOf(sel.status) },
            sel.amount ? { label: t('amount'), value: f.money(sel.amount, sel.currency) } : { label: t('sec.duration'), value: leaveDays ? t('daysCount', { count: leaveDays }) : '—' },
            { label: t('requests.priority'), value: label(t0, 'priority', sel.priority) },
            { label: t('requests.approvals'), value: t('home.ofTotal', { count: decided, total: steps.length }) },
          ]} />
        <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Panel title={t('requests.details')}>
            <Facts rows={[
              p.leaveType ? [t('requests.leaveType'), label(t0, 'leaveType', String(p.leaveType))] : null,
              p.startDate ? [t('requests.from'), f.date(String(p.startDate))] : null,
              p.endDate ? [t('requests.to'), f.date(String(p.endDate))] : null,
              sel.amount ? [t('amount'), <span key="a" className="tabular">{f.money(sel.amount, sel.currency)}</span>] : null,
              p.installments != null ? [t('requests.installments'), t('home.installments', { count: Number(p.installments) })] : null,
              sel.amount && p.installments ? [t('staff.installment'), <span key="i" className="tabular">{f.money(Number(sel.amount) / Number(p.installments), sel.currency)}</span>] : null,
              p.reason ? [t('requests.reason'), String(p.reason)] : null,
              sel.resolvedAt ? [t('requests.resolved'), f.date(sel.resolvedAt)] : null,
            ]} />
          </Panel>
          <Panel title={t('requests.approvals')}>
            <Steps steps={[
              { label: t('sec.submittedBy', { name: who }), note: f.date(sel.createdAt), state: 'done' },
              ...steps.map((a) => ({
                label: names.get(a.approverId) ?? '—',
                note: `${label(t0, 'decision', a.decision)}${a.decidedAt ? ` · ${f.date(a.decidedAt)}` : ''}${a.comment ? ` · ${a.comment}` : ''}`,
                state: a.decision === 'APPROVED' ? 'done' as const : a.decision === 'REJECTED' ? 'rejected' as const : isOpen && a.step === (sel.currentStep ?? 1) ? 'current' as const : 'todo' as const,
              })),
            ]} />
          </Panel>
        </div>
      </>
    );
  }
  return <ListDetail title={t('nav.requests')} base="/requests" items={items} selectedId={sel?.id ?? null} explicit={!!id} detail={detail} empty={t('empty.requests')}
    summary={t('sec.requests.summary', { count: open })}
    stats={[
      { label: t('home.stripApprovals'), value: f.num(open), tone: open ? 'brass' : undefined },
      { label: t('sec.approvedMonth'), value: f.num(approved), tone: 'ok' },
      { label: t('sec.rejectedMonth'), value: f.num(rejected) },
      { label: t('sec.allRequests'), value: f.num(rows.length) },
    ]} />;
}
