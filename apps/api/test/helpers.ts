import { SignJWT } from 'jose';

export const H1 = 'b0000000-0000-0000-0000-000000000001';
export const H2 = 'b0000000-0000-0000-0000-000000000002';
export const USERS = {
  head: 'a0000000-0000-0000-0000-000000000001',
  efa: 'a0000000-0000-0000-0000-000000000002',
  maid: 'a0000000-0000-0000-0000-000000000003',
  spouse: 'a0000000-0000-0000-0000-000000000004',
  nanny: 'a0000000-0000-0000-0000-000000000005',
  head2: 'a0000000-0000-0000-0000-000000000009',
} as const;
export const MEMBERSHIPS = { maid: 'c0000000-0000-0000-0000-000000000003', spouse: 'c0000000-0000-0000-0000-000000000004',
  nanny: 'c0000000-0000-0000-0000-000000000005' } as const;

// Fixed so every test file unwraps the same tenant keys (test files run in isolated module graphs).
export const TEST_KEK = Buffer.alloc(32, 7).toString('base64');

/** Same environment for every test file (the DB is built once by global-setup). */
export function testEnv() {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgresql://herp_api:herp_api_dev@localhost:5432/herp_api_test';
  process.env.WORKER_DATABASE_URL = 'postgresql://herp_worker:herp_worker_dev@localhost:5432/herp_api_test';
  process.env.AUTH_JWT_SECRET = 'test-secret-test-secret-test-secret-0123';
  process.env.HERP_KMS = 'local';
  process.env.HERP_LOCAL_KEK ??= TEST_KEK;
}

export const token = (sub: string, secret = process.env.AUTH_JWT_SECRET!) =>
  new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(sub).setIssuedAt().setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));

export const as = async (sub: string, household: string = H1, lang = 'en') => ({
  Authorization: `Bearer ${await token(sub)}`, 'X-Household-Id': household, 'Accept-Language': lang,
});

/** YYYY-MM-DD, n days from today in Riyadh. */
export function riyadhDate(offsetDays: number): string {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
