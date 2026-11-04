import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { LocalKmsProvider } from '@herp/crypto';
import { createApp } from '../src/app.factory';
import { ServiceDb } from '../src/worker/service-db';
import { provisionTenantKeys, runRecurringBills } from '../src/worker/jobs';
import { H2, MEMBERSHIPS, USERS, as, testEnv } from './helpers';

let app: INestApplication;
let worker: ServiceDb;
const http = () => request(app.getHttpServer());
type Line = { accountCode: string; debit: string; credit: string };
type Entry = { id: string; source: string; status: string; reversalOfId: string | null; lines: Line[] };
const entriesFor = async (sourceId: string): Promise<Entry[]> =>
  (await http().get('/v1/ledger/journal').query({ sourceId }).set(await as(USERS.head)).expect(200)).body.data;
const sides = (e: Entry) => e.lines.map((l) => `${Number(l.debit) > 0 ? 'Dr' : 'Cr'} ${l.accountCode} ${Number(l.debit) > 0 ? l.debit : l.credit}`).sort();
const balanceOf = async (id: string) => (await http().get(`/v1/accounts/${id}`).set(await as(USERS.head)).expect(200)).body.balance as string;

type FixtureKey = 'bank' | 'cardAcct' | 'food' | 'groceries' | 'dining' | 'salaryIncome' | 'card' | 'sec' | 'float' | 'salaryPayment' | 'funding' | 'budget' | 'rent';
const ids = {} as Record<FixtureKey, string>;
let bankCode = '', cardAcctCode = '';

beforeAll(async () => {
  testEnv();
  worker = new ServiceDb(process.env.WORKER_DATABASE_URL!);
  await provisionTenantKeys(worker, new LocalKmsProvider(process.env.HERP_LOCAL_KEK, 'test'));
  app = await createApp();
  await app.init();
});
afterAll(async () => { await app?.close(); await worker?.close(); });

describe('bank accounts ↔ ledger', () => {
  it('a current account gets its own 12xx ledger account; the opening balance is posted against equity', async () => {
    const r = await http().post('/v1/accounts').set(await as(USERS.head)).send({ type: 'BANK_CURRENT', name: 'Al Rajhi current', institution: 'Al Rajhi Bank',
      iban: 'SA44 2000 0001 2345 6789 1234', openingBalance: 10000 }).expect(201);
    expect(r.body).toMatchObject({ balance: '10000.00', ibanLast4: '1234', currency: 'SAR', ledgerAccount: { code: expect.stringMatching(/^12\d\d$/) } });
    expect(JSON.stringify(r.body)).not.toMatch(/SA44|Ciphertext/);
    ids.bank = r.body.id; bankCode = r.body.ledgerAccount.code;
    expect(sides((await entriesFor(ids.bank))[0]!)).toEqual(['Cr 3100 10000.00', `Dr ${bankCode} 10000.00`]);
  });

  it('a credit-card account is a 22xx liability; an opening debt is negative', async () => {
    const r = await http().post('/v1/accounts').set(await as(USERS.head)).send({ type: 'CREDIT_CARD', name: 'SNB Visa', openingBalance: -2500 }).expect(201);
    ids.cardAcct = r.body.id; cardAcctCode = r.body.ledgerAccount.code;
    expect(cardAcctCode).toMatch(/^22\d\d$/);
    expect(sides((await entriesFor(ids.cardAcct))[0]!)).toEqual([`Cr ${cardAcctCode} 2500.00`, 'Dr 3100 2500.00']);
  });

  it('invalid IBAN → 400; staff cannot open accounts; the balance is never writable', async () => {
    await http().post('/v1/accounts').set(await as(USERS.head)).send({ type: 'BANK_SAVINGS', name: 'x', iban: 'SA44 2000 0001 2345 6789 1235' }).expect(400);
    await http().post('/v1/accounts').set(await as(USERS.maid)).send({ type: 'CASH_BOX', name: 'mine' }).expect(403);
    await http().patch(`/v1/accounts/${ids.bank}`).set(await as(USERS.head)).send({ balance: 1e6 }).expect(400);
  });
});

