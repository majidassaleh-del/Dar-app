import { GcpKmsProvider, LocalKmsProvider, type GcpKmsClientLike, type KmsProvider } from '@herp/crypto';
import type { Env } from '../config/env';

/** Picks the KEK provider from the environment. Cloud KMS SDK is loaded only when used. */
export async function createKms(env: Env): Promise<KmsProvider> {
  if (env.HERP_KMS === 'local') return new LocalKmsProvider(env.HERP_LOCAL_KEK, env.NODE_ENV);
  const sdk = '@google-cloud/kms'; // optional dependency, resolved at runtime only in production
  const { KeyManagementServiceClient } = (await import(/* @vite-ignore */ sdk)) as { KeyManagementServiceClient: new () => GcpKmsClientLike };
  return new GcpKmsProvider(new KeyManagementServiceClient(), env.HERP_KMS_KEY!);
}
