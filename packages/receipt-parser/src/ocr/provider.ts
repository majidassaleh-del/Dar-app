/**
 * Provider-neutral OCR port. Adapters for Google Document AI, AWS Textract
 * or a vision LLM implement this; the pipeline never imports a vendor SDK.
 */
export interface OcrResult {
  text: string;
  /** Barcodes/QRs the provider itself detected (Document AI and Textract can). */
  qrPayloads?: string[];
  provider: string;
}

export interface OcrProvider {
  readonly name: string;
  recognize(image: Uint8Array, mimeType: string): Promise<OcrResult>;
}

/** Fallback QR detector run locally when the provider does not report barcodes. */
export interface QrDetector {
  detect(image: Uint8Array, mimeType: string): Promise<string[]>;
}
