import { Global, Module } from '@nestjs/common';
import { ENV, loadEnv } from './env';

/** Validated environment, injectable anywhere as @Inject(ENV). Fails fast at boot on bad config. */
@Global()
@Module({ providers: [{ provide: ENV, useFactory: () => loadEnv() }], exports: [ENV] })
export class ConfigModule {}
