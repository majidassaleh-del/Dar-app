'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiSend } from './api';
import { loadSession } from './dashboard';
import { SCOPES } from './permissions';

/**
 * Member, role and permission management: forwards the owner's choices under their session.
 * The API (and RLS beneath it) refuses anyone who is not the household owner.
 */
const UUID = /^[0-9a-f-]{36}$/;
const loc = (f: FormData) => { const l = String(f.get('locale') ?? 'ar'); return /^[a-z]{2}$/.test(l) ? l : 'ar'; };
const code = (status: number) => (status === 403 ? 'owner' : status === 409 ? 'inUse' : status === 422 ? 'rule' : 'failed');
const done = (path: string, r: { ok: boolean; status: number }, okPath = path): never => {
  revalidatePath(path);
  redirect(r.ok ? `${okPath}${okPath.includes('?') ? '&' : '?'}ok=1` : `${path}?e=${code(r.status)}`);
};
/** Form fields whose name starts with a prefix, as [rest of the name, value]. */
function fields(f: FormData, prefix: string) { const out: Array<[string, string]> = []; f.forEach((v, k) => { if (k.startsWith(prefix)) out.push([k.slice(prefix.length), String(v)]); }); return out; }
async function session(l: string, back: string) { const s = await loadSession(l); if (!s.opts) redirect(`${back}?e=failed`); return s.opts!; }

export async function setMemberRole(f: FormData) {
  const l = loc(f), id = String(f.get('id') ?? ''), roleId = String(f.get('roleId') ?? ''), back = `/${l}/members`;
  if (!UUID.test(id) || !UUID.test(roleId)) redirect(`${back}?e=failed`);
  done(back, await apiSend('PATCH', `/v1/members/${id}`, await session(l, back), { roleId }));
}

export async function setMemberStatus(f: FormData) {
  const l = loc(f), id = String(f.get('id') ?? ''), status = String(f.get('status') ?? ''), back = `/${l}/members`;
  if (!UUID.test(id) || !['ACTIVE', 'SUSPENDED', 'REVOKED'].includes(status)) redirect(`${back}?e=failed`);
  const opts = await session(l, back);
  done(back, status === 'REVOKED' ? await apiSend('DELETE', `/v1/members/${id}`, opts) : await apiSend('PATCH', `/v1/members/${id}`, opts, { status }));
}

export async function saveMemberPermissions(f: FormData) {
  const l = loc(f), id = String(f.get('id') ?? ''), back = `/${l}/members/${id}`;
  if (!UUID.test(id)) redirect(`/${l}/members?e=failed`);
  const overrides = fields(f, 'o:').filter(([, v]) => v === 'DENY' || (SCOPES as readonly string[]).includes(v))
    .map(([permissionId, v]) => (v === 'DENY' ? { permissionId, granted: false } : { permissionId, granted: true, scope: v }));
  done(back, await apiSend('PUT', `/v1/members/${id}/permissions`, await session(l, back), { overrides }));
}

export async function createRole(f: FormData) {
  const l = loc(f), back = `/${l}/members`;
  const name = String(f.get('name') ?? '').trim().slice(0, 60), nameAr = String(f.get('nameAr') ?? '').trim().slice(0, 60), baseRole = String(f.get('baseRole') ?? '');
  if (!name && !nameAr) redirect(`${back}?e=name`);
  const nameI18n = { ...(nameAr ? { ar: nameAr } : {}), ...(name ? { en: name } : {}) };
  done(back, await apiSend('POST', '/v1/roles', await session(l, back), { baseRole, nameI18n }));
}

export async function renameRole(f: FormData) {
  const l = loc(f), id = String(f.get('id') ?? ''), back = `/${l}/members/roles/${id}`;
  const name = String(f.get('name') ?? '').trim().slice(0, 60), nameAr = String(f.get('nameAr') ?? '').trim().slice(0, 60);
  if (!UUID.test(id) || (!name && !nameAr)) redirect(`${back}?e=name`);
  done(back, await apiSend('PATCH', `/v1/roles/${id}`, await session(l, back), { nameI18n: { ...(nameAr ? { ar: nameAr } : {}), ...(name ? { en: name } : {}) } }));
}

export async function deleteRole(f: FormData) {
  const l = loc(f), id = String(f.get('id') ?? ''), back = `/${l}/members/roles/${id}`;
  if (!UUID.test(id)) redirect(`/${l}/members?e=failed`);
  done(back, await apiSend('DELETE', `/v1/roles/${id}`, await session(l, back)), `/${l}/members`);
}

export async function saveRolePermissions(f: FormData) {
  const l = loc(f), id = String(f.get('id') ?? ''), back = `/${l}/members/roles/${id}`;
  if (!UUID.test(id)) redirect(`/${l}/members?e=failed`);
  const permissions = fields(f, 'p:').filter(([, v]) => (SCOPES as readonly string[]).includes(v)).map(([permissionId, scope]) => ({ permissionId, scope }));
  done(back, await apiSend('PUT', `/v1/roles/${id}/permissions`, await session(l, back), { permissions }));
}
