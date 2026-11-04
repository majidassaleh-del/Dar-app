import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { LocalKmsProvider } from '@herp/crypto';
import { createApp } from '../src/app.factory';
import { PrismaService } from '../src/db/prisma.service';
import { ServiceDb } from '../src/worker/service-db';
import { provisionTenantKeys } from '../src/worker/jobs';
import { H1, H2, MEMBERSHIPS, USERS, as, riyadhDate, testEnv } from './helpers';

let app: INestApplication;
let worker: ServiceDb;
const http = () => request(app.getHttpServer());
type Line = { accountCode: string; debit: string; credit: string; staffId: string | null };
type Entry = { id: string; number: string; source: string; status: string; reversalOfId: string | null; lines: Line[]; totals: { debit: string; credit: string } };
const entriesFor = async (sourceId: string): Promise<Entry[]> =>
  (await http().get('/v1/ledger/journal').query({ sourceId }).set(await as(USERS.head)).expect(200)).body.data;
const sides = (e: Entry) => e.lines.map((l) => `${Number(l.debit) > 0 ? 'Dr' : 'Cr'} ${l.accountCode} ${Number(l.debit) > 0 ? l.debit : l.credit}`).sort();

let cookStaffId: string, floatId: string, floatCode: string, groceriesAccountId: string, groceriesCategoryId: string;

