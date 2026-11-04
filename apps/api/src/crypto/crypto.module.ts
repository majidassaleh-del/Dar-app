import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { FieldCipher, TenantKeyring, type KmsProvider, type TenantKeyRecord } from '@herp/crypto';
import { ENV, type Env } from '../config/env';
import { currentTx } from '../db/prisma.service';
import { createKms } from './kms';

export const KMS = Symbol('KMS');

/**
 * FieldCipher for the API. Wrapped keys are read through the request's own
 * RLS transaction (tenant_keys is SELECT-only for app_user, own tenant only),
 * so encryption cannot be used outside withRls() and never reads another
 * household's keys. Unwrapped keys are cached by TenantKeyring (5 min).
 */
@Injectable()
export class CryptoService {
  readonly cipher: FieldCipher;

  constructor(@Inject(KMS) kms: KmsProvider) {
    const keyring = new TenantKeyring(kms, async (householdId): Promise<TenantKeyRecord[]> => {
      const tx = currentTx.getStore();
      if (!tx) throw new Error('field encryption used outside db.withRls()');
      const rows = await tx.tenantKey.findMany({ where: { householdId } });
      if (!rows.length) throw new Error(`household ${householdId} has no tenant key; run the key provisioner`);
      return rows.map((r) => ({ ...r, wrappedDek: Buffer.from(r.wrappedDek), wrappedIndexKey: Buffer.from(r.wrappedIndexKey) }));
    });
    this.cipher = new FieldCipher(keyring);
  }
}

@Global()
@Module({
  providers: [{ provide: KMS, inject: [ENV], useFactory: (env: Env) => createKms(env) }, CryptoService],
  exports: [CryptoService, KMS],
})
export class CryptoModule {}
