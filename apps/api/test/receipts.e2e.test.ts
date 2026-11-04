import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { OcrProvider, ReceiptFields } from '@herp/receipt-parser';
import { createApp } from '../src/app.factory';
import { OcrService } from '../src/receipts/ocr.service';
import { H2, MEMBERSHIPS, USERS, as, riyadhDate, testEnv } from './helpers';

let app: INestApplication;
let ocr: OcrService;
let floatId = '';
const http = () => request(app.getHttpServer());

/** A fake vision provider: returns whatever the test sets next. */
class FakeOcr implements OcrProvider {
  readonly name = 'fake-vision';
  next: { text: string; fields?: ReceiptFields; isReceipt?: boolean } | Error = { text: '' };
  calls = 0;
  async recognize() { this.calls++; if (this.next instanceof Error) throw this.next; return { ...this.next, provider: this.name }; }
}
const fake = new FakeOcr();
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(64)]);
const scan = async (bytes: Buffer, query: Record<string, string>, user: string = USERS.nanny, status = 201) =>
  (await http().post('/v1/receipts').query({ mimeType: 'image/jpeg', ...query }).set(await as(user))
    .set('Content-Type', 'application/octet-stream').send(bytes).expect(status)).body;

beforeAll(async () => {
  testEnv();
  app = await createApp(); await app.init();
  ocr = app.get(OcrService);
  ocr.useProvider(fake);
  floatId = (await http().post('/v1/petty-cash').set(await as(USERS.head)).send({ custodianId: MEMBERSHIPS.nanny, name: 'Nursery float',
    floatLimit: 800, receiptRequiredOver: 50 }).expect(201)).body.id;
  await http().post(`/v1/petty-cash/${floatId}/top-ups`).set(await as(USERS.head)).send({ amount: 500 }).expect(201);
});
afterAll(async () => { await app?.close(); });

describe('scan → auto-filled petty-cash expense', () => {
  let receiptId = '';
  const bytes = jpeg();

  it('a clear receipt fills the expense: merchant, total, VAT, date; it waits for review like any custodian entry', async () => {
    fake.next = { text: 'صيدلية النهدي\nالإجمالي شامل الضريبة 69.00\nضريبة القيمة المضافة 9.00', fields: { merchantName: 'Nahdi Pharmacy',
      total: '69.00', vat: '9.00', date: riyadhDate(-1), vatNumber: '300000000000003' } };
    const r = await scan(bytes, { pettyCashAccountId: floatId });
    receiptId = r.receipt.id;
    expect(r.receipt).toMatchObject({ status: 'EXTRACTED', ocrProvider: 'fake-vision', extracted: { total: '69.00', vat: '9.00', date: riyadhDate(-1) } });
    expect(r.autoFilled).toBe(true);
    expect(r.expense).toMatchObject({ accountId: floatId, status: 'PENDING_REVIEW', amount: '69.00', needsReview: false });
    expect(r.expense.merchantName).toMatch(/Nahdi|النهدي/);
    expect(r.expense.occurredAt.slice(0, 10)).toBe(riyadhDate(-1));
    const logs = (await http().get(`/v1/petty-cash/${floatId}/logs`).set(await as(USERS.head))).body.data;
    expect(logs.find((l: { id: string }) => l.id === r.expense.id)).toMatchObject({ receiptId, type: 'EXPENSE' });
  });

  it('the same receipt cannot be scanned (or claimed) twice', async () => {
    await scan(bytes, { pettyCashAccountId: floatId }, USERS.nanny, 409);
    await http().post(`/v1/receipts/${receiptId}/expense`).set(await as(USERS.nanny)).send({ accountId: floatId }).expect(409);
  });

  it('the file must really be an image/PDF of the declared type', async () => {
    await scan(Buffer.from('%PDF-1.7 not a jpeg'), {}, USERS.nanny, 400);
    await http().post('/v1/receipts').query({ mimeType: 'image/gif' }).set(await as(USERS.nanny)).set('Content-Type', 'application/octet-stream').send(jpeg()).expect(400);
  });

  it('parser and vision disagree on the total → expense still filled, flagged for review with the reason', async () => {
    fake.next = { text: 'Total incl VAT 115.00', fields: { merchantName: 'Danube', total: '151.00', date: riyadhDate(0) } };
    const r = await scan(jpeg(), { pettyCashAccountId: floatId });
    expect(r.expense).toMatchObject({ amount: '151.00', needsReview: true });
    expect(r.expense.warnings.join()).toMatch(/vision read 151.00/);
  });

  it('unreadable total → no expense; the worker completes it from the receipt', async () => {
    fake.next = { text: 'smudged', fields: { merchantName: 'Tamimi' } };
    const r = await scan(jpeg(), { pettyCashAccountId: floatId });
    expect(r).toMatchObject({ autoFilled: false, expense: null, receipt: { status: 'EXTRACTED' } });
    await http().post(`/v1/receipts/${r.receipt.id}/expense`).set(await as(USERS.nanny)).send({ accountId: floatId }).expect(422);
    const e = await http().post(`/v1/receipts/${r.receipt.id}/expense`).set(await as(USERS.nanny)).send({ accountId: floatId, amount: 23.5 }).expect(201);
    expect(e.body.expense).toMatchObject({ amount: '23.50', merchantName: 'Tamimi' });
  });

  it('not a receipt → nothing filled', async () => {
    fake.next = { text: 'a cat', isReceipt: false, fields: { total: '12.00' } };
    const r = await scan(jpeg(), { pettyCashAccountId: floatId });
    expect(r.autoFilled).toBe(false);
    expect(r.receipt.warnings.join()).toMatch(/does not look like a receipt/);
  });

  it('implausible dates fall back to today with a warning', async () => {
    fake.next = { text: '', fields: { merchantName: 'Jarir', total: '40.00', date: '2019-01-01' } };
    const r = await scan(jpeg(), { pettyCashAccountId: floatId });
    expect(r.expense.occurredAt.slice(0, 10)).toBe(riyadhDate(0));
    expect(r.expense.warnings.join()).toMatch(/implausible/);
  });
});

