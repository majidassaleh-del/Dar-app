/**
 * Expo adapter for @herp/offline's KeyVault: the data key lives in the iOS
 * Keychain / Android Keystore behind Face ID, Touch ID or BiometricPrompt.
 *
 * NOT DEVICE-TESTED. apps/mobile is source-only (see pnpm-workspace.yaml), and
 * the unlock logic is covered in packages/offline/test with a fake vault.
 * Before shipping, verify on real hardware:
 *  - iOS: app.json → ios.infoPlist.NSFaceIDUsageDescription. With
 *    requireAuthentication the item is bound to the current biometric set
 *    (re-enrolment makes reads throw → VaultInvalidatedError → OTP fallback).
 *  - Android: BiometricPrompt (class 3) is needed; re-enrolment invalidates the key.
 *  - Cancel vs. failure error messages differ per OS/SDK; adjust isCancel() if needed.
 */
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import { b64u, VaultCancelledError, VaultInvalidatedError, type KeyVault } from '@herp/offline';

const isCancel = (e: unknown) => /cancel|user_cancel|ERR_AUTHENTICATION_CANCELED|authentication was canceled/i.test(String((e as Error)?.message ?? e));

export class SecureStoreVault implements KeyVault {
  constructor(private readonly slot: string) {}

  private opts(prompt?: string): SecureStore.SecureStoreOptions {
    return {
      requireAuthentication: true,
      authenticationPrompt: prompt,
      keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY, // never in iCloud / backups
      keychainService: `herp.offline.${this.slot}`,
    };
  }

  async isAvailable() {
    return (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync()) && SecureStore.canUseBiometricAuthentication();
  }

  async read(prompt: string) {
    try {
      const v = await SecureStore.getItemAsync('dek', this.opts(prompt));
      return v ? b64u.decode(v) : null;
    } catch (e) {
      if (isCancel(e)) throw new VaultCancelledError();
      throw new VaultInvalidatedError(e);
    }
  }

  async write(secret: Uint8Array) {
    await SecureStore.setItemAsync('dek', b64u.encode(secret), this.opts());
  }

  async remove() {
    await SecureStore.deleteItemAsync('dek', { keychainService: `herp.offline.${this.slot}` });
  }
}
