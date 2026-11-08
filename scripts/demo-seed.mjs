#!/usr/bin/env node
// Demo data through the real API (so identity numbers and IBANs are validated and encrypted
// exactly as in production). Local development only.
//   scripts/dev-db.sh herp_dev --fixtures && psql … < scripts/demo-households.sql
//   (API running on HERP_API_URL with AUTH_JWT_SECRET) node scripts/demo-seed.mjs
// Prints a dev token for the EFA office (member of both households) for HERP_DEV_TOKEN.
import { createHmac } from 'node:crypto';

const API = process.env.HERP_API_URL ?? 'http://localhost:4000';
const SECRET = process.env.AUTH_JWT_SECRET ?? 'dev-secret-dev-secret-dev-secret-0123';
const H1 = 'b0000000-0000-0000-0000-000000000001', H2 = 'b0000000-0000-0000-0000-000000000002';
const U = { head: 'a0000000-0000-0000-0000-000000000001', efa: 'a0000000-0000-0000-0000-000000000002', driver: 'a0000000-0000-0000-0000-000000000008', head2: 'a0000000-0000-0000-0000-000000000009' };
const M = { maid: 'c0000000-0000-0000-0000-000000000003', nanny: 'c0000000-0000-0000-0000-000000000005', cook: 'c0000000-0000-0000-0000-000000000006',
            gardener: 'c0000000-0000-0000-0000-000000000007', driver: 'c0000000-0000-0000-0000-000000000008' };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export function token(sub, hours = 12) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, iat: now, exp: now + hours * 3600 })}`;
  return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`;
}
async function call(user, household, method, path, body) {
  const r = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${token(user, 1)}`, 'X-Household-Id': household, 'Content-Type': 'application/json', 'Accept-Language': 'en' },
    body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
  return j;
}
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// Valid-format numbers (check digits computed, not real people).
function iqama(seed) {
  const base = `2${String(seed).padStart(8, '0')}`;
  let sum = 0;
  for (let i = 0; i < 9; i++) { const d = Number(base[i]); if (i % 2 === 0) { const x = d * 2; sum += Math.floor(x / 10) + (x % 10); } else sum += d; }
  return base + ((10 - (sum % 10)) % 10);
}
function saIban(bank, account) {
  const bban = `${bank}${account.padStart(18, '0')}`;
  const num = `${bban}SA00`.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let mod = 0; for (const ch of num) mod = (mod * 10 + Number(ch)) % 97;
  return `SA${String(98 - mod).padStart(2, '0')}${bban}`;
}

async function staff(user, hh, s) {
  const p = await call(user, hh, 'POST', '/v1/staff', { staffType: s.type, fullName: s.name, nationality: s.nat, hireDate: s.hire, membershipId: s.membership,
    ...(s.iban ? { defaultPayoutChannel: 'BANK_TRANSFER', payoutIban: s.iban } : { defaultPayoutChannel: 'CASH' }) });
  await call(user, hh, 'POST', `/v1/staff/${p.id}/contracts`, { startDate: s.hire, basicSalary: s.basic, allowances: [{ code: 'FOOD', amount: s.food }] });
  if (s.doc) await call(user, hh, 'POST', `/v1/staff/${p.id}/documents`, { type: s.doc.type, number: s.doc.number, expiryDate: s.doc.expiry, issuingCountry: s.doc.country });
  if (s.fit) {
    await call(user, hh, 'POST', `/v1/staff/${p.id}/medical-checkups`, { checkupDate: day(-20), result: 'FIT' });
    await call(user, hh, 'POST', `/v1/staff/${p.id}/status`, { status: 'ACTIVE' });
    if (s.leave) await call(user, hh, 'POST', `/v1/staff/${p.id}/status`, { status: 'ON_LEAVE' });
  }
  return p.id;
}

const efaStaff = [
  { type: 'DRIVER', name: { en: 'Rahim Uddin', ar: 'رحيم الدين' }, nat: 'BD', hire: '2021-03-01', membership: M.driver, basic: 2000, food: 300, iban: saIban('80', '608010167519'), doc: { type: 'IQAMA', number: iqama(1748201), expiry: day(210), country: 'SA' }, fit: true },
  { type: 'HOUSEMAID', name: { en: 'Maria Santos', ar: 'ماريا سانتوس' }, nat: 'PH', hire: '2022-06-15', membership: M.maid, basic: 1500, food: 200, doc: { type: 'IQAMA', number: iqama(2290117), expiry: day(330), country: 'SA' }, fit: true },
  { type: 'COOK', name: { en: 'Sunita Rao', ar: 'سونيتا راو' }, nat: 'IN', hire: '2020-01-10', membership: M.cook, basic: 1900, food: 200, iban: saIban('10', '000014200056'), doc: { type: 'PASSPORT', number: 'Z5871133', expiry: day(600), country: 'IN' }, fit: true, leave: true },
  { type: 'NANNY', name: { en: 'Tigist Bekele', ar: 'تيغيست بيكيلي' }, nat: 'ET', hire: '2024-09-01', membership: M.nanny, basic: 1800, food: 200, doc: { type: 'IQAMA', number: iqama(3105562), expiry: day(20), country: 'SA' }, fit: true },
  { type: 'GARDENER', name: { en: 'Samir Hassan', ar: 'سمير حسن' }, nat: 'EG', hire: day(-45), membership: M.gardener, basic: 1600, food: 150 },
];
const extrasOnly = process.argv.includes('--extras-only');
if (!extrasOnly) for (const s of efaStaff) await staff(U.head, H1, s);

if (!extrasOnly) {
const yukon = await call(U.head, H1, 'POST', '/v1/vehicles', { make: 'GMC', model: 'Yukon Denali', year: 2024, plateNumber: 'ABC 1234', plateNumberAr: 'أ ب ح ١٢٣٤', odometerKm: 38410,
  registrationNumber: 'IST-778812', registrationExpiry: day(212), insuranceProvider: 'Tawuniya', insurancePolicy: 'P-55102', insuranceExpiry: day(24), inspectionExpiry: day(140), tankCapacityL: 98, expectedKmPerL: 6 });
const camry = await call(U.head, H1, 'POST', '/v1/vehicles', { make: 'Toyota', model: 'Camry', year: 2023, plateNumber: 'XYZ 5678', plateNumberAr: 'ص ي ز ٥٦٧٨', odometerKm: 61200,
  registrationNumber: 'IST-660431', registrationExpiry: day(301), insuranceProvider: 'Bupa Arabia', insurancePolicy: 'P-77810', insuranceExpiry: day(188), inspectionExpiry: day(77), tankCapacityL: 60, expectedKmPerL: 13 });
await call(U.head, H1, 'POST', `/v1/vehicles/${yukon.id}/assignments`, { driverId: M.driver });
await call(U.head, H1, 'POST', `/v1/vehicles/${camry.id}/assignments`, { driverId: M.driver, isPrimary: false });
await call(U.head, H1, 'POST', `/v1/vehicles/${yukon.id}/maintenance-plans`, { type: 'OIL_CHANGE', intervalKm: 5000, intervalDays: 180, lastDoneKm: 33900, lastDoneAt: day(-120) });
await call(U.head, H1, 'POST', `/v1/vehicles/${camry.id}/maintenance-plans`, { type: 'TIRES', intervalKm: 10000, lastDoneKm: 55500, lastDoneAt: day(-200) });
const adv = await call(U.driver, H1, 'POST', '/v1/requests', { type: 'SALARY_ADVANCE', amount: 600, installments: 3, reason: 'Family' });
await call(U.efa, H1, 'POST', `/v1/requests/${adv.id}/approve`, {});

// AFA Household (H2), created by its own Head.
await call(U.head2, H2, 'POST', '/v1/staff', { staffType: 'COOK', fullName: { en: 'Grace Mwangi', ar: 'غريس موانغي' }, nationality: 'KE', hireDate: '2023-02-01', defaultPayoutChannel: 'CASH' })
  .then((p) => call(U.head2, H2, 'POST', `/v1/staff/${p.id}/contracts`, { startDate: '2023-02-01', basicSalary: 1700, allowances: [{ code: 'FOOD', amount: 200 }] }));
await call(U.head2, H2, 'POST', '/v1/vehicles', { make: 'Lexus', model: 'LX 600', year: 2025, plateNumber: 'RST 9001', plateNumberAr: 'ر س ط ٩٠٠١', odometerKm: 8200,
  registrationExpiry: day(320), insuranceExpiry: day(41), inspectionExpiry: day(290) });
}

// Every section of the web app gets something to show: bank account and transactions,
// a petty-cash float, work orders, open requests and two of October's salaries.
// `node scripts/demo-seed.mjs --extras-only` adds just this part to an already seeded database.
const U3 = { maid: 'a0000000-0000-0000-0000-000000000003', nanny: 'a0000000-0000-0000-0000-000000000005' };
const efa = (await call(U.head, H1, 'GET', '/v1/staff')).data;
const byName = (en) => efa.find((x) => x.fullName?.en === en)?.id;
const cats = (await call(U.head, H1, 'GET', '/v1/categories')).data ?? [];
const cat = async (kind, name) => cats.find((c) => c.kind === kind && Object.values(c.name ?? {}).concat(c.name).includes(name))?.id
  ?? (await call(U.head, H1, 'POST', '/v1/categories', { kind, name })).id;
const groceries = await cat('EXPENSE', 'بقالة');
const utilities = await cat('EXPENSE', 'كهرباء وماء');
const fuel = await cat('EXPENSE', 'وقود');
const existingBank = (await call(U.head, H1, 'GET', '/v1/accounts')).data.find((a) => a.name === 'Al Rajhi current');
const bank = existingBank ?? await call(U.head, H1, 'POST', '/v1/accounts', { type: 'BANK_CURRENT', name: 'Al Rajhi current', institution: 'Al Rajhi Bank',
  iban: saIban('80', '608010004418'), openingBalance: 25000 });
const tx = (b) => call(U.head, H1, 'POST', '/v1/transactions', { accountId: bank.id, ...b });
if (!existingBank) {
await tx({ type: 'EXPENSE', amount: 412.5, categoryId: groceries, merchantName: 'Danube', occurredAt: `${day(-6)}T10:00:00Z` });
await tx({ type: 'EXPENSE', amount: 640, categoryId: utilities, merchantName: 'Saudi Electricity Co.', occurredAt: `${day(-4)}T10:00:00Z` });
await tx({ type: 'EXPENSE', amount: 180, categoryId: fuel, merchantName: 'Aldrees', occurredAt: `${day(-2)}T10:00:00Z` });
await tx({ type: 'EXPENSE', amount: 96.75, categoryId: groceries, merchantName: 'Tamimi Markets', occurredAt: `${day(-1)}T10:00:00Z` });
}
const existingFloat = (await call(U.head, H1, 'GET', '/v1/petty-cash')).data.find((f) => f.name === 'Household float');
if (!existingFloat) {
const float = await call(U.head, H1, 'POST', '/v1/petty-cash', { custodianId: M.maid, name: 'Household float', floatLimit: 1000, receiptRequiredOver: 100 });
await call(U.head, H1, 'POST', `/v1/petty-cash/${float.id}/top-ups`, { amount: 800 });
const veg = await call(U3.maid, H1, 'POST', `/v1/petty-cash/${float.id}/expenses`, { amount: 60, description: 'خضار', categoryId: groceries });
await call(U.head, H1, 'POST', `/v1/petty-cash/logs/${veg.entry.id}/review`, { decision: 'APPROVED' });
await call(U3.maid, H1, 'POST', `/v1/petty-cash/${float.id}/expenses`, { amount: 35, description: 'خبز وحليب', categoryId: groceries });
await call(U3.maid, H1, 'POST', `/v1/petty-cash/${float.id}/expenses`, { amount: 85, description: 'مواد تنظيف' });
}
if (!(await call(U.head, H1, 'GET', '/v1/work-orders')).data.length) {
await call(U.head, H1, 'POST', '/v1/work-orders', { title: 'تنظيف المجلس قبل زيارة الخميس', category: 'CLEANING', priority: 'HIGH',
  assigneeId: M.maid, dueAt: `${day(4)}T09:00:00Z`, instructions: [{ text: 'تلميع الطاولات الخشبية' }, { text: 'غسل السجاد الصغير', requiresPhoto: true }] }).catch((e) => console.warn(e.message));
await call(U.head, H1, 'POST', '/v1/work-orders', { title: 'تقليم أسوار الحديقة', category: 'GARDENING', assigneeId: M.gardener, dueAt: `${day(6)}T09:00:00Z`,
  instructions: [{ text: 'الأسوار الأمامية فقط' }] }).catch((e) => console.warn(e.message));
await call(U.head, H1, 'POST', '/v1/work-orders', { title: 'غسيل اليوكن', category: 'DRIVING', assigneeId: M.driver, dueAt: `${day(1)}T09:00:00Z`,
  instructions: [{ text: 'من الداخل والخارج' }] }).catch((e) => console.warn(e.message));
}
if (!(await call(U.head, H1, 'GET', '/v1/requests')).data.some((r) => r.type === 'LEAVE')) {
await call(U3.nanny, H1, 'POST', '/v1/requests', { type: 'LEAVE', leaveType: 'ANNUAL', startDate: day(42), endDate: day(46) }).catch((e) => console.warn(e.message));
await call(U3.maid, H1, 'POST', '/v1/requests', { type: 'SALARY_ADVANCE', amount: 500, installments: 2, reason: 'School fees' }).catch((e) => console.warn(e.message));
}
const lastMonth = new Date(); lastMonth.setUTCDate(1); lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
for (const en of ['Rahim Uddin', 'Maria Santos']) {
  const id = byName(en);
  if (id) await call(U.head, H1, 'POST', `/v1/staff/${id}/salary-payments`, { periodYear: lastMonth.getUTCFullYear(), periodMonth: lastMonth.getUTCMonth() + 1,
    ...(en === 'Rahim Uddin' ? { channel: 'BANK_TRANSFER', externalRef: 'ARB-SAL-2026-10-0417' } : { channel: 'CASH' }) }).catch((e) => console.warn(e.message));
}

console.log(`seeded. HERP_DEV_TOKEN for the EFA office (both households):\n${token(U.efa, 12)}`);
