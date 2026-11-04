import { Inject, Injectable } from '@nestjs/common';
import { ClaudeVisionOcr, JsQrDetector, processReceiptImage, type OcrProvider } from '@herp/receipt-parser';
import { ENV, type Env } from '../config/env';

/** Holds the configured OCR provider (swappable in tests via useProvider). */
@Injectable()
export class OcrService {
  private provider: OcrProvider | null;
  private readonly qr = new JsQrDetector();

  constructor(@Inject(ENV) env: Env) {
    this.provider = env.OCR_PROVIDER === 'claude' ? new ClaudeVisionOcr({ model: env.OCR_MODEL }) : null;
  }

  get configured() { return this.provider !== null; }
  useProvider(p: OcrProvider | null) { this.provider = p; }

  run(bytes: Uint8Array, mimeType: string) {
    if (!this.provider) throw new Error('no OCR provider configured');
    return processReceiptImage(bytes, mimeType, { ocr: this.provider, qr: this.qr });
  }
}
