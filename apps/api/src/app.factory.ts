import './tenancy/request-context';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ENV, type Env } from './config/env';
import { CORS_ALLOWED_HEADERS, corsMatcher } from './config/cors';

/** Shared by main.ts and the e2e tests so both run the exact same app. */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn', 'log'] });
  // File uploads (PUT /v1/files/{id}/content) arrive as raw bytes.
  app.useBodyParser('raw', { type: 'application/octet-stream', limit: '16mb' });
  app.setGlobalPrefix('v1');
  app.enableShutdownHooks();
  const http = app.getHttpAdapter().getInstance();
  http.disable('x-powered-by');
  const env = app.get<Env>(ENV);
  // Behind a load balancer: real client IP / https from X-Forwarded-* (only the configured hops).
  http.set('trust proxy', env.TRUST_PROXY);
  // CORS: only the configured browser origins (e.g. https://*.darerp.net); none when unset.
  // No cookies are accepted cross-origin (credentials: false): browsers authenticate with a bearer token.
  if (env.CORS_ORIGINS.length) {
    const allowed = corsMatcher(env.CORS_ORIGINS);
    app.enableCors({
      origin: (origin, cb) => cb(null, !!origin && allowed(origin)),
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: CORS_ALLOWED_HEADERS, exposedHeaders: ['X-Request-Id'],
      credentials: false, maxAge: 600,
    });
  }
  return app;
}
