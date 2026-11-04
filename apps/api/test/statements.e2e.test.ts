import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app.factory';
import { H2, MEMBERSHIPS, USERS, as, riyadhDate, testEnv } from './helpers';

let app: INestApplication;
const http = () => request(app.getHttpServer());
const dmy = (offset: number) => { const [y, m, d] = riyadhDate(offset).split('-'); return `${d}/${m}/${y}`; };
type Ids = 'bank' | 'savings' | 'panda' | 'salary' | 'utilities' | 'stmt' | 'float';
const ids = {} as Record<Ids, string>;

beforeAll(async () => {
  testEnv(); app = await createApp(); await app.init();
  ids.bank = (await http().post('/v1/accounts').set(await as(USERS.head)).send({ type: 'BANK_CURRENT', name: 'SNB current', openingBalance: 5000 }).expect(201)).body.id;
  ids.savings = (await http().post('/v1/accounts').set(await as(USERS.head)).send({ type: 'BANK_SAVINGS', name: 'SNB savings' }).expect(201)).body.id;
  ids.utilities = (await http().post('/v1/categories').set(await as(USERS.head)).send({ kind: 'EXPENSE', name: 'Utilities' }).expect(201)).body.id;
  ids.panda = (await http().post('/v1/transactions').set(await as(USERS.head)).send({ type: 'EXPENSE', accountId: ids.bank, amount: 120, merchantName: 'Panda',
    occurredAt: `${riyadhDate(-3)}T15:00:00+03:00` }).expect(201)).body.id;
  ids.salary = (await http().post('/v1/transactions').set(await as(USERS.head)).send({ type: 'INCOME', accountId: ids.bank, amount: 3000, merchantName: 'Employer',
    occurredAt: `${riyadhDate(-1)}T09:00:00+03:00` }).expect(201)).body.id;
});
afterAll(async () => { await app?.close(); });

// Arabic export, newest first, debit/credit columns, running balance from 5000.
const csv = () => `التاريخ,البيان,مدين,دائن,الرصيد
${dmy(0)},تحويل إلى حساب التوفير,1000.00,,6424.50
${dmy(0)},STC FIBER,55.50,,7424.50
${dmy(-1)},ATM WITHDRAWAL,400.00,,7480.00
${dmy(-2)},SALARY EMPLOYER,,3000.00,7880.00
${dmy(-3)},PANDA RIYADH,120.00,,4880.00`;

