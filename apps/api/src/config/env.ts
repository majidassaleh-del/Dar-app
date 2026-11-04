import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  /** Login role WITHOUT table privileges or BYPASSRLS; it only may SET ROLE to DB_REQUEST_ROLE. */
  DATABASE_URL: z.string().url(),
  /** Role every request runs as (app_user locally; "authenticated" on Supabase). */
  DB_REQUEST_ROLE: z.string().regex(/^[a-z_][a-z0-9_]*$/).default('app_user'),
  /** Either a JWKS endpoint (Supabase / Identity Platform) or an HS256 secret (dev, Supabase legacy). */
  AUTH_JWKS_URL: z.string().url().optional(),
  AUTH_JWT_SECRET: z.string().min(32).optional(),
  AUTH_ISSUER: z.string().optional(),
  AUTH_AUDIENCE: z.string().optional(),
}).refine((e) => e.AUTH_JWKS_URL || e.AUTH_JWT_SECRET, { message: 'set AUTH_JWKS_URL or AUTH_JWT_SECRET' })
  .refine((e) => e.NODE_ENV !== 'production' || e.AUTH_JWKS_URL, { message: 'production requires AUTH_JWKS_URL (asymmetric keys)' });

export type Env = z.infer<typeof Env>;
export const ENV = Symbol('ENV');

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const r = Env.safeParse(source);
  if (!r.success) {
    throw new Error('Invalid environment:\n' + r.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n'));
  }
  return r.data;
}