beforeAll(async () => {
  testEnv();
  worker = new ServiceDb(process.env.WORKER_DATABASE_URL!);
  await provisionTenantKeys(worker, new LocalKmsProvider(process.env.HERP_LOCAL_KEK, 'test'));
  app = await createApp();
  await app.init();
  cookStaffId = (await http().post('/v1/staff').set(await as(USERS.head)).send({ staffType: 'COOK', fullName: { en: 'Sunita Devi' }, nationality: 'IN',
    membershipId: MEMBERSHIPS.cook, hireDate: '2026-01-01', defaultPayoutChannel: 'CASH' }).expect(201)).body.id;
  await http().post(`/v1/staff/${cookStaffId}/contracts`).set(await as(USERS.head)).send({ startDate: '2026-01-01', basicSalary: 1200 }).expect(201);
  const [cat] = await worker.run((tx) => tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO categories (id, "householdId", kind, "nameI18n") VALUES (gen_random_uuid(), ${H1}::uuid, 'EXPENSE', '{"en":"Groceries","ar":"بقالة"}') RETURNING id::text`);
  groceriesCategoryId = cat!.id;
});
afterAll(async () => { await app?.close(); await worker?.close(); });

describe('chart of accounts', () => {
  it('is seeded per household with system accounts, named in the viewer\'s language', async () => {
    const r = await http().get('/v1/ledger/accounts').set(await as(USERS.head, H1, 'ar')).expect(200);
    const byKey = Object.fromEntries(r.body.data.map((a: { systemKey: string }) => [a.systemKey, a]));
    expect(byKey.salaries_payable).toMatchObject({ code: '2100', type: 'LIABILITY', name: 'رواتب مستحقة الدفع', isSystem: true });
    expect(byKey.assets).toMatchObject({ code: '1000', isHeader: true });
  });

  it('staff cannot see the ledger; the accountant can read but not post', async () => {
    expect((await http().get('/v1/ledger/accounts').set(await as(USERS.maid)).expect(200)).body.data).toEqual([]);
    await http().post('/v1/ledger/accounts').set(await as(USERS.maid)).send({ code: '6299', name: 'x', type: 'EXPENSE' }).expect(403);
  });

  it('an EXPENSE account can be mapped to a category', async () => {
    const r = await http().post('/v1/ledger/accounts').set(await as(USERS.head)).send({ code: '6210', name: 'Groceries', type: 'EXPENSE',
      categoryId: groceriesCategoryId }).expect(201);
    groceriesAccountId = r.body.id;
    await http().post('/v1/ledger/accounts').set(await as(USERS.head)).send({ code: '4100', name: 'x', type: 'INCOME', categoryId: groceriesCategoryId }).expect(400);
  });

  it('system accounts can be renamed (re-typing and deletion are refused: DB suite)', async () => {
    const accs = (await http().get('/v1/ledger/accounts').set(await as(USERS.head))).body.data;
    const payable = accs.find((a: { systemKey: string }) => a.systemKey === 'salaries_payable');
    expect((await http().patch(`/v1/ledger/accounts/${payable.id}`).set(await as(USERS.head)).send({ name: 'Wages payable' }).expect(200)).body.name).toBe('Wages payable');
  });
});

describe('petty cash → ledger', () => {
  it('opening a float creates its own ledger account under 1100', async () => {
    const f = await http().post('/v1/petty-cash').set(await as(USERS.head)).send({ custodianId: MEMBERSHIPS.cook, name: 'Kitchen float', floatLimit: 500, receiptRequiredOver: 200 }).expect(201);
    floatId = f.body.id;
    const acc = (await http().get('/v1/ledger/accounts').set(await as(USERS.head))).body.data.find((a: { pettyCashAccountId: string }) => a.pettyCashAccountId === floatId);
    expect(acc).toMatchObject({ type: 'ASSET', isSystem: true, name: 'Petty cash – Kitchen float', balance: '0.00' });
    expect(acc.code).toMatch(/^11\d\d$/);
    floatCode = acc.code;
  });

  it('top-up posts Dr float / Cr owner funding clearing', async () => {
    const r = await http().post(`/v1/petty-cash/${floatId}/top-ups`).set(await as(USERS.head)).send({ amount: 300 }).expect(201);
    const [e] = await entriesFor(r.body.entry.id);
    expect(sides(e!)).toEqual([`Cr 1190 300.00`, `Dr ${floatCode} 300.00`]);
  });

  it('a pending expense posts nothing; approval posts to the category\'s mapped account', async () => {
    const x = await http().post(`/v1/petty-cash/${floatId}/expenses`).set(await as(USERS.cook)).send({ amount: 40, description: 'Sabzi', categoryId: groceriesCategoryId }).expect(201);
    expect(await entriesFor(x.body.entry.id)).toEqual([]);
    await http().post(`/v1/petty-cash/logs/${x.body.entry.id}/review`).set(await as(USERS.head)).send({ decision: 'APPROVED' }).expect(201);
    const [e] = await entriesFor(x.body.entry.id);
    expect(sides(e!)).toEqual([`Cr ${floatCode} 40.00`, 'Dr 6210 40.00']);
  });

  it('an uncategorised approved expense goes to 6200 Household expenses', async () => {
    const x = await http().post(`/v1/petty-cash/${floatId}/expenses`).set(await as(USERS.head)).send({ amount: 10, description: 'Ice' }).expect(201);
    expect(x.body.entry.status).toBe('APPROVED'); // recorded by a manager: no review step
    expect(sides((await entriesFor(x.body.entry.id))[0]!)).toEqual([`Cr ${floatCode} 10.00`, 'Dr 6200 10.00']);
  });

  it('a rejected expense becomes a receivable from the custodian (staff sub-ledger)', async () => {
    const x = await http().post(`/v1/petty-cash/${floatId}/expenses`).set(await as(USERS.cook)).send({ amount: 25, description: 'Snacks' }).expect(201);
    await http().post(`/v1/petty-cash/logs/${x.body.entry.id}/review`).set(await as(USERS.head)).send({ decision: 'REJECTED' }).expect(201);
    const [e] = await entriesFor(x.body.entry.id);
    expect(sides(e!)).toEqual([`Cr ${floatCode} 25.00`, 'Dr 1300 25.00']);
    expect(e!.lines.find((l) => l.accountCode === '1300')!.staffId).toBe(cookStaffId);
    expect((await http().get(`/v1/ledger/staff/${cookStaffId}`).set(await as(USERS.head)).expect(200)).body.owedByWorker).toBe('25.00');
  });

  it('a reviewed expense cannot be re-reviewed (the ledger already reflects it)', async () => {
    const logs = (await http().get(`/v1/petty-cash/${floatId}/logs`).query({ status: 'REJECTED' }).set(await as(USERS.head))).body.data;
    const r = await worker.run((tx) => tx.$executeRaw`UPDATE petty_cash_logs SET status = 'APPROVED' WHERE id = ${logs[0].id}::uuid`).catch((e: Error) => e.message);
    expect(r).toMatch(/already REJECTED/);
  });

  it('a counted shortage posts to 6950; the float account equals the cash in the box', async () => {
    const r = await http().post(`/v1/petty-cash/${floatId}/reconcile`).set(await as(USERS.head)).send({ countedCash: 220 }).expect(201);
    expect(r.body.variance).toBe('-5.00');
    expect(sides((await entriesFor(r.body.adjustment.id))[0]!)).toEqual([`Cr ${floatCode} 5.00`, 'Dr 6950 5.00']);
    const acc = (await http().get('/v1/ledger/accounts').set(await as(USERS.head))).body.data.find((a: { code: string }) => a.code === floatCode);
    expect(acc.balance).toBe('220.00');
    expect(r.body.float.balance).toBe('220.00');
  });
});

describe('payroll & salary → ledger', () => {
  let runId: string;

  it('a PAID run posts the accrual: Dr salaries / Cr salaries payable (per worker), balanced', async () => {
    runId = (await http().post('/v1/payroll-runs').set(await as(USERS.head)).send({ year: 2027, month: 2 }).expect(201)).body.id;
    await http().post(`/v1/payroll-runs/${runId}/approve`).set(await as(USERS.head)).expect(201);
    const run = (await http().get(`/v1/payroll-runs/${runId}`).set(await as(USERS.head))).body;
    expect(await entriesFor(runId)).toEqual([]); // nothing until PAID
    const payments = run.staff.filter((s: { net: string }) => Number(s.net) > 0).map((s: { staffId: string }) => ({ staffId: s.staffId, channel: 'CASH' }));
    await http().post(`/v1/payroll-runs/${runId}/pay`).set(await as(USERS.head)).send({ payments }).expect(201);

    const [accrual] = await entriesFor(runId);
    expect(accrual!.source).toBe('PAYROLL');
    expect(accrual!.totals.debit).toBe(accrual!.totals.credit);
    const netTotal = run.staff.reduce((s: number, x: { net: string }) => s + Math.max(0, Number(x.net)), 0);
    const payableCr = accrual!.lines.filter((l) => l.accountCode === '2100').reduce((s, l) => s + Number(l.credit), 0);
    expect(payableCr).toBeCloseTo(netTotal, 2);
    const cook = accrual!.lines.filter((l) => l.staffId === cookStaffId).map((l) => `${l.accountCode} ${Number(l.debit) > 0 ? 'Dr' : 'Cr'} ${Number(l.debit) || Number(l.credit)}`).sort();
    expect(cook).toEqual(['2100 Cr 1200', '6100 Dr 1200']);
  });

  it('each payment clears salaries payable: run payable nets to zero', async () => {
    const paid = (await http().get('/v1/salary-payments').query({ year: 2027, month: 2 }).set(await as(USERS.head))).body.data as Array<{ id: string; amount: string }>;
    let dr2100 = 0;
    for (const p of paid) {
      const [e] = await entriesFor(p.id);
      expect(sides(e!)).toEqual([`Cr 1190 ${p.amount}`, `Dr 2100 ${p.amount}`]);
      dr2100 += Number(p.amount);
    }
    const [accrual] = await entriesFor(runId);
    expect(dr2100).toBeCloseTo(accrual!.lines.filter((l) => l.accountCode === '2100').reduce((s, l) => s + Number(l.credit), 0), 2);
    expect((await http().get(`/v1/ledger/staff/${cookStaffId}`).set(await as(USERS.head))).body.salaryPayable).toBe('0.00');
  });

  it('a payment outside payroll expenses directly; reversing it posts a mirror entry', async () => {
    const p = await http().post(`/v1/staff/${cookStaffId}/salary-payments`).set(await as(USERS.head)).send({ periodYear: 2027, periodMonth: 3, amount: 100, channel: 'CASH' }).expect(201);
    expect(sides((await entriesFor(p.body.id))[0]!)).toEqual(['Cr 1190 100.00', 'Dr 6100 100.00']);
    await http().post(`/v1/salary-payments/${p.body.id}/reverse`).set(await as(USERS.head)).send({ reason: 'entered twice' }).expect(201);
    const [orig] = await entriesFor(p.body.id);
    expect(orig!.status).toBe('REVERSED');
    const all = (await http().get('/v1/ledger/journal').query({ source: 'REVERSAL' }).set(await as(USERS.head))).body.data as Entry[];
    const mirror = all.find((e) => e.reversalOfId === orig!.id)!;
    expect(sides(mirror)).toEqual(['Cr 6100 100.00', 'Dr 1190 100.00']);
  });

  it('an issued advance posts Dr staff advances (sub-ledger) / Cr funding', async () => {
    const [adv] = await worker.run((tx) => tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO salary_advances (id, "householdId", "staffId", amount, outstanding, "monthlyInstallment", "issuedAt")
      VALUES (gen_random_uuid(), ${H1}::uuid, ${cookStaffId}::uuid, 500, 500, 250, CURRENT_DATE) RETURNING id::text`);
    expect(sides((await entriesFor(adv!.id))[0]!)).toEqual(['Cr 1190 500.00', 'Dr 1310 500.00']);
    expect((await http().get(`/v1/ledger/staff/${cookStaffId}`).set(await as(USERS.head))).body.advancesOutstanding).toBe('500.00');
  });
});

