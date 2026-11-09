import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { apiGet } from '@/lib/api';
import { fmt } from '@/lib/fmt';
import { label, loose, people, today, type Rows } from '@/lib/sections';
import { cn } from '@/lib/utils';
import { Dot, Facts, ListDetail, Panel, RecordHeader, Steps, type Tone } from '../ListDetail';

type Opts = { household: string; locale: string };
interface WO { id: string; number: string; title: string; description: string | null; category: string; priority: string; status: string; requesterId: string; assigneeId: string | null;
  vendorName: string | null; dueAt: string | null; scheduledAt: string | null; startedAt: string | null; completedAt: string | null; verifiedAt: string | null;
  estimatedCost: string | null; actualCost: string | null; currency: string;
  instructions: Array<{ sequence: number; text: string; isSafetyCritical: boolean; requiresPhoto: boolean; completedAt: string | null; translationStatus: string }> }

const DONE = ['COMPLETED', 'VERIFIED', 'CANCELLED'];
const FLOW = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'VERIFIED'] as const;

export async function WorkOrdersSection({ opts, id }: { opts: Opts; id: string | null; tab: string | null }) {
  const [t0, f, names, list] = await Promise.all([getTranslations('ui'), fmt(), people(opts), apiGet<Rows<WO>>('/v1/work-orders', opts)]);
  const t = loose(t0);
  const now = new Date().toISOString(), week = new Date(Date.now() + 7 * 86_400_000).toISOString(), month = today().slice(0, 7);
  const rows = [...(list?.data ?? [])].sort((a, b) => Number(DONE.includes(a.status)) - Number(DONE.includes(b.status)) || (a.dueAt ?? '9').localeCompare(b.dueAt ?? '9'));
  const sel = id ? rows.find((w) => w.id === id) : rows[0];
  if (id && !sel) notFound();
  const overdue = (w: WO) => !!w.dueAt && w.dueAt < now && !DONE.includes(w.status);
  const tone = (w: WO): Tone => (overdue(w) ? 'critical' : DONE.includes(w.status) ? 'ok' : w.priority === 'HIGH' || w.priority === 'URGENT' ? 'brass' : 'muted');
  const open = rows.filter((w) => !DONE.includes(w.status));
  const items = rows.map((w) => ({
    id: w.id, lead: <Dot tone={tone(w)} />, primary: w.title,
    secondary: `${w.number} · ${w.assigneeId ? names.get(w.assigneeId) ?? '—' : w.vendorName ?? t('wo.unassigned')}`,
    tone: overdue(w) ? 'critical' as const : undefined,
    trail: w.dueAt ? <span className={overdue(w) ? 'font-semibold text-critical' : 'text-muted-foreground'}>{f.dayMonth(w.dueAt)}</span> : null,
  }));

  let detail = null;
  if (sel) {
    const at: Record<string, string | null> = { NEW: null, ASSIGNED: null, IN_PROGRESS: sel.startedAt, COMPLETED: sel.completedAt, VERIFIED: sel.verifiedAt };
    const reached = FLOW.indexOf(sel.status as (typeof FLOW)[number]);
    const doneCount = sel.instructions.filter((i) => i.completedAt).length;
    detail = (
      <>
        <RecordHeader title={sel.title} meta={`${sel.number} · ${label(t0, 'woCategory', sel.category)}`}
          stats={[
            { label: t('staff.paymentStatus'), value: label(t0, 'woStatus', sel.status), tone: overdue(sel) ? 'critical' : DONE.includes(sel.status) ? 'ok' : 'brass' },
            { label: t('requests.priority'), value: label(t0, 'priority', sel.priority), tone: sel.priority === 'HIGH' || sel.priority === 'URGENT' ? 'brass' : undefined },
            { label: t('wo.due'), value: sel.dueAt ? f.dayMonth(sel.dueAt) : '—', tone: overdue(sel) ? 'critical' : undefined },
            { label: t('wo.assignee'), value: sel.assigneeId ? names.get(sel.assigneeId) ?? '—' : sel.vendorName ?? t('wo.unassigned') },
          ]} />
        <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Panel title={t('wo.instructions')} note={t('home.ofTotal', { count: doneCount, total: sel.instructions.length })} flush>
            <ol>
              {sel.instructions.map((i, n) => (
                <li key={i.sequence} className={cn('flex gap-3.5 px-5 py-3 sm:px-6', n > 0 && 'border-t border-hairline')}>
                  <span className={cn('mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold', i.completedAt ? 'bg-primary text-white' : 'border-2 border-input text-muted-foreground')}>
                    {i.completedAt ? '✓' : i.sequence}
                  </span>
                  <div className="min-w-0">
                    <div className={i.completedAt ? 'text-muted-foreground line-through' : undefined}>
                      {i.isSafetyCritical && <span className="font-semibold text-critical">{t('wo.safety')} · </span>}{i.text}
                    </div>
                    {(i.requiresPhoto || i.translationStatus === 'PENDING') && (
                      <div className="text-xs text-muted-foreground">{[i.requiresPhoto ? t('wo.photo') : null, i.translationStatus === 'PENDING' ? t('wo.translationPending') : null].filter(Boolean).join(' · ')}</div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </Panel>
          <div className="flex flex-col gap-6">
            <Panel title={t('sec.progress')}>
              <Steps steps={sel.status === 'CANCELLED' ? [{ label: label(t0, 'woStatus', 'CANCELLED'), state: 'rejected' }] : FLOW.map((s, n) => ({
                label: label(t0, 'woStatus', s), note: at[s] ? f.date(at[s]!) : undefined,
                state: n < reached || (n === reached && (s === 'VERIFIED')) ? 'done' as const : n === reached ? 'current' as const : 'todo' as const,
              }))} />
            </Panel>
            <Panel title={t('wo.details')}>
              <Facts rows={[
                [t('wo.requester'), names.get(sel.requesterId) ?? '—'],
                sel.estimatedCost ? [t('wo.estimate'), f.money(sel.estimatedCost, sel.currency)] : null,
                sel.actualCost ? [t('wo.actual'), f.money(sel.actualCost, sel.currency)] : null,
                sel.description ? [t('wo.description'), sel.description] : null,
              ]} />
            </Panel>
          </div>
        </div>
      </>
    );
  }
  return <ListDetail title={t('nav.workOrders')} base="/work-orders" items={items} selectedId={sel?.id ?? null} explicit={!!id} detail={detail} empty={t('empty.workOrders')}
    summary={t('sec.wo.summary', { count: open.length, overdue: open.filter(overdue).length })}
    stats={[
      { label: t('sec.open'), value: f.num(open.length), tone: open.length ? 'brass' : undefined },
      { label: t('sec.overdue'), value: f.num(open.filter(overdue).length), tone: open.some(overdue) ? 'critical' : undefined },
      { label: t('sec.dueWeek'), value: f.num(open.filter((w) => w.dueAt && w.dueAt <= week && w.dueAt >= now).length) },
      { label: t('sec.completedMonth'), value: f.num(rows.filter((w) => (w.completedAt ?? '').startsWith(month)).length), tone: 'ok' },
    ]} />;
}
