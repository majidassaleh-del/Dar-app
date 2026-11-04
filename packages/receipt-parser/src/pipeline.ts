import { extractReceipt, type ExtractedReceipt } from './merge';
import type { OcrProvider, QrDetector } from './ocr/provider';

/**
 * receipt.uploaded → this → PENDING Transaction suggestion.
 * The OCR worker (app_service) calls it, writes Receipt.ocrRaw / extracted /
 * confidence / zatcaQr, and links or creates a PENDING transaction.
 */
export async function processReceiptImage(
  image: Uint8Array,
  mimeType: string,
  deps: { ocr: OcrProvider; qr?: QrDetector; reviewBelow?: number },
): Promise<ExtractedReceipt & { ocrProvider: string; qrPayload?: string; isReceipt: boolean }> {
  const [ocr, localQr] = await Promise.all([
    deps.ocr.recognize(image, mimeType),
    deps.qr ? deps.qr.detect(image, mimeType).catch(() => []) : Promise.resolve([] as string[]),
  ]);
  const qrPayloads = [...(ocr.qrPayloads ?? []), ...localQr];
  const result = extractReceipt({ ocrText: ocr.text, qrPayloads, fields: ocr.fields }, deps.reviewBelow);
  return { ...result, ocrProvider: ocr.provider, qrPayload: result.zatca ? qrPayloads[0] : undefined, isReceipt: ocr.isReceipt ?? true };
}