describe('manual journals', () => {
  let accs: Record<string, { id: string }>;
  let manualId: string;
  beforeAll(async () => {
    const data = (await http().get('/v1/ledger/accounts').set(await as(USERS.head))).body.data;
    accs = Object.fromEntries(data.filter((a: { systemKey: string | null }) => a.systemKey).map((a: { systemKey: string }) => [a.systemKey, a]));
  });

  it('a balanced entry posts and gets a number', async () => {
    const r = await http().post('/v1/ledger/journal').set(await as(USERS.efa)).send({ entryDate: riyadhDate(0), description: 'Owner pays plumber in cash',
      lines: [{ accountId: accs.household_expenses!.id, debit: 150 }, { accountId: accs.owner_equity!.id, credit: 150 }] }).expect(201);
    expect(r.body).toMatchObject({ source: 'MANUAL', status: 'POSTED', totals: { debit: '150.00', credit: '150.00' }, number: expect.stringMatching(/^JE-\d{6}$/) });
    manualId = r.body.id;
  });

  it('unbalanced, header, foreign-household and staff postings are refused', async () => {
    const bad = await http().post('/v1/ledger/journal').set(await as(USERS.head)).send({ entryDate: riyadhDate(0), description: 'x',
      lines: [{ accountId: accs.household_expenses!.id, debit: 100 }, { accountId: accs.owner_equity!.id, credit: 90 }] }).expect(400);
    expect(bad.body.detail).toMatch(/does not balance: debits 100.00 ≠ credits 90.00/);
    await http().post('/v1/ledger/journal').set(await as(USERS.head)).send({ entryDate: riyadhDate(0), description: 'x',
      lines: [{ accountId: accs.assets!.id, debit: 1 }, { accountId: accs.owner_equity!.id, credit: 1 }] }).expect(422);
    const h2 = (await http().get('/v1/ledger/accounts').set(await as(USERS.head2, H2))).body.data.find((a: { systemKey: string }) => a.systemKey === 'owner_equity');
    await http().post('/v1/ledger/journal').set(await as(USERS.head)).send({ entryDate: riyadhDate(0), description: 'x',
      lines: [{ accountId: accs.household_expenses!.id, debit: 1 }, { accountId: h2.id, credit: 1 }] }).expect(422);
    await http().post('/v1/ledger/journal').set(await as(USERS.maid)).send({ entryDate: riyadhDate(0), description: 'x',
      lines: [{ accountId: accs.household_expenses!.id, debit: 1 }, { accountId: accs.owner_equity!.id, credit: 1 }] }).expect(403);
  });

  it('a posted entry can never be extended or edited (even with a balanced pair)', async () => {
    const db = app.get(PrismaService);
    const head = { userId: USERS.head, householdId: H1 };
    await expect(db.withRls(head, (tx) => tx.journalLine.createMany({ data: [
      { householdId: H1, entryId: manualId, ledgerAccountId: accs.household_expenses!.id, debit: 1 },
      { householdId: H1, entryId: manualId, ledgerAccountId: accs.owner_equity!.id, credit: 1 }] }))).rejects.toThrow(/already posted/);
    await expect(db.withRls(head, (tx) => tx.journalLine.updateMany({ where: { entryId: manualId }, data: { debit: 0 } }))).rejects.toThrow(/permission denied/);
  });

  it('reversal: mirror entry, original marked REVERSED, only once, managers only', async () => {
    await http().post(`/v1/ledger/journal/${manualId}/reverse`).set(await as(USERS.maid)).send({ reason: 'mistake' }).expect(403);
    const r = await http().post(`/v1/ledger/journal/${manualId}/reverse`).set(await as(USERS.head)).send({ reason: 'wrong account' }).expect(201);
    expect(r.body.original.status).toBe('REVERSED');
    expect(r.body.reversal).toMatchObject({ source: 'REVERSAL', reversalOfId: manualId, totals: { debit: '150.00', credit: '150.00' } });
    await http().post(`/v1/ledger/journal/${manualId}/reverse`).set(await as(USERS.head)).send({ reason: 'again' }).expect(422);
    await http().post(`/v1/ledger/journal/7f9c2ba4-e88f-4d3b-9b0e-6c1d2a3b4c5d/reverse`).set(await as(USERS.head)).send({ reason: 'nope' }).expect(404);
  });

  it('the trial balance balances', async () => {
    const r = await http().get('/v1/ledger/trial-balance').set(await as(USERS.head)).expect(200);
    expect(r.body.balanced).toBe(true);
    expect(r.body.totals.debit).toBe(r.body.totals.credit);
    expect(Number(r.body.totals.debit)).toBeGreaterThan(0);
  });

  it('account statement: running balance ends at the account balance', async () => {
    const acc = (await http().get('/v1/ledger/accounts').set(await as(USERS.head))).body.data.find((a: { code: string }) => a.code === floatCode);
    const st = await http().get(`/v1/ledger/accounts/${acc.id}/statement`).set(await as(USERS.head)).expect(200);
    expect(st.body.closing).toBe(acc.balance);
    expect(st.body.lines.length).toBeGreaterThanOrEqual(5);
  });
});

