import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { apiGet } from '@/lib/api';
import { reviewPettyCash } from '@/lib/actions';
import { fmt } from '@/lib/fmt';
import { label, loose, people, today, type Rows } from '@/lib/sections';
import { cn } from '@/lib/utils';
import { Avatar, BarRows, Dot, ListDetail, Panel, RecordHeader, Table } from '../ListDetail';

type Opts = { household: string; locale: string };
interface Float { id: string; custodianId: string; name: string; currency: string; floatLimit: string; balance: string; lowBalance: boolean; receiptRequiredOver: string | null; isActive: boolean; lastReconciledAt: string | null }
interface Log { id: string; type: string; status: string; amount: string; balanceAfter: string; description: string | null; merchantName: string | null; recordedById: string; occurredAt: string }

export async function PettyCashSection({ opts, id }: { opts: Opts; id: string | null; tab: string | null }) {
  const [t0, f, names, list, locale] = await Promise.all([getTranslations('ui'), fmt(), people(opts), apiGet<Rows<Float>>('/v1/petty-cash', opts), getLocale()]);
  const t = loose(t0);
  const floats = (list?.data ?? []).filter((x) => x.isActive);
  const sel = id ? floats.find((x) => x.id === id) : floats[0];
  if (id && !sel) notFound();
  const month = today().slice(0, 7);
  const allLogs = await Promise.all(floats.map((x) => apiGet<Rows<Log>>(`/v1/petty-cash/${x.id}/logs`, opts).then((r) => ({ id: x.id, logs: r?.data ?? [] }))));
  const logsOf = new Map(allLogs.map((x) => [x.id, x.logs]));
  const flat = allLogs.flatMap((x) => x.logs);
  const toReview = flat.filter((l) => l.status === 'PENDING_REVIEW').length;
  const spentMonth = flat.filter((l) => l.type === 'EXPENSE' && l.status !== 'REJECTED' && l.occurredAt.startsWith(month)).reduce((n, l) => n + Number(l.amount), 0);
  const held = floats.reduce((n, x) => n + Number(x.balance), 0);

  const items = floats.map((x) => {
    const pend = (logsOf.get(x.id) ?? []).filter((l) => l.status === 'PENDING_REVIEW').length;
    return { id: x.id, lead: <Avatar name={names.get(x.custodianId) ?? x.name} tone={x.lowBalance ? 'warning' : 'ok'} />, primary: x.name,
      secondary: pend ? t('petty.toReview', { count: pend }) : names.get(x.custodianId) ?? '—', tone: pend ? 'warning' as const : undefined, trail: f.money(x.balance, x.currency) };
  });

  let detail = null;
  if (sel) {
    const rows = [...(logsOf.get(sel.id) ?? [])].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    const pending = rows.filter((l) => l.status === 'PENDING_REVIEW');
    const holder = names.get(sel.custodianId) ?? '—';
    const spent = rows.filter((l) => l.type === 'EXPENSE' && l.status !== 'REJECTED' && l.occurredAt.startsWith(month)).reduce((n, l) => n + Number(l.amount), 0);
    detail = (
      <>
        <RecordHeader title={sel.name} lead={<Avatar name={holder} tone={sel.lowBalance ? 'warning' : 'ok'} size="lg" />} meta={t('petty.custodian', { name: holder })}
          stats={[
            { label: t('finance.balance'), value: f.money(sel.balance, sel.currency), tone: sel.lowBalance ? 'warning' : undefined },
            { label: t('petty.limit'), value: f.money(sel.floatLimit, sel.currency) },
            { label: t('sec.spentMonth'), value: f.money(spent, sel.currency) },
            { label: t('pettyStatus.PENDING_REVIEW'), value: f.num(pending.length), tone: pending.length ? 'brass' : undefined },
          ]} />
        <Panel title={t('petty.float')} note={sel.lastReconciledAt ? `${t('petty.reconciled')}: ${f.date(sel.lastReconciledAt)}` : `${t('petty.reconciled')}: ${t('petty.never')}`}>
          <BarRows rows={[{ label: t('finance.balance'), value: Number(sel.balance), max: Number(sel.floatLimit), tone: sel.lowBalance ? 'warning' : 'ok',
            text: t('home.ofTotalMoney', { amount: f.money(sel.balance, sel.currency), total: f.money(sel.floatLimit, sel.currency) }) }]} />
          {sel.receiptRequiredOver && <p className="mt-3 text-xs text-muted-foreground">{t('petty.receiptOver')} {f.money(sel.receiptRequiredOver, sel.currency)}</p>}
        </Panel>
        {pending.length > 0 && (
          <Panel title={t('petty.toReview', { count: pending.length })} flush>
            {pending.map((l, i) => (
              <div key={l.id} className={cn('flex flex-wrap items-center gap-4 px-5 py-3.5 sm:px-6', i > 0 && 'border-t border-hairline')}>
                <Dot tone="brass" />
                <div className="min-w-0 flex-[1_1_240px]">
                  <div className="font-semibold">{l.description ?? l.merchantName ?? '—'} · <span className="tabular">{f.money(l.amount, sel.currency)}</span></div>
                  <div className="text-xs text-muted-foreground">{names.get(l.recordedById) ?? '—'} · {f.dayMonth(l.occurredAt)}</div>
                </div>
                <form action={reviewPettyCash} className="flex gap-2">
                  <input type="hidden" name="logId" value={l.id} /><input type="hidden" name="floatId" value={sel.id} /><input type="hidden" name="locale" value={locale} />
                  <button type="submit" name="decision" value="APPROVED" className="btn btn-primary">{t('requests.approve')}</button>
                  <button type="submit" name="decision" value="REJECTED" className="btn">{t('requests.reject')}</button>
                </form>
              </div>
            ))}
          </Panel>
        )}
        <Panel title={t('petty.log')}>
          <Table head={[t('date'), t('petty.entry'), t('petty.by'), t('petty.status'), t('amount'), t('petty.after')]} numeric={[4, 5]} empty={t('petty.noEntries')}
            rows={rows.map((l) => [f.date(l.occurredAt), `${label(t0, 'pettyType', l.type)}${l.description ? ` · ${l.description}` : ''}`, names.get(l.recordedById) ?? '—',
              <span key="s" className={l.status === 'REJECTED' ? 'text-critical' : l.status === 'PENDING_REVIEW' ? 'text-brass-ink' : 'text-primary'}>{label(t0, 'pettyStatus', l.status)}</span>,
              `${l.type === 'EXPENSE' ? '−' : '+'}${f.money(l.amount, sel.currency)}`, f.money(l.balanceAfter, sel.currency)])} />
        </Panel>
      </>
    );
  }
  return <ListDetail title={t('nav.pettyCash')} base="/petty-cash" items={items} selectedId={sel?.id ?? null} explicit={!!id} detail={detail} empty={t('empty.pettyCash')}
    summary={t('sec.petty.summary', { count: toReview })}
    stats={[
      { label: t('sec.held'), value: f.money(held) },
      { label: t('pettyStatus.PENDING_REVIEW'), value: f.num(toReview), tone: toReview ? 'brass' : undefined },
      { label: t('sec.spentMonth'), value: f.money(spentMonth) },
      { label: t('sec.floats'), value: f.num(floats.length) },
    ]} />;
}
