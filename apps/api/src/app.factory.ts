import './tenancy/request-context';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

/** Shared by main.ts and the e2e tests so both run the exact same app. */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn', 'log'] });
  // File uploads (PUT /v1/files/{id}/content) arrive as raw bytes.
  app.useBodyParser('raw', { type: 'application/octet-stream', limit: '16mb' });
  app.setGlobalPrefix('v1');
  app.enableShutdownHooks();
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  return app;
}
