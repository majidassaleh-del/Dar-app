import { NextResponse, type NextRequest } from 'next/server';
import { HOUSEHOLD_COOKIE } from '@/lib/api';

/**
 * Tenant switcher: remembers the chosen household (httpOnly cookie). The API still
 * decides: a household the user is not an active member of resolves to nothing.
 */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const id = String(form.get('householdId') ?? '');
  const back = String(form.get('back') ?? '/');
  const res = NextResponse.redirect(new URL(back.startsWith('/') ? back : '/', req.url), 303);
  if (/^[0-9a-f-]{36}$|^sample-[a-z]+$/.test(id)) {
    res.cookies.set(HOUSEHOLD_COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 60 * 60 * 24 * 180 });
  }
  return res;
}
