import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import type { QrDetector } from './provider';

/**
 * Pure-JS QR detection (no native deps, runs in a Cloud Run worker).
 * Tries the full image, then the bottom half at 2× contrast, since ZATCA
 * QRs are printed at the foot of thermal receipts.
 */
export class JsQrDetector implements QrDetector {
  async detect(image: Uint8Array, mimeType: string): Promise<string[]> {
    const { data, width, height } = decode(image, mimeType);
    const hit = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' });
    if (hit?.data) return [hit.data];
    const start = Math.floor(height / 2) * width * 4;
    const bottom = new Uint8ClampedArray(data.subarray(start));
    for (let i = 0; i < bottom.length; i += 4) {
      for (let c = 0; c < 3; c++) bottom[i + c] = Math.max(0, Math.min(255, (bottom[i + c]! - 128) * 2 + 128));
    }
    const hit2 = jsQR(bottom, width, height - Math.floor(height / 2));
    return hit2?.data ? [hit2.data] : [];
  }
}

function decode(image: Uint8Array, mimeType: string): { data: Uint8ClampedArray; width: number; height: number } {
  const buf = Buffer.from(image);
  if (mimeType === 'image/png') {
    const png = PNG.sync.read(buf);
    return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
  }
  if (mimeType === 'image/jpeg') {
    const j = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 256 });
    return { data: new Uint8ClampedArray(j.data), width: j.width, height: j.height };
  }
  throw new Error(`unsupported image type ${mimeType}; convert HEIC/WebP to JPEG on the client`);
}
