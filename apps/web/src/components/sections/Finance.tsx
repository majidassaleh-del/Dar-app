import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { apiGet } from '@/lib/api';
import { fmt } from '@/lib/fmt';
import { label, loose, today, type Rows } from '@/lib/sections';
import { Avatar, BarRows, Facts, ListDetail, Masked, Panel, RecordHeader, Table } from '../ListDetail';

type Opts = { household: string; locale: string };
interface Account { id: string; type: string; name: string; institution: string | null; ibanLast4: string | null; currency: string; openingBalance: string; balance: string; isActive: boolean; ledgerAccount: { code: string } | null }
interface Tx { id: string; type: string; status: string; amount: string; currency: string; merchantName: string | null; description: string | null; categoryId: string | null; occurredAt: string; accountId: string }

const OUT = ['EXPENSE', 'ALLOWANCE'];

export async function FinanceSection({ opts, id }: { opts: Opts; id: string | null; tab: string | null }) {
  const [t0, f, list, all, cats] = await Promise.all([getTranslations('ui'), fmt(), apiGet<Rows<Account>>('/v1/accounts', opts),
    apiGet<Rows<Tx>>('/v1/transactions', opts), apiGet<Rows<{ id: string; name: string }>>('/v1/categories', opts)]);
  const t = loose(t0);
  const accounts = (list?.data ?? []).filter((a) => a.isActive);
  const sel = id ? accounts.find((a) => a.id === id) : accounts[0];
  if (id && !sel) notFound();
  const month = today().slice(0, 7);
  const live = (all?.data ?? []).filter((x) => x.status !== 'REVERSED');
  const inMonth = live.filter((x) => x.occurredAt.startsWith(month));
  const spent = inMonth.filter((x) => OUT.includes(x.type)).reduce((n, x) => n + Number(x.amount), 0);
  const income = inMonth.filter((x) => x.type === 'INCOME').reduce((n, x) => n + Number(x.amount), 0);
  const total = accounts.filter((a) => a.type !== 'CREDIT_CARD').reduce((n, a) => n + Number(a.balance), 0);
  const catName = new Map((cats?.data ?? []).map((c) => [c.id, c.name]));
  const items = accounts.map((a) => ({ id: a.id, lead: <Avatar name={a.name} />, primary: a.name, secondary: label(t0, 'accountType', a.type), trail: f.money(a.balance, a.currency) }));

  let detail = null;
  if (sel) {
    const txs = await apiGet<Rows<Tx>>(`/v1/transactions?accountId=${sel.id}`, opts);
    const rows = [...(txs?.data ?? [])].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    const mine = rows.filter((x) => x.status !== 'REVERSED' && x.occurredAt.startsWith(month) && OUT.includes(x.type));
    const byCat = new Map<string, number>();
    for (const x of mine) { const k = x.categoryId ? catName.get(x.categoryId) ?? '—' : t('sec.uncategorised'); byCat.set(k, (byCat.get(k) ?? 0) + Number(x.amount)); }
    const cat = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
    const top = cat[0]?.[1] ?? 0;
    detail = (
      <>
        <RecordHeader title={sel.name} lead={<Avatar name={sel.name} size="lg" />} meta={[label(t0, 'accountType', sel.type), sel.institution].filter(Boolean).join(' · ')}
          stats={[
            { label: t('finance.balance'), value: f.money(sel.balance, sel.currency) },
            { label: t('sec.spentMonth'), value: f.money(mine.reduce((n, x) => n + Number(x.amount), 0), sel.currency) },
            { label: t('finance.opening'), value: f.money(sel.openingBalance, sel.currency) },
            { label: t('sec.lastMovement'), value: rows[0] ? f.dayMonth(rows[0].occurredAt) : '—' },
          ]} />
        <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Panel title={t('sec.byCategory')} note={f.monthName(`${month}-01`)}>
            {cat.length === 0 ? <p className="text-muted-foreground">{t('finance.noTransactions')}</p>
              : <BarRows rows={cat.map(([k, v]) => ({ label: k, value: v, max: top, tone: 'ok', text: f.money(v, sel.currency) }))} />}
          </Panel>
          <Panel title={t('finance.account')}>
            <Facts rows={[
              [t('staff.iban'), <Masked key="i" last4={sel.ibanLast4} none={t('notOnFile')} />],
              sel.institution ? [t('sec.bank'), sel.institution] : null,
              sel.ledgerAccount ? [t('finance.ledger'), <span key="l" className="tabular">{sel.ledgerAccount.code}</span>] : null,
              [t('sec.movements'), f.num(rows.length)],
            ]} />
          </Panel>
        </div>
        <Panel title={t('finance.transactions')}>
          <Table head={[t('date'), t('finance.payee'), t('finance.category'), t('finance.kind'), t('amount')]} numeric={[4]} empty={t('finance.noTransactions')}
            rows={rows.map((x) => [f.date(x.occurredAt), x.merchantName ?? x.description ?? '—', x.categoryId ? catName.get(x.categoryId) ?? '—' : '—',
              <span key="k" className={x.status === 'PENDING' ? 'text-muted-foreground' : undefined}>{label(t0, 'txType', x.type)}{x.status === 'PENDING' ? ` · ${label(t0, 'txStatus', x.status)}` : ''}</span>,
              <span key="a" className={OUT.includes(x.type) ? undefined : 'text-primary'}>{`${OUT.includes(x.type) ? '−' : '+'}${f.money(x.amount, x.currency)}`}</span>])} />
        </Panel>
      </>
    );
  }
  return <ListDetail title={t('nav.finance')} base="/finance" items={items} selectedId={sel?.id ?? null} explicit={!!id} detail={detail} empty={t('empty.finance')}
    summary={t('sec.finance.summary', { count: accounts.length, amount: f.money(total) })}
    stats={[
      { label: t('sec.totalBalance'), value: f.money(total) },
      { label: t('sec.spentMonth'), value: f.money(spent) },
      { label: t('sec.incomeMonth'), value: f.money(income), tone: income ? 'ok' : undefined },
      { label: t('sec.movementsMonth'), value: f.num(inMonth.length) },
    ]} />;
}