describe('categories and cards', () => {
  beforeAll(async () => {
    const mk = async (kind: string, name: string, parentId?: string) =>
      (await http().post('/v1/categories').set(await as(USERS.head)).send({ kind, name, parentId }).expect(201)).body.id as string;
    ids.food = await mk('EXPENSE', 'Food');
    ids.groceries = await mk('EXPENSE', 'Groceries', ids.food);
    ids.dining = await mk('EXPENSE', 'Dining out');
    ids.salaryIncome = await mk('INCOME', 'Salary');
  });

  it('a debit card for the cook: limits and allowed categories', async () => {
    const r = await http().post('/v1/cards').set(await as(USERS.head)).send({ accountId: ids.bank, holderId: MEMBERSHIPS.cook, type: 'DEBIT', last4: '4321',
      expiryMonth: 12, expiryYear: 2030, perTxnLimit: 300, dailyLimit: 500, monthlyLimit: 1000, allowedCategoryIds: [ids.groceries] }).expect(201);
    expect(r.body).toMatchObject({ status: 'ACTIVE', limits: { perTxn: '300.00', daily: '500.00', monthly: '1000.00' } });
    ids.card = r.body.id;
    await http().post('/v1/cards').set(await as(USERS.head)).send({ accountId: ids.bank, type: 'CREDIT', last4: '1111', expiryMonth: 1, expiryYear: 2030 }).expect(422);
  });

  it('the cook spends with her card: posted, ledger Dr expense / Cr bank, balance down', async () => {
    const r = await http().post('/v1/transactions').set(await as(USERS.cook)).send({ type: 'EXPENSE', accountId: ids.bank, cardId: ids.card, amount: 120,
      categoryId: ids.groceries, merchantName: 'Panda' }).expect(201);
    // The cook cannot read the ledger, so she sees no entry; the Head does.
    expect(r.body).toMatchObject({ status: 'POSTED', spentById: MEMBERSHIPS.cook, ledgerEntry: null });
    expect(sides((await entriesFor(r.body.id))[0]!)).toEqual([`Cr ${bankCode} 120.00`, 'Dr 6200 120.00']);
    expect(await balanceOf(ids.bank)).toBe('9880.00');
    await http().post('/v1/transactions').set(await as(USERS.cook)).send({ type: 'EXPENSE', accountId: ids.bank, cardId: ids.card, amount: 250, categoryId: ids.groceries }).expect(201);
  });

  it('card rules: category, per-transaction and daily limits; no card → no bank access', async () => {
    const spend = async (amount: number, categoryId = ids.groceries, cardId: string | undefined = ids.card) =>
      http().post('/v1/transactions').set(await as(USERS.cook)).send({ type: 'EXPENSE', accountId: ids.bank, cardId, amount, categoryId });
    expect((await spend(20, ids.dining)).body.detail).toMatch(/not allowed for that category/);
    expect((await spend(301)).body.detail).toMatch(/per-transaction limit/);
    expect((await spend(200)).body.detail).toMatch(/daily limit 500.00 reached \(spent 370.00 today\)/);
    // No card at all (not via the helper: a default parameter would substitute the card).
    expect((await http().post('/v1/transactions').set(await as(USERS.cook)).send({ type: 'EXPENSE', accountId: ids.bank, amount: 10, categoryId: ids.groceries })).status).toBe(403);
    const s = await http().get(`/v1/cards/${ids.card}/spending`).set(await as(USERS.cook)).expect(200);
    expect(s.body).toMatchObject({ today: '370.00', remaining: { daily: '130.00', monthly: '630.00' } });
  });

  it('the holder can freeze her card (not unfreeze it); a frozen card is refused', async () => {
    expect((await http().post(`/v1/cards/${ids.card}/freeze`).set(await as(USERS.cook)).expect(201)).body.status).toBe('FROZEN');
    expect((await http().post('/v1/transactions').set(await as(USERS.cook)).send({ type: 'EXPENSE', accountId: ids.bank, cardId: ids.card, amount: 5, categoryId: ids.groceries }).expect(422)).body.detail).toMatch(/card is FROZEN/);
    await http().post(`/v1/cards/${ids.card}/unfreeze`).set(await as(USERS.cook)).expect(403);
    await http().patch(`/v1/cards/${ids.card}`).set(await as(USERS.cook)).send({ dailyLimit: 99999 }).expect(403);
    expect((await http().post(`/v1/cards/${ids.card}/unfreeze`).set(await as(USERS.head)).expect(201)).body.status).toBe('ACTIVE');
  });
});

