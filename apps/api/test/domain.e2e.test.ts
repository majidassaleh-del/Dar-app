import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app.factory';
import { loadEnv } from '../src/config/env';
import { corsMatcher, parseCorsOrigins } from '../src/config/cors';
import { H1, H2, USERS, as, testEnv } from './helpers';

/** SaaS domain readiness: CORS allow-list for darhub.net, proxy trust, tenant slugs on /v1/me. */
let app: INestApplication;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  testEnv();
  process.env.CORS_ORIGINS = 'https://darhub.net, https://app.darhub.net/, https://*.darhub.net';
  process.env.TRUST_PROXY = '1';
  app = await createApp(); await app.init();
});
afterAll(async () => {
  delete process.env.CORS_ORIGINS; delete process.env.TRUST_PROXY;
  await app?.close();
});

describe('CORS allow-list', () => {
  it('answers a preflight from a tenant subdomain with exactly the API headers', async () => {
    const r = await http().options('/v1/me').set('Origin', 'https://efa.darhub.net')
      .set('Access-Control-Request-Method', 'GET').set('Access-Control-Request-Headers', 'authorization,x-household-id');
    expect(r.status).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe('https://efa.darhub.net');
    expect(r.headers['access-control-allow-headers']).toContain('X-Household-Id');
    expect(r.headers['access-control-allow-credentials']).toBeUndefined();
    expect(r.headers.vary).toMatch(/Origin/i);
  });

  it('allows the apex and app origins on real requests', async () => {
    for (const o of ['https://darhub.net', 'https://app.darhub.net']) {
      const r = await http().get('/v1/me').set(await as(USERS.head)).set('Origin', o).expect(200);
      expect(r.headers['access-control-allow-origin']).toBe(o);
    }
  });

  it('sends no CORS grant to other origins (look-alikes, nested labels, plain http)', async () => {
    for (const o of ['https://evil.example', 'https://darhub.net.evil.example', 'https://evildarhub.net',
                     'https://a.b.darhub.net', 'http://efa.darhub.net', 'null']) {
      const r = await http().get('/v1/me').set(await as(USERS.head)).set('Origin', o);
      expect(r.headers['access-control-allow-origin'], o).toBeUndefined();
    }
  });
});

describe('tenant slugs', () => {
  it('/v1/me lists each of the caller\'s households with its subdomain slug, and only those', async () => {
    const me = (await http().get('/v1/me').set(await as(USERS.head)).expect(200)).body;
    expect(me.households.map((h: { householdId: string }) => h.householdId)).toEqual([H1]);
    expect(me.households[0].slug).toMatch(/^[a-z0-9-]+$/);
    const other = (await http().get('/v1/me').set(await as(USERS.head2, H2)).expect(200)).body;
    expect(other.households.map((h: { householdId: string }) => h.householdId)).toEqual([H2]);
  });
});

describe('environment validation', () => {
  const prod = {
    NODE_ENV: 'production', DATABASE_URL: 'postgresql://u@db/x', AUTH_JWKS_URL: 'https://auth.darhub.net/jwks.json',
    HERP_KMS: 'gcp', HERP_KMS_KEY: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
    FILE_SIGNING_SECRET: 'f'.repeat(32), OFFLINE_KEY_SECRET: 'o'.repeat(32), AUTH_TOTP_KEY: 'k', SESSION_SIGNING_SECRET: 's'.repeat(32),
    OTP_WEBHOOK_URL: 'https://otp.darhub.net/send',
  };

  it('accepts a darhub.net production configuration', () => {
    const env = loadEnv({ ...prod, CORS_ORIGINS: 'https://darhub.net,https://*.darhub.net', PUBLIC_APP_URL: 'https://app.darhub.net',
                          PUBLIC_API_URL: 'https://api.darhub.net', TRUST_PROXY: '1' });
    expect(env.CORS_ORIGINS).toEqual(['https://darhub.net', 'https://*.darhub.net']);
    expect(env.TRUST_PROXY).toBe(1);
  });

  it.each([
    ['*', /not an origin/],
    ['https://*', /not an origin/],
    ['https://*.net', /registrable domain/],
    ['https://*.localhost', /registrable domain/],
    ['http://app.darhub.net', /https in production/],
    ['https://app.darhub.net/path', /not an origin/],
  ])('refuses CORS_ORIGINS=%s in production', (spec, msg) => {
    expect(() => loadEnv({ ...prod, CORS_ORIGINS: spec })).toThrow(msg);
  });

  it('refuses non-https public URLs in production, allows http://localhost in development', () => {
    expect(() => loadEnv({ ...prod, PUBLIC_APP_URL: 'http://app.darhub.net' })).toThrow(/PUBLIC_APP_URL: must use https/);
    expect(loadEnv({ DATABASE_URL: 'postgresql://u@db/x', AUTH_JWT_SECRET: 'x'.repeat(32), HERP_LOCAL_KEK: 'k',
                     CORS_ORIGINS: 'http://localhost:3000,http://*.localhost:3000' }).CORS_ORIGINS).toHaveLength(2);
  });

  it('wildcards match exactly one DNS label', () => {
    const m = corsMatcher(parseCorsOrigins('https://*.darhub.net,http://*.localhost:3000'));
    expect(m('https://efa.darhub.net')).toBe(true);
    expect(m('https://EFA.darhub.net')).toBe(true);
    expect(m('https://darhub.net')).toBe(false);
    expect(m('https://x.efa.darhub.net')).toBe(false);
    expect(m('https://-bad.darhub.net')).toBe(false);
    expect(m('http://afa.localhost:3000')).toBe(true);
    expect(m('http://afa.localhost:3001')).toBe(false);
  });
});
