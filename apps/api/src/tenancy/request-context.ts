import type { Locale } from '@herp/i18n';

/** Everything a handler may know about the caller. Built by the guards, read with @Ctx(). */
export interface RequestContext {
  userId: string;
  householdId?: string;
  membershipId?: string;
  locale: Locale;
  requestId: string;
  /** When the user last actually authenticated (JWT auth_time, else iat), epoch seconds. */
  authTime?: number;
  /** Present when the caller used a device-session token (daily biometric unlock). */
  session?: { deviceKeyId: string; amr: string[] };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { ctx?: RequestContext }
  }
}