describe('statement import & batch reconciliation', () => {
  it('parses, stores and auto-matches existing transactions (amount exact, ±3 days)', async () => {
    const r = await http().post(`/v1/accounts/${ids.bank}/statements`).set(await as(USERS.head)).send({ fileName: 'snb-nov.csv', content: csv() }).expect(201);
    ids.stmt = r.body.id;
    expect(r.body).toMatchObject({ format: 'CSV', status: 'PARSED', openingBalance: '5000.00', closingBalance: '6424.50',
      summary: { lines: 5, matched: 2, unmatched: 3 }, duplicatesSkipped: 0 });
    const byDesc = Object.fromEntries(r.body.lines.map((l: { description: string }) => [l.description, l]));
    expect(byDesc['PANDA RIYADH']).toMatchObject({ status: 'MATCHED', transactionId: ids.panda, amount: '-120.00' });
    expect(byDesc['SALARY EMPLOYER']).toMatchObject({ status: 'MATCHED', transactionId: ids.salary }); // 1 day apart
  });

  it('the same file twice → 409; an overlapping statement skips lines already imported', async () => {
    await http().post(`/v1/accounts/${ids.bank}/statements`).set(await as(USERS.head)).send({ fileName: 'again.csv', content: csv() }).expect(409);
    const overlap = `Date,Description,Amount\n${dmy(0)},STC FIBER,-55.50\n${dmy(0)},CAFE,-12.00`;
    const r = await http().post(`/v1/accounts/${ids.bank}/statements`).set(await as(USERS.head)).send({ fileName: 'partial.csv', content: overlap }).expect(201);
    expect(r.body).toMatchObject({ duplicatesSkipped: 1, summary: { lines: 1 } });
  });

  it('review: unmatch, re-match, refuse a wrong-amount match, ignore', async () => {
    const s = (await http().get(`/v1/statements/${ids.stmt}`).set(await as(USERS.head))).body;
    const panda = s.lines.find((l: { description: string }) => l.description === 'PANDA RIYADH');
    await http().post(`/v1/statements/${ids.stmt}/lines/${panda.id}`).set(await as(USERS.head)).send({ action: 'unmatch' }).expect(201);
    // Already linked to another line → 409 (API); free but different amount → 422 (DB rule).
    await http().post(`/v1/statements/${ids.stmt}/lines/${panda.id}`).set(await as(USERS.head)).send({ action: 'match', transactionId: ids.salary }).expect(409);
    const other = (await http().post('/v1/transactions').set(await as(USERS.head)).send({ type: 'EXPENSE', accountId: ids.bank, amount: 121,
      occurredAt: `${riyadhDate(-30)}T09:00:00+03:00` }).expect(201)).body.id;
    const r = await http().post(`/v1/statements/${ids.stmt}/lines/${panda.id}`).set(await as(USERS.head)).send({ action: 'match', transactionId: other }).expect(422);
    expect(r.body.detail).toMatch(/does not match line/);
    await http().post(`/v1/transactions/${other}/reverse`).set(await as(USERS.head)).send({ reason: 'test fixture' }).expect(201);
    await http().post(`/v1/statements/${ids.stmt}/lines/${panda.id}`).set(await as(USERS.head)).send({ action: 'match', transactionId: ids.panda }).expect(201);
  });

  it('apply: unmatched lines become BANK_FEED transactions (funding, transfer, categorised expense); all reconciled; books = bank', async () => {
    const s = (await http().get(`/v1/statements/${ids.stmt}`).set(await as(USERS.head))).body;
    const line = (d: string) => s.lines.find((l: { description: string }) => l.description === d).id;
    const r = await http().post(`/v1/statements/${ids.stmt}/apply`).set(await as(USERS.head)).send({ lines: [
      { lineId: line('ATM WITHDRAWAL'), isFunding: true },
      { lineId: line('تحويل إلى حساب التوفير'), counterAccountId: ids.savings },
      { lineId: line('STC FIBER'), categoryId: ids.utilities },
    ] }).expect(201);
    expect(r.body).toMatchObject({ status: 'APPLIED', transactionsCreated: 3, transactionsReconciled: 5, summary: { matched: 2, created: 3, unmatched: 0 },
      balanceCheck: { bank: '6424.50', books: '6424.50', balanced: true } });
    const txns = (await http().get('/v1/transactions').query({ accountId: ids.bank }).set(await as(USERS.head))).body.data;
    // Every live transaction is reconciled (the reversed fixture from the review step is excluded).
    expect(txns.filter((t: { status: string }) => t.status !== 'REVERSED').every((t: { status: string }) => t.status === 'RECONCILED')).toBe(true);
    const atm = txns.find((t: { merchantName: string }) => t.merchantName === 'ATM WITHDRAWAL');
    expect(atm).toMatchObject({ type: 'TRANSFER', isFunding: true, source: 'BANK_FEED' });
    expect(txns.find((t: { merchantName: string }) => t.merchantName === 'STC FIBER')).toMatchObject({ type: 'EXPENSE', categoryId: ids.utilities });
    expect((await http().get(`/v1/accounts/${ids.savings}`).set(await as(USERS.head))).body.balance).toBe('1000.00');
  });

  it('an applied statement is final', async () => {
    await http().post(`/v1/statements/${ids.stmt}/apply`).set(await as(USERS.head)).send({}).expect(409);
    const s = (await http().get(`/v1/statements/${ids.stmt}`).set(await as(USERS.head))).body;
    await http().post(`/v1/statements/${ids.stmt}/lines/${s.lines[0].id}`).set(await as(USERS.head)).send({ action: 'ignore' }).expect(422);
  });

  it('OFX (base64) imports too; staff and other households cannot import', async () => {
    const ofx = `OFXHEADER:100\n<OFX><STMTRS><CURDEF>SAR<BANKTRANLIST><STMTTRN><DTPOSTED>${riyadhDate(0).replace(/-/g, '')}<TRNAMT>-9.99<FITID>OFX-1<NAME>APPLE\n</BANKTRANLIST><LEDGERBAL><BALAMT>6414.51</LEDGERBAL></STMTRS></OFX>`;
    const r = await http().post(`/v1/accounts/${ids.bank}/statements`).set(await as(USERS.head))
      .send({ fileName: 'nov.ofx', content: Buffer.from(ofx).toString('base64'), encoding: 'base64' }).expect(201);
    expect(r.body).toMatchObject({ format: 'OFX', closingBalance: '6414.51', summary: { lines: 1, unmatched: 1 } });
    await http().post(`/v1/accounts/${ids.bank}/statements`).set(await as(USERS.maid)).send({ fileName: 'x.csv', content: csv() + '\n' }).expect(404);
    await http().post(`/v1/accounts/${ids.bank}/statements`).set(await as(USERS.head2, H2)).send({ fileName: 'x.csv', content: csv() + '\n\n' }).expect(404);
  });

  it('unparseable files → 400 with the reason', async () => {
    const r = await http().post(`/v1/accounts/${ids.bank}/statements`).set(await as(USERS.head)).send({ fileName: 'x.csv', content: 'hello,world\n1,2\n3,4' }).expect(400);
    expect(r.body.detail).toMatch(/date and amount/);
  });
});