describe('transactions', () => {
  it('income: Dr bank / Cr 4900 (unmapped income category)', async () => {
    const r = await http().post('/v1/transactions').set(await as(USERS.head)).send({ type: 'INCOME', accountId: ids.bank, amount: 15000, categoryId: ids.salaryIncome, merchantName: 'Employer' }).expect(201);
    expect(sides((await entriesFor(r.body.id))[0]!)).toEqual(['Cr 4900 15000.00', `Dr ${bankCode} 15000.00`]);
  });

  it('paying the credit card is a transfer: card debt shrinks, Dr 22xx / Cr 12xx', async () => {
    const r = await http().post('/v1/transactions').set(await as(USERS.head)).send({ type: 'TRANSFER', accountId: ids.bank, counterAccountId: ids.cardAcct, amount: 1000 }).expect(201);
    expect(sides((await entriesFor(r.body.id))[0]!)).toEqual([`Cr ${bankCode} 1000.00`, `Dr ${cardAcctCode} 1000.00`]);
    expect(await balanceOf(ids.cardAcct)).toBe('-1500.00');
  });

  it('a category income/expense mismatch is refused', async () => {
    await http().post('/v1/transactions').set(await as(USERS.head)).send({ type: 'EXPENSE', accountId: ids.bank, amount: 1, categoryId: ids.salaryIncome }).expect(422);
  });

  it('PENDING posts nothing until confirmed; posted money fields are frozen', async () => {
    const r = await http().post('/v1/transactions').set(await as(USERS.head)).send({ type: 'EXPENSE', accountId: ids.bank, amount: 75, status: 'PENDING', merchantName: 'SEC' }).expect(201);
    expect(r.body.ledgerEntry).toBeNull();
    const before = Number(await balanceOf(ids.bank));
    expect((await http().patch(`/v1/transactions/${r.body.id}`).set(await as(USERS.head)).send({ status: 'POSTED' }).expect(200)).body.ledgerEntry.status).toBe('POSTED');
    expect(Number(await balanceOf(ids.bank))).toBeCloseTo(before - 75, 2);
    await http().patch(`/v1/transactions/${r.body.id}`).set(await as(USERS.head)).send({ categoryId: ids.dining }).expect(422);
    expect((await http().patch(`/v1/transactions/${r.body.id}`).set(await as(USERS.head)).send({ description: 'Electricity Oct' }).expect(200)).body.description).toBe('Electricity Oct');
    ids.sec = r.body.id;
  });

  it('reversal restores the balance and mirrors the ledger entry, once, managers only', async () => {
    const before = Number(await balanceOf(ids.bank));
    await http().post(`/v1/transactions/${ids.sec}/reverse`).set(await as(USERS.maid)).send({ reason: 'oops' }).expect(403);
    expect((await http().post(`/v1/transactions/${ids.sec}/reverse`).set(await as(USERS.head)).send({ reason: 'duplicate bill' }).expect(201)).body.status).toBe('REVERSED');
    expect(Number(await balanceOf(ids.bank))).toBeCloseTo(before + 75, 2);
    const [orig] = await entriesFor(ids.sec!);
    expect(orig!.status).toBe('REVERSED');
    await http().post(`/v1/transactions/${ids.sec}/reverse`).set(await as(USERS.head)).send({ reason: 'again' }).expect(422);
  });
});

