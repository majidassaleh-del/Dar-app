/**
 * Worker / executive app: first-time device enrolment and the daily Face ID /
 * Touch ID unlock. NOT DEVICE-TESTED (apps/mobile is source-only); the flow is
 * covered by packages/offline/test/device-unlock.test.ts and the API e2e suite.
 *
 *  onboarding (once): SMS OTP → email OTP → authenticator (QR from /v1/auth/onboarding/totp)
 *  enrolDevice():     needs a fresh sign-in + an authenticator code
 *  dailyUnlock():     one biometric prompt → device-session token (until 04:00 Riyadh)
 *  'reenrol'          biometrics changed → sign in with SMS, POST /v1/auth/unlock/totp, enrol again
 */
import { DeviceUnlockClient, httpUnlockApi } from '@herp/offline';
import { SecureStoreVault } from '../offline/secure-store-vault';

export function deviceUnlock(cfg: { apiBaseUrl: string; deviceId: string; userId: string; idToken: () => Promise<string> }) {
  const client = new DeviceUnlockClient(new SecureStoreVault(`unlock.${cfg.userId}`), httpUnlockApi({ baseUrl: cfg.apiBaseUrl, idToken: cfg.idToken }), cfg.deviceId);
  return {
    async enrolDevice(totpCode: string, label: string) {
      const publicKeyJwk = await client.enrol();
      const r = await fetch(`${cfg.apiBaseUrl}/v1/auth/devices`, { method: 'POST',
        headers: { Authorization: `Bearer ${await cfg.idToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: cfg.deviceId, publicKeyJwk, label, totpCode }) });
      if (!r.ok) throw new Error(`device registration failed: HTTP ${r.status}`);
      return r.json();
    },
    dailyUnlock: (prompt: string) => client.unlock(prompt),
  };
}