describe('period lock', () => {
  it('only Head / EFA close the books; forward only; nothing can be dated inside it', async () => {
    await http().post('/v1/ledger/close-books').set(await as(USERS.spouse)).send({ through: riyadhDate(-1) }).expect(403);
    await http().post('/v1/ledger/close-books').set(await as(USERS.head)).send({ through: riyadhDate(0) }).expect(422);
    expect((await http().post('/v1/ledger/close-books').set(await as(USERS.efa)).send({ through: riyadhDate(-1) }).expect(201)).body.booksClosedThrough).toBe(riyadhDate(-1));
    expect((await http().get('/v1/ledger/settings').set(await as(USERS.head))).body.booksClosedThrough).toBe(riyadhDate(-1));
    await http().post('/v1/ledger/close-books').set(await as(USERS.head)).send({ through: riyadhDate(-10) }).expect(422);
    const accs = (await http().get('/v1/ledger/accounts').set(await as(USERS.head))).body.data;
    const id = (k: string) => accs.find((a: { systemKey: string }) => a.systemKey === k).id;
    const r = await http().post('/v1/ledger/journal').set(await as(USERS.head)).send({ entryDate: riyadhDate(-1), description: 'backdated',
      lines: [{ accountId: id('household_expenses'), debit: 5 }, { accountId: id('owner_equity'), credit: 5 }] }).expect(422);
    expect(r.body.detail).toMatch(/books are closed through/);
  });
});
