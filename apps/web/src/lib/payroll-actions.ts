'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiSend, apiUpload } from './api';
import { loadSession } from './dashboard';

/**
 * Payroll from the web: create the month's run, adjust it while it is a draft, approve it,
 * then record each worker's payment with a screenshot of the bank transfer (or its reference).
 * The API enforces every rule (who may, frozen lines, the Art. 9 cap, proof required).
 */
const UUID = /^[0-9a-f-]{36}$/;
const MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']);
const back = (l: string, runId: string, q = '') => `/${l}/payroll/${runId}${q}`;
const msg = (d?: string) => encodeURIComponent((d ?? '').slice(0, 300));

async function ctx(f: FormData) {
  const l = String(f.get('locale') ?? 'ar');
  const s = await loadSession(l);
  if (!s.opts) redirect(`/${l}/sign-in`);
  return { l, opts: s.opts! };
}

export async function createRun(f: FormData) {
  const { l, opts } = await ctx(f);
  const year = Number(f.get('year')), month = Number(f.get('month'));
  const r = await apiSend<{ id?: string }>('POST', '/v1/payroll-runs', opts, { year, month });
  if (r.ok && r.body.id) redirect(back(l, r.body.id));
  redirect(`/${l}/payroll?e=${msg(r.detail)}`);
}

export async function runStatus(f: FormData) {
  const { l, opts } = await ctx(f);
  const id = String(f.get('runId')), action = String(f.get('action'));
  if (!UUID.test(id) || !['approve', 'reopen', 'cancel'].includes(action)) return;
  const r = await apiSend('POST', `/v1/payroll-runs/${id}/${action}`, opts);
  revalidatePath(back(l, id));
  redirect(back(l, id, r.ok ? '' : `?e=${msg(r.detail)}`));
}

export async function addLine(f: FormData) {
  const { l, opts } = await ctx(f);
  const id = String(f.get('runId')), staffId = String(f.get('staffId')), type = String(f.get('type'));
  const amount = Number(String(f.get('amount') ?? '').replace(/[٠-٩]/g, (c) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))));
  const description = String(f.get('description') ?? '').trim();
  if (!UUID.test(id) || !UUID.test(staffId)) return;
  const r = await apiSend('POST', `/v1/payroll-runs/${id}/lines`, opts, { staffId, type, amount, description });
  redirect(back(l, id, r.ok ? `?worker=${staffId}` : `?worker=${staffId}&e=${msg(r.detail)}`));
}

export async function removeLine(f: FormData) {
  const { l, opts } = await ctx(f);
  const id = String(f.get('runId')), lineId = String(f.get('lineId')), staffId = String(f.get('staffId'));
  if (!UUID.test(id) || !UUID.test(lineId)) return;
  const r = await apiSend('DELETE', `/v1/payroll-runs/${id}/lines/${lineId}`, opts);
  redirect(back(l, id, r.ok ? `?worker=${staffId}` : `?worker=${staffId}&e=${msg(r.detail)}`));
}

/** One worker: upload the transfer screenshot (if any), then record the payment against the run. */
export async function payWorker(f: FormData) {
  const { l, opts } = await ctx(f);
  const id = String(f.get('runId')), staffId = String(f.get('staffId'));
  if (!UUID.test(id) || !UUID.test(staffId)) return;
  const channel = String(f.get('channel') ?? '') || undefined;
  const externalRef = String(f.get('externalRef') ?? '').trim() || undefined;
  const file = f.get('proof');
  let proofFileId: string | undefined;
  if (file instanceof File && file.size > 0) {
    if (!MIME.has(file.type)) redirect(back(l, id, `?worker=${staffId}&e=${msg('image or PDF only')}`));
    const up = await apiUpload(file, { entityType: 'STAFF', entityId: staffId, staffId }, opts);
    if (!up.id) redirect(back(l, id, `?worker=${staffId}&e=${msg(up.detail)}`));
    proofFileId = up.id!;
  }
  const r = await apiSend('POST', `/v1/payroll-runs/${id}/pay/${staffId}`, opts, { channel, externalRef, proofFileId });
  revalidatePath(back(l, id));
  redirect(back(l, id, r.ok ? `?paid=${staffId}` : `?worker=${staffId}&e=${msg(r.detail)}`));
}
