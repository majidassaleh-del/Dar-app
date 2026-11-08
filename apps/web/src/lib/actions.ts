'use server';

import { revalidatePath } from 'next/cache';
import { apiPost } from './api';
import { loadSession } from './dashboard';

const UUID = /^[0-9a-f-]{36}$/;

/**
 * Decisions taken from the web app. The API re-checks everything (membership, approver step,
 * permissions, RLS); these only forward the click under the user's own session.
 */
export async function decideRequest(form: FormData) {
  const id = String(form.get('id') ?? ''), decision = String(form.get('decision') ?? ''), locale = String(form.get('locale') ?? 'ar');
  if (!UUID.test(id) || !['approve', 'reject'].includes(decision)) return;
  const s = await loadSession(locale);
  if (!s.opts) return;
  await apiPost(`/v1/requests/${id}/${decision}`, {}, s.opts);
  revalidatePath(`/${locale}/requests/${id}`);
}

export async function reviewPettyCash(form: FormData) {
  const logId = String(form.get('logId') ?? ''), floatId = String(form.get('floatId') ?? ''), decision = String(form.get('decision') ?? ''), locale = String(form.get('locale') ?? 'ar');
  if (!UUID.test(logId) || !UUID.test(floatId) || !['APPROVED', 'REJECTED'].includes(decision)) return;
  const s = await loadSession(locale);
  if (!s.opts) return;
  await apiPost(`/v1/petty-cash/logs/${logId}/review`, { decision }, s.opts);
  revalidatePath(`/${locale}/petty-cash/${floatId}`);
}