describe('one-touch bank → petty-cash float', () => {
  it('moves money, posts both sides and matches them, leaving nothing to reconcile by hand', async () => {
    ids.float = (await http().post('/v1/petty-cash').set(await as(USERS.head)).send({ custodianId: MEMBERSHIPS.cook, name: 'Driver float', floatLimit: 1000 }).expect(201)).body.id;
    const before = Number((await http().get(`/v1/accounts/${ids.savings}`).set(await as(USERS.head))).body.balance);
    const r = await http().post(`/v1/petty-cash/${ids.float}/fund-from-bank`).set(await as(USERS.head)).send({ accountId: ids.savings, amount: 300 }).expect(201);
    expect(r.body).toMatchObject({ float: { balance: '300.00' }, entry: { type: 'TOP_UP' }, fundingMatched: '300.00' });
    expect(Number((await http().get(`/v1/accounts/${ids.savings}`).set(await as(USERS.head))).body.balance)).toBeCloseTo(before - 300, 2);
    const bankTxn = (await http().get(`/v1/transactions/${r.body.bankTransactionId}`).set(await as(USERS.head))).body;
    expect(bankTxn).toMatchObject({ isFunding: true, unmatched: '0.00' });
    const clearing = (await http().get('/v1/funding-clearing').set(await as(USERS.head))).body;
    expect(clearing.unmatchedFunding.map((u: { transactionId: string }) => u.transactionId)).not.toContain(r.body.bankTransactionId);
  });

  it('it is all-or-nothing: a top-up over the float limit leaves the bank untouched', async () => {
    const before = (await http().get(`/v1/accounts/${ids.savings}`).set(await as(USERS.head))).body.balance;
    await http().post(`/v1/petty-cash/${ids.float}/fund-from-bank`).set(await as(USERS.head)).send({ accountId: ids.savings, amount: 900 }).expect(422);
    expect((await http().get(`/v1/accounts/${ids.savings}`).set(await as(USERS.head))).body.balance).toBe(before);
  });

  it('the custodian cannot fund her own float from the bank', async () => {
    await http().post(`/v1/petty-cash/${ids.float}/fund-from-bank`).set(await as(USERS.cook)).send({ accountId: ids.savings, amount: 10 }).expect(403);
  });
});