describe('owner funding clearing reconciliation', () => {
  it('top-ups and salary payments are open clearing items; a funding withdrawal matches them to zero', async () => {
    const float = (await http().post('/v1/petty-cash').set(await as(USERS.head)).send({ custodianId: MEMBERSHIPS.cook, name: 'Market float', floatLimit: 1000, receiptRequiredOver: 100 }).expect(201)).body.id;
    ids.float = float;
    const top = await http().post(`/v1/petty-cash/${float}/top-ups`).set(await as(USERS.head)).send({ amount: 400 }).expect(201);
    const [topEntry] = await entriesFor(top.body.entry.id);
    const staff = (await http().post('/v1/staff').set(await as(USERS.head)).send({ staffType: 'DRIVER', fullName: { en: 'Rashid' }, nationality: 'PK' }).expect(201)).body.id;
    const pay = await http().post(`/v1/staff/${staff}/salary-payments`).set(await as(USERS.head)).send({ periodYear: 2026, periodMonth: 11, amount: 1200, channel: 'CASH' }).expect(201);
    ids.salaryPayment = pay.body.id;
    const [payEntry] = await entriesFor(pay.body.id);

    const open = (await http().get('/v1/funding-clearing').set(await as(USERS.head)).expect(200)).body;
    expect(open.openItems.map((i: { journalEntryId: string }) => i.journalEntryId)).toEqual(expect.arrayContaining([topEntry!.id, payEntry!.id]));

    const f = await http().post('/v1/transactions').set(await as(USERS.head)).send({ type: 'TRANSFER', isFunding: true, accountId: ids.bank, amount: 1600,
      merchantName: 'ATM cash + transfer to driver' }).expect(201);
    ids.funding = f.body.id;
    expect(sides((await entriesFor(f.body.id))[0]!)).toEqual([`Cr ${bankCode} 1600.00`, 'Dr 1190 1600.00']);
    const sug = (await http().get(`/v1/transactions/${f.body.id}/funding-suggestions`).set(await as(USERS.head)).expect(200)).body;
    expect(sug.candidates.map((c: { journalEntryId: string }) => c.journalEntryId)).toEqual(expect.arrayContaining([topEntry!.id, payEntry!.id]));

    await http().post(`/v1/transactions/${f.body.id}/funding-matches`).set(await as(USERS.head)).send({ matches: [{ journalEntryId: topEntry!.id, amount: 401 }] }).expect(422);
    const m = await http().post(`/v1/transactions/${f.body.id}/funding-matches`).set(await as(USERS.head))
      .send({ matches: [{ journalEntryId: topEntry!.id, amount: 400 }, { journalEntryId: payEntry!.id, amount: 1200 }] }).expect(201);
    expect(m.body).toMatchObject({ unmatched: '0.00' });
    expect(m.body.fundingMatches).toHaveLength(2);

    const after = (await http().get('/v1/funding-clearing').set(await as(USERS.head)).expect(200)).body;
    expect(after.openItems.map((i: { journalEntryId: string }) => i.journalEntryId)).not.toEqual(expect.arrayContaining([topEntry!.id]));
    expect(after.unmatchedFunding.map((u: { transactionId: string }) => u.transactionId)).not.toContain(f.body.id);
  });

  it('matched items are protected: neither side can be reversed until unmatched', async () => {
    expect((await http().post(`/v1/transactions/${ids.funding}/reverse`).set(await as(USERS.head)).send({ reason: 'test' }).expect(422)).body.detail).toMatch(/unmatch it first/);
    expect((await http().post(`/v1/salary-payments/${ids.salaryPayment}/reverse`).set(await as(USERS.head)).send({ reason: 'test' }).expect(422)).body.detail).toMatch(/matched to owner funding/);
  });

  it('only funding transactions can be matched; staff cannot see or match', async () => {
    const plain = await http().post('/v1/transactions').set(await as(USERS.head)).send({ type: 'EXPENSE', accountId: ids.bank, amount: 10 }).expect(201);
    const [anyItem] = (await http().get('/v1/funding-clearing').set(await as(USERS.head))).body.openItems;
    if (anyItem) await http().post(`/v1/transactions/${plain.body.id}/funding-matches`).set(await as(USERS.head)).send({ matches: [{ journalEntryId: anyItem.journalEntryId, amount: 1 }] }).expect(422);
    await http().get('/v1/funding-clearing').set(await as(USERS.maid)).expect(200).then((r) => expect(r.body.openItems).toEqual([]));
  });

  it('unmatching releases both sides', async () => {
    const t = (await http().get(`/v1/transactions/${ids.funding}`).set(await as(USERS.head))).body;
    for (const m of t.fundingMatches) await http().delete(`/v1/transactions/${ids.funding}/funding-matches/${m.id}`).set(await as(USERS.head)).expect(200);
    expect((await http().get(`/v1/transactions/${ids.funding}`).set(await as(USERS.head))).body.unmatched).toBe('1600.00');
  });
});

