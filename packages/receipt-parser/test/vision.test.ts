import { describe, expect, it } from 'vitest';
import { ClaudeVisionOcr, extractReceipt, processReceiptImage } from '../src';

/** Records the request and answers like the Messages API with a JSON text block. */
function fakeClient(answer: object, stop_reason = 'end_turn') {
  const calls: any[] = [];
  const client = { beta: { messages: { create: async (req: any) => { calls.push(req); return {
    model: req.model, stop_reason, content: [{ type: 'text', text: JSON.stringify(answer) }] }; } } } };
  return { calls, client: client as any };
}
const ANSWER = { transcript: 'محطة ساسكو\nالرقم الضريبي 300000000000003\nالإجمالي شامل الضريبة 115.00', merchantName: 'SASCO', vatNumber: '300000000000003',
  date: '2026-11-03', total: '115.00', vat: '15.00', currency: 'SAR', isReceipt: true };

describe('ClaudeVisionOcr', () => {
  it('sends an image block with structured-output schema and server-side fallback', async () => {
    const f = fakeClient(ANSWER);
    const r = await new ClaudeVisionOcr({ client: f.client }).recognize(new Uint8Array([1, 2, 3]), 'image/jpeg');
    const req = f.calls[0];
    expect(req).toMatchObject({ model: 'claude-opus-5-5', betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      output_config: { format: { type: 'json_schema' } } });
    expect(req.messages[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AQID' } });
    expect(req.thinking).toBeUndefined(); // thinking cannot be disabled on this model; effort controls depth
    expect(r).toMatchObject({ provider: 'claude-vision:claude-opus-5-5', isReceipt: true, fields: { total: '115.00', vatNumber: '300000000000003' } });
  });

  it('PDFs go as a document block; unsupported types, refusals and truncation throw', async () => {
    const f = fakeClient(ANSWER);
    await new ClaudeVisionOcr({ client: f.client }).recognize(new Uint8Array([37, 80]), 'application/pdf');
    expect(f.calls[0].messages[0].content[0].type).toBe('document');
    await expect(new ClaudeVisionOcr({ client: f.client }).recognize(new Uint8Array(), 'image/tiff')).rejects.toThrow(/unsupported/);
    await expect(new ClaudeVisionOcr({ client: fakeClient(ANSWER, 'refusal').client }).recognize(new Uint8Array(), 'image/png')).rejects.toThrow(/declined/);
    await expect(new ClaudeVisionOcr({ client: fakeClient(ANSWER, 'max_tokens').client }).recognize(new Uint8Array(), 'image/png')).rejects.toThrow(/truncated/);
  });

  it('end to end: agreement between parser and vision gives a confident, auto-fillable receipt', async () => {
    const r = await processReceiptImage(new Uint8Array([1]), 'image/jpeg', { ocr: new ClaudeVisionOcr({ client: fakeClient(ANSWER).client }) });
    expect(r).toMatchObject({ total: '115.00', vat: '15.00', vatNumber: '300000000000003', date: '2026-11-03', needsReview: false, isReceipt: true });
  });
});

describe('mergeVisionFields (via extractReceipt)', () => {
  it('fills what the parser missed (vision-only fields at 0.9)', () => {
    const r = extractReceipt({ ocrText: 'blurry', fields: { merchantName: 'Panda', total: '42.5', date: '2026-11-01' } });
    expect(r).toMatchObject({ merchantName: 'Panda', total: '42.50', date: '2026-11-01', needsReview: false });
    expect(r.fieldConfidence.total).toBe(0.9);
  });

  it('disagreement on money forces review with a warning', () => {
    const r = extractReceipt({ ocrText: 'Total incl VAT 115.00', fields: { total: '151.00' } });
    expect(r.needsReview).toBe(true);
    expect(r.warnings.join()).toMatch(/text parser read 115.00, vision read 151.00/);
  });

  it('implausible vision values are ignored (bad VAT id, non-numeric total, bad date)', () => {
    const r = extractReceipt({ ocrText: '', fields: { vatNumber: '123', total: 'about 20', date: 'yesterday' } });
    expect(r.vatNumber).toBeUndefined(); expect(r.total).toBeUndefined(); expect(r.date).toBeUndefined();
    expect(r.needsReview).toBe(true);
  });

  it('flags VAT that is not 15% of the total', () => {
    expect(extractReceipt({ ocrText: '', fields: { merchantName: 'x', date: '2026-11-01', total: '100.00', vat: '30.00' } }).warnings.join())
      .toMatch(/not 15%/);
  });
});