describe('OCR outage / not configured', () => {
  it('the receipt is kept; processing can be retried later', async () => {
    fake.next = new Error('upstream 529');
    const r = await scan(jpeg(), { pettyCashAccountId: floatId });
    expect(r).toMatchObject({ autoFilled: false, receipt: { status: 'UPLOADED', ocrError: 'OCR failed: upstream 529' } });
    ocr.useProvider(null);
    const off = await scan(jpeg(), {});
    expect(off.receipt.ocrError).toMatch(/not configured/);
    ocr.useProvider(fake);
    fake.next = { text: '', fields: { merchantName: 'Lulu', total: '18.00', date: riyadhDate(0) } };
    const again = await http().post(`/v1/receipts/${r.receipt.id}/process`).set(await as(USERS.nanny)).expect(201);
    expect(again.body.receipt).toMatchObject({ status: 'EXTRACTED', extracted: { total: '18.00' } });
    await http().post(`/v1/receipts/${r.receipt.id}/process`).set(await as(USERS.nanny)).expect(409);
  });
});

describe('isolation', () => {
  it('other members and households cannot see, process or claim a receipt', async () => {
    fake.next = { text: '', fields: { merchantName: 'Bindawood', total: '30.00', date: riyadhDate(0) } };
    const r = await scan(jpeg(), {});
    await http().get(`/v1/receipts/${r.receipt.id}`).set(await as(USERS.maid)).expect(404);
    await http().get(`/v1/receipts/${r.receipt.id}`).set(await as(USERS.head2, H2)).expect(404);
    await http().post(`/v1/receipts/${r.receipt.id}/expense`).set(await as(USERS.maid)).send({ accountId: floatId, amount: 30 }).expect(404);
    expect((await http().get(`/v1/receipts/${r.receipt.id}`).set(await as(USERS.efa)).expect(200)).body.extracted.total).toBe('30.00');
  });

  it('a petty-cash entry cannot cite someone else’s receipt (DB rule)', async () => {
    fake.next = { text: '', fields: { total: '75.00' } };
    const theirs = await scan(jpeg(), {}, USERS.maid);
    await http().post(`/v1/petty-cash/${floatId}/expenses`).set(await as(USERS.nanny)).send({ amount: 75, description: 'x', receiptId: theirs.receipt.id }).expect(403);
  });
});