describe('budgets', () => {
  it('spend rolls up sub-categories and includes approved petty cash; alert at the threshold', async () => {
    const monthStart = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date()).slice(0, 8) + '01';
    const b = await http().post('/v1/budgets').set(await as(USERS.head)).send({ name: 'Food', categoryId: ids.food, amount: 500, alertAtPct: 80, startsOn: monthStart }).expect(201);
    expect(b.body).toMatchObject({ spent: '370.00', fromBank: '370.00', percentUsed: 74, alert: false, currentPeriod: { start: monthStart } });
    const x = await http().post(`/v1/petty-cash/${ids.float}/expenses`).set(await as(USERS.cook)).send({ amount: 60, description: 'Vegetables', categoryId: ids.groceries }).expect(201);
    await http().post(`/v1/petty-cash/logs/${x.body.entry.id}/review`).set(await as(USERS.head)).send({ decision: 'APPROVED' }).expect(201);
    const after = (await http().get('/v1/budgets').set(await as(USERS.head))).body.data.find((y: { id: string }) => y.id === b.body.id);
    expect(after).toMatchObject({ spent: '430.00', fromPettyCash: '60.00', percentUsed: 86, alert: true, overBudget: false, remaining: '70.00' });
    ids.budget = b.body.id;
  });

  it('a personal budget counts only that member\'s card spending', async () => {
    const monthStart = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date()).slice(0, 8) + '01';
    const b = await http().post('/v1/budgets').set(await as(USERS.head)).send({ name: 'Cook card', ownerId: MEMBERSHIPS.cook, amount: 1000, startsOn: monthStart }).expect(201);
    expect(b.body).toMatchObject({ spent: '370.00', fromPettyCash: '0.00' });
  });

  it('changing a budget is Head / EFA only', async () => {
    await http().patch(`/v1/budgets/${ids.budget}`).set(await as(USERS.spouse)).send({ amount: 900 }).expect(403);
    expect((await http().patch(`/v1/budgets/${ids.budget}`).set(await as(USERS.efa)).send({ amount: 900 }).expect(200)).body).toMatchObject({ amount: '900.00', alert: false });
  });
});

