import { z } from 'zod';
import { corsEntryError, parseCorsOrigins } from './cors';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  /** Public origin of the web app, e.g. https://app.darhub.net (links in notifications and e-mails). */
  PUBLIC_APP_URL: z.string().url().optional(),
  /** Public origin of this API, e.g. https://api.darhub.net (absolute URLs such as signed download links). */
  PUBLIC_API_URL: z.string().url().optional(),
  /** Browser origins allowed by CORS, comma-separated; exact or https://*.domain (see config/cors.ts). Unset = none. */
  CORS_ORIGINS: z.string().optional().transform(parseCorsOrigins),
  /** Reverse-proxy hops to trust for X-Forwarded-For / -Proto (0 = none; 1 behind one load balancer). */
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  /** Login role WITHOUT table privileges or BYPASSRLS; it only may SET ROLE to DB_REQUEST_ROLE. */
  DATABASE_URL: z.string().url(),
  /** Role every request runs as (app_user locally; "authenticated" on Supabase). */
  DB_REQUEST_ROLE: z.string().regex(/^[a-z_][a-z0-9_]*$/).default('app_user'),
  /** Either a JWKS endpoint (Supabase / Identity Platform) or an HS256 secret (dev, Supabase legacy). */
  AUTH_JWKS_URL: z.string().url().optional(),
  AUTH_JWT_SECRET: z.string().min(32).optional(),
  AUTH_ISSUER: z.string().optional(),
  AUTH_AUDIENCE: z.string().optional(),
  /** Field encryption KEK: "local" (dev/test, HERP_LOCAL_KEK) or "gcp" (Cloud KMS key HERP_KMS_KEY). */
  HERP_KMS: z.enum(['local', 'gcp']).default('local'),
  HERP_LOCAL_KEK: z.string().optional(),
  HERP_KMS_KEY: z.string().optional(),
  /** Local file storage root (dev / single node). Production swaps StorageService for a GCS adapter. */
  STORAGE_DIR: z.string().default('.storage'),
  /** HMAC key for short-lived download links (≥ 32 chars). Random per process when unset outside production. */
  FILE_SIGNING_SECRET: z.string().min(32).optional(),
  /** HMAC key for per-device offline fallback keys (≥ 32 chars). Random per process when unset outside production. */
  OFFLINE_KEY_SECRET: z.string().min(32).optional(),
  /** Onboarding: AES key for authenticator (TOTP) secrets, 32 bytes base64; random per process outside production. */
  AUTH_TOTP_KEY: z.string().optional(),
  /** HS256 key for device-session tokens issued after the daily Face ID / Touch ID unlock (≥ 32 chars). */
  SESSION_SIGNING_SECRET: z.string().min(32).optional(),
  /** Require a device-session token (daily biometric unlock) on every non-auth route. Default: on in production. */
  AUTH_REQUIRE_DEVICE_SESSION: z.enum(['true', 'false']).optional(),
  /** SMS / email gateway for one-time codes; unset = in-memory outbox (dev / tests only). */
  OTP_WEBHOOK_URL: z.string().url().optional(),
  OTP_WEBHOOK_TOKEN: z.string().optional(),
  /** Receipt OCR: 'claude' uses Claude vision (credentials from ANTHROPIC_API_KEY or the SDK's usual sources); 'none' stores receipts for manual entry. */
  OCR_PROVIDER: z.enum(['none', 'claude']).default('none'),
  OCR_MODEL: z.string().default('claude-opus-5-5'),
  /** Notification providers (worker). Unset ⇒ deliveries are built and stored, but stay QUEUED. */
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_TOKEN: z.string().optional(),
  FCM_PROJECT_ID: z.string().optional(),
  FCM_ACCESS_TOKEN: z.string().optional(),
  /** Worker only: login role that may SET ROLE app_service. */
  WORKER_DATABASE_URL: z.string().url().optional(),
}).superRefine((e, ctx) => {
  for (const o of e.CORS_ORIGINS) {
    const err = corsEntryError(o, e.NODE_ENV === 'production');
    if (err) ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: err });
  }
  for (const k of ['PUBLIC_APP_URL', 'PUBLIC_API_URL'] as const) {
    if (e.NODE_ENV === 'production' && e[k] && !e[k]!.startsWith('https://')) ctx.addIssue({ code: 'custom', path: [k], message: 'must use https in production' });
  }
}).refine((e) => e.AUTH_JWKS_URL || e.AUTH_JWT_SECRET, { message: 'set AUTH_JWKS_URL or AUTH_JWT_SECRET' })
  .refine((e) => e.NODE_ENV !== 'production' || e.AUTH_JWKS_URL, { message: 'production requires AUTH_JWKS_URL (asymmetric keys)' })
  .refine((e) => e.HERP_KMS !== 'local' || e.HERP_LOCAL_KEK, { message: 'HERP_KMS=local needs HERP_LOCAL_KEK (32 bytes, base64)' })
  .refine((e) => e.HERP_KMS !== 'gcp' || e.HERP_KMS_KEY, { message: 'HERP_KMS=gcp needs HERP_KMS_KEY' })
  .refine((e) => e.NODE_ENV !== 'production' || e.HERP_KMS === 'gcp', { message: 'production requires HERP_KMS=gcp' })
  .refine((e) => e.NODE_ENV !== 'production' || e.FILE_SIGNING_SECRET, { message: 'production requires FILE_SIGNING_SECRET' })
  .refine((e) => e.NODE_ENV !== 'production' || e.OFFLINE_KEY_SECRET, { message: 'production requires OFFLINE_KEY_SECRET' })
  .refine((e) => e.NODE_ENV !== 'production' || (e.AUTH_TOTP_KEY && e.SESSION_SIGNING_SECRET && e.OTP_WEBHOOK_URL),
    { message: 'production requires AUTH_TOTP_KEY, SESSION_SIGNING_SECRET and OTP_WEBHOOK_URL' });

export type Env = z.infer<typeof Env>;
export const ENV = Symbol('ENV');

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const r = Env.safeParse(source);
  if (!r.success) {
    throw new Error('Invalid environment:\n' + r.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n'));
  }
  return r.data;
}
