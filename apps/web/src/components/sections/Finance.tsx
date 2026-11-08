import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { apiGet } from '@/lib/api';
import { fmt } from '@/lib/fmt';
import { label, type Rows } from '@/lib/sections';
import { Block, Facts, ListDetail, Masked, RecordHeader, Table } from '../ListDetail';

type Opts = { household: string; locale: string };
interface Account { id: string; type: string; name: string; institution: string | null; ibanLast4: string | null; currency: string; openingBalance: string; balance: string; isActive: boolean; ledgerAccount: { code: string } | null }
interface Tx { id: string; type: string; status: string; amount: string; currency: string; merchantName: string | null; description: string | null; categoryId: string | null; occurredAt: string; isFunding: boolean }

const OUT = ['EXPENSE', 'ALLOWANCE'];

export async function FinanceSection({ opts, id }: { opts: Opts; id: string | null; tab: string | null }) {
  const [t, f, list] = await Promise.all([getTranslations('ui'), fmt(), apiGet<Rows<Account>>('/v1/accounts', opts)]);
  const accounts = (list?.data ?? []).filter((a) => a.isActive);
  const sel = id ? accounts.find((a) => a.id === id) : accounts[0];
  if (id && !sel) notFound();
  const items = accounts.map((a) => ({ id: a.id, primary: a.name, secondary: `${label(t, 'accountType', a.type)} · ${f.money(a.balance, a.currency)}` }));

  let detail = null;
  if (sel) {
    const [txs, cats] = await Promise.all([
      apiGet<Rows<Tx>>(`/v1/transactions?accountId=${sel.id}`, opts),
      apiGet<Rows<{ id: string; name: string }>>('/v1/categories', opts),
    ]);
    const catName = new Map((cats?.data ?? []).map((c) => [c.id, c.name]));
    const rows = [...(txs?.data ?? [])].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    detail = (
      <>
        <RecordHeader title={sel.name} meta={[label(t, 'accountType', sel.type), sel.institution].filter(Boolean).join(' · ')} />
        <div className="grid gap-10">
          <Block title={t('finance.account')}>
            <Facts rows={[
              [t('finance.balance'), <strong key="b" className="font-semibold tabular">{f.money(sel.balance, sel.currency)}</strong>],
              [t('finance.opening'), <span key="o" className="tabular">{f.money(sel.openingBalance, sel.currency)}</span>],
              [t('staff.iban'), <Masked key="i" last4={sel.ibanLast4} none={t('notOnFile')} />],
              sel.ledgerAccount ? [t('finance.ledger'), <span key="l" className="tabular">{sel.ledgerAccount.code}</span>] : null,
            ]} />
          </Block>
          <Block title={t('finance.transactions')}>
            <Table head={[t('date'), t('finance.payee'), t('finance.category'), t('finance.kind'), t('amount')]} numeric={[4]} empty={t('finance.noTransactions')}
              rows={rows.map((x) => [f.date(x.occurredAt), x.merchantName ?? x.description ?? '—', x.categoryId ? catName.get(x.categoryId) ?? '—' : '—',
                <span key="k" className={x.status === 'PENDING' ? 'text-muted-foreground' : undefined}>{label(t, 'txType', x.type)}{x.status === 'PENDING' ? ` · ${label(t, 'txStatus', x.status)}` : ''}</span>,
                `${OUT.includes(x.type) ? '−' : ''}${f.money(x.amount, x.currency)}`])} />
          </Block>
        </div>
      </>
    );
  }
  return <ListDetail title={t('nav.finance')} base="/finance" items={items} selectedId={sel?.id ?? null} explicit={!!id} detail={detail} empty={t('empty.finance')} />;
}