describe('recurring bills', () => {
  const firstOfMonthsAgo = (n: number) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 1, 6)).toISOString(); };

  it('a monthly rent bill catches up missed months once, idempotently, posting each', async () => {
    const before = Number(await balanceOf(ids.bank));
    const r = await http().post('/v1/recurring').set(await as(USERS.head)).send({ name: 'Villa rent', frequency: 'MONTHLY', firstRunAt: firstOfMonthsAgo(2), autoPost: true,
      template: { type: 'EXPENSE', accountId: ids.bank, amount: 3000, merchantName: 'Landlord' } }).expect(201);
    ids.rent = r.body.id;
    const run1 = await runRecurringBills(worker);
    const mine = (await http().get('/v1/transactions').query({ accountId: ids.bank }).set(await as(USERS.head))).body.data.filter((t: { recurringRuleId: string }) => t.recurringRuleId === ids.rent);
    expect(mine).toHaveLength(3);
    expect(mine.every((t: { status: string; source: string }) => t.status === 'POSTED' && t.source === 'RECURRING')).toBe(true);
    expect(Number(await balanceOf(ids.bank))).toBeCloseTo(before - 9000, 2);
    expect(run1.failures.filter((f) => f.ruleId === ids.rent)).toEqual([]);
    await runRecurringBills(worker);
    expect((await http().get('/v1/transactions').query({ accountId: ids.bank }).set(await as(USERS.head))).body.data
      .filter((t: { recurringRuleId: string }) => t.recurringRuleId === ids.rent)).toHaveLength(3);
    const rule = (await http().get('/v1/recurring').set(await as(USERS.head))).body.data.find((x: { id: string }) => x.id === ids.rent);
    expect(new Date(rule.nextRunAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('autoPost=false leaves bills PENDING for review', async () => {
    const r = await http().post('/v1/recurring').set(await as(USERS.head)).send({ name: 'Internet', frequency: 'MONTHLY', firstRunAt: firstOfMonthsAgo(0),
      template: { type: 'EXPENSE', accountId: ids.bank, amount: 345, merchantName: 'STC' } }).expect(201);
    await runRecurringBills(worker);
    const t = (await http().get('/v1/transactions').query({ accountId: ids.bank, status: 'PENDING' }).set(await as(USERS.head))).body.data
      .filter((x: { recurringRuleId: string }) => x.recurringRuleId === r.body.id);
    expect(t).toHaveLength(1);
  });

  it('a bill that breaks a card rule is reported and retried, not skipped', async () => {
    const r = await http().post('/v1/recurring').set(await as(USERS.head)).send({ name: 'Too big for the card', frequency: 'MONTHLY', firstRunAt: firstOfMonthsAgo(0), autoPost: true,
      template: { type: 'EXPENSE', accountId: ids.bank, cardId: ids.card, categoryId: ids.groceries, amount: 400 } }).expect(201);
    const run = await runRecurringBills(worker);
    expect(run.failures.find((f) => f.ruleId === r.body.id)?.error).toMatch(/per-transaction limit/);
    const rule = (await http().get('/v1/recurring').set(await as(USERS.head))).body.data.find((x: { id: string }) => x.id === r.body.id);
    expect(new Date(rule.nextRunAt).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('templates cannot reference another household; staff cannot set up bills', async () => {
    const h2acct = (await http().post('/v1/accounts').set(await as(USERS.head2, H2)).send({ type: 'BANK_CURRENT', name: 'Other bank' }).expect(201)).body.id;
    await http().post('/v1/recurring').set(await as(USERS.head)).send({ name: 'x', frequency: 'MONTHLY', firstRunAt: firstOfMonthsAgo(0),
      template: { type: 'EXPENSE', accountId: h2acct, amount: 1 } }).expect(422);
    await http().post('/v1/recurring').set(await as(USERS.maid)).send({ name: 'x', frequency: 'MONTHLY', firstRunAt: firstOfMonthsAgo(0),
      template: { type: 'EXPENSE', accountId: ids.bank, amount: 1 } }).expect(403);
    expect((await http().get('/v1/accounts').set(await as(USERS.head2, H2))).body.data.map((a: { id: string }) => a.id)).toEqual([h2acct]);
    await http().get(`/v1/transactions/${ids.sec}`).set(await as(USERS.head2, H2)).expect(404);
  });
});

describe('bank statement reconciliation', () => {
  it('a wrong statement balance changes nothing; the right one marks everything RECONCILED', async () => {
    const bal = Number(await balanceOf(ids.bank));
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
    const wrong = await http().post(`/v1/accounts/${ids.bank}/reconcile`).set(await as(USERS.head)).send({ statementBalance: bal + 10, asOf: today }).expect(201);
    expect(wrong.body).toMatchObject({ reconciled: false, difference: '10.00' });
    const ok = await http().post(`/v1/accounts/${ids.bank}/reconcile`).set(await as(USERS.head)).send({ statementBalance: bal, asOf: today }).expect(201);
    expect(ok.body).toMatchObject({ reconciled: true, difference: '0.00' });
    expect(ok.body.transactionsReconciled).toBeGreaterThan(5);
    const posted = (await http().get('/v1/transactions').query({ accountId: ids.bank, status: 'POSTED' }).set(await as(USERS.head))).body.data;
    expect(posted).toEqual([]);
  });
});
