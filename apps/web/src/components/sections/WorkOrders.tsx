import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { apiGet } from '@/lib/api';
import { fmt } from '@/lib/fmt';
import { label, people, type Rows } from '@/lib/sections';
import { Block, Facts, ListDetail, RecordHeader } from '../ListDetail';

type Opts = { household: string; locale: string };
interface WO { id: string; number: string; title: string; description: string | null; category: string; priority: string; status: string; requesterId: string; assigneeId: string | null;
  vendorName: string | null; dueAt: string | null; scheduledAt: string | null; completedAt: string | null; requiresPhotoProof: boolean; estimatedCost: string | null; actualCost: string | null; currency: string;
  instructions: Array<{ sequence: number; text: string; translated: boolean; isSafetyCritical: boolean; requiresPhoto: boolean; completedAt: string | null; translationStatus: string }> }

const DONE = ['COMPLETED', 'VERIFIED', 'CANCELLED'];

export async function WorkOrdersSection({ opts, id }: { opts: Opts; id: string | null; tab: string | null }) {
  const [t, f, names, list] = await Promise.all([getTranslations('ui'), fmt(), people(opts), apiGet<Rows<WO>>('/v1/work-orders', opts)]);
  const now = new Date().toISOString();
  const rows = [...(list?.data ?? [])].sort((a, b) => Number(DONE.includes(a.status)) - Number(DONE.includes(b.status)) || (a.dueAt ?? '9').localeCompare(b.dueAt ?? '9'));
  const sel = id ? rows.find((w) => w.id === id) : rows[0];
  if (id && !sel) notFound();
  const overdue = (w: WO) => !!w.dueAt && w.dueAt < now && !DONE.includes(w.status);
  const items = rows.map((w) => ({
    id: w.id, primary: w.title,
    secondary: `${w.number} · ${w.assigneeId ? names.get(w.assigneeId) ?? '—' : w.vendorName ?? t('wo.unassigned')}${w.dueAt ? ` · ${f.date(w.dueAt)}` : ''}`,
    tone: overdue(w) ? 'critical' as const : undefined,
  }));

  let detail = null;
  if (sel) {
    detail = (
      <>
        <RecordHeader title={sel.title} meta={`${sel.number} · ${label(t, 'woStatus', sel.status)} · ${label(t, 'woCategory', sel.category)}`} />
        <div className="grid gap-10">
          <Block title={t('wo.details')}>
            <Facts rows={[
              [t('wo.assignee'), sel.assigneeId ? names.get(sel.assigneeId) ?? '—' : sel.vendorName ?? t('wo.unassigned')],
              [t('wo.requester'), names.get(sel.requesterId) ?? '—'],
              [t('requests.priority'), <span key="p" className={sel.priority === 'URGENT' || sel.priority === 'HIGH' ? 'font-semibold' : undefined}>{label(t, 'priority', sel.priority)}</span>],
              sel.dueAt ? [t('wo.due'), <span key="d" className={overdue(sel) ? 'text-critical' : undefined}>{f.date(sel.dueAt)}</span>] : null,
              sel.completedAt ? [t('wo.completed'), f.date(sel.completedAt)] : null,
              sel.estimatedCost ? [t('wo.estimate'), f.money(sel.estimatedCost, sel.currency)] : null,
              sel.actualCost ? [t('wo.actual'), f.money(sel.actualCost, sel.currency)] : null,
              sel.description ? [t('wo.description'), sel.description] : null,
            ]} />
          </Block>
          <Block title={t('wo.instructions')}>
            <ol className="grid list-decimal gap-2 ps-6">
              {sel.instructions.map((i) => (
                <li key={i.sequence} className={i.completedAt ? 'text-muted-foreground line-through' : undefined}>
                  {i.isSafetyCritical && <span className="font-semibold text-critical">{t('wo.safety')} · </span>}
                  {i.text}
                  {(i.requiresPhoto || i.translationStatus === 'PENDING') && (
                    <span className="block text-xs text-muted-foreground">
                      {[i.requiresPhoto ? t('wo.photo') : null, i.translationStatus === 'PENDING' ? t('wo.translationPending') : null].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </Block>
        </div>
      </>
    );
  }
  return <ListDetail title={t('nav.workOrders')} base="/work-orders" items={items} selectedId={sel?.id ?? null} explicit={!!id} detail={detail} empty={t('empty.workOrders')} />;
}
