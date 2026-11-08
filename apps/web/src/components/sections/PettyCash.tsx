import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { apiGet } from '@/lib/api';
import { reviewPettyCash } from '@/lib/actions';
import { fmt } from '@/lib/fmt';
import { label, people, type Rows } from '@/lib/sections';
import { Block, Facts, ListDetail, RecordHeader, Table } from '../ListDetail';

type Opts = { household: string; locale: string };
interface Float { id: string; custodianId: string; name: string; currency: string; floatLimit: string; balance: string; lowBalance: boolean; receiptRequiredOver: string | null; isActive: boolean; lastReconciledAt: string | null }
interface Log { id: string; type: string; status: string; amount: string; balanceAfter: string; description: string | null; merchantName: string | null; recordedById: string; occurredAt: string; receiptId: string | null }

export async function PettyCashSection({ opts, id }: { opts: Opts; id: string | null; tab: string | null }) {
  const [t, f, names, list, locale] = await Promise.all([getTranslations('ui'), fmt(), people(opts), apiGet<Rows<Float>>('/v1/petty-cash', opts), getLocale()]);
  const floats = (list?.data ?? []).filter((x) => x.isActive);
  const sel = id ? floats.find((x) => x.id === id) : floats[0];
  if (id && !sel) notFound();
  const items = floats.map((x) => ({ id: x.id, primary: x.name, secondary: `${names.get(x.custodianId) ?? '—'} · ${f.money(x.balance, x.currency)}`, tone: x.lowBalance ? 'warning' as const : undefined }));

  let detail = null;
  if (sel) {
    const logs = await apiGet<Rows<Log>>(`/v1/petty-cash/${sel.id}/logs`, opts);
    const rows = [...(logs?.data ?? [])].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    const pending = rows.filter((l) => l.status === 'PENDING_REVIEW');
    detail = (
      <>
        <RecordHeader title={sel.name} meta={t('petty.custodian', { name: names.get(sel.custodianId) ?? '—' })} />
        <div className="grid gap-10">
          <Block title={t('petty.float')}>
            <Facts rows={[
              [t('finance.balance'), <strong key="b" className={`font-semibold tabular ${sel.lowBalance ? 'text-warning' : ''}`}>{f.money(sel.balance, sel.currency)}</strong>],
              [t('petty.limit'), <span key="l" className="tabular">{f.money(sel.floatLimit, sel.currency)}</span>],
              sel.receiptRequiredOver ? [t('petty.receiptOver'), <span key="r" className="tabular">{f.money(sel.receiptRequiredOver, sel.currency)}</span>] : null,
              [t('petty.reconciled'), sel.lastReconciledAt ? f.date(sel.lastReconciledAt) : t('petty.never')],
            ]} />
          </Block>
          {pending.length > 0 && (
            <Block title={t('petty.toReview', { count: pending.length })}>
              <ul className="grid">
                {pending.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 border-t py-2.5">
                    <span>{l.description ?? l.merchantName ?? '—'} <span className="text-muted-foreground">· {names.get(l.recordedById) ?? '—'} · {f.date(l.occurredAt)}</span></span>
                    <span className="flex items-center gap-3">
                      <span className="tabular">{f.money(l.amount, sel.currency)}</span>
                      <form action={reviewPettyCash} className="flex gap-2">
                        <input type="hidden" name="logId" value={l.id} /><input type="hidden" name="floatId" value={sel.id} /><input type="hidden" name="locale" value={locale} />
                        <button type="submit" name="decision" value="APPROVED" className="btn btn-primary h-8">{t('requests.approve')}</button>
                        <button type="submit" name="decision" value="REJECTED" className="btn h-8">{t('requests.reject')}</button>
                      </form>
                    </span>
                  </li>
                ))}
              </ul>
            </Block>
          )}
          <Block title={t('petty.log')}>
            <Table head={[t('date'), t('petty.entry'), t('petty.by'), t('petty.status'), t('amount'), t('petty.after')]} numeric={[4, 5]} empty={t('petty.noEntries')}
              rows={rows.map((l) => [f.date(l.occurredAt), `${label(t, 'pettyType', l.type)}${l.description ? ` · ${l.description}` : ''}`, names.get(l.recordedById) ?? '—',
                <span key="s" className={l.status === 'REJECTED' ? 'text-critical' : l.status === 'PENDING_REVIEW' ? 'text-warning' : undefined}>{label(t, 'pettyStatus', l.status)}</span>,
                `${l.type === 'EXPENSE' ? '−' : ''}${f.money(l.amount, sel.currency)}`, f.money(l.balanceAfter, sel.currency)])} />
          </Block>
        </div>
      </>
    );
  }
  return <ListDetail title={t('nav.pettyCash')} base="/petty-cash" items={items} selectedId={sel?.id ?? null} explicit={!!id} detail={detail} empty={t('empty.pettyCash')} />;
}
