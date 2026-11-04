import { Inject, Injectable } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ENV, type Env } from '../config/env';

export interface DownloadClaims { a: string; h: string; u: string; e: number }

/**
 * Blob storage port + signed download tokens. This implementation writes to
 * local disk (dev, tests, single node); production swaps in a GCS/S3 adapter
 * with the same interface. Keys are "<householdId>/<attachmentId>" and are
 * resolved under STORAGE_DIR only (no path traversal).
 */
@Injectable()
export class StorageService {
  private readonly root: string;
  private readonly secret: Buffer;

  constructor(@Inject(ENV) env: Env) {
    this.root = resolve(env.STORAGE_DIR);
    this.secret = env.FILE_SIGNING_SECRET ? Buffer.from(env.FILE_SIGNING_SECRET) : randomBytes(32);
  }

  private path(key: string) {
    if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(key)) throw new Error('invalid storage key');
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + '/')) throw new Error('invalid storage key');
    return p;
  }

  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data, { flag: 'wx' }); // never overwrite: an uploaded file is immutable
  }

  get(key: string) { return readFile(this.path(key)); }

  /** Token = base64url(claims).base64url(HMAC). Claims carry the requester, so the download re-checks RLS. */
  sign(claims: DownloadClaims): string {
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${body}.${createHmac('sha256', this.secret).update(body).digest('base64url')}`;
  }

  verify(token: string, now = Date.now()): DownloadClaims | null {
    const [body, mac] = token.split('.');
    if (!body || !mac) return null;
    const want = createHmac('sha256', this.secret).update(body).digest();
    const got = Buffer.from(mac, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    try {
      const c = JSON.parse(Buffer.from(body, 'base64url').toString()) as DownloadClaims;
      return typeof c.e === 'number' && c.e * 1000 > now ? c : null;
    } catch { return null; }
  }
}
