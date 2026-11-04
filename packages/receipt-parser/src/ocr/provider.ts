/**
 * Provider-neutral OCR port. Adapters for Google Document AI, AWS Textract
 * or a vision LLM implement this; the pipeline never imports a vendor SDK.
 */
export interface OcrResult {
  text: string;
  /** Barcodes/QRs the provider itself detected (Document AI and Textract can). */
  qrPayloads?: string[];
  provider: string;
  /** Fields a model-based provider read directly (vision LLM); used where the text parser is unsure. */
  fields?: ReceiptFields;
  /** false when the provider judged the image not to be a receipt at all. */
  isReceipt?: boolean;
}

export interface ReceiptFields {
  merchantName?: string;
  vatNumber?: string;
  /** YYYY-MM-DD */
  date?: string;
  total?: string;
  vat?: string;
  currency?: string;
}

export interface OcrProvider {
  readonly name: string;
  recognize(image: Uint8Array, mimeType: string): Promise<OcrResult>;
}

/** Fallback QR detector run locally when the provider does not report barcodes. */
export interface QrDetector {
  detect(image: Uint8Array, mimeType: string): Promise<string[]>;
}
