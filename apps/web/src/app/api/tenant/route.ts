import { NextResponse, type NextRequest } from 'next/server';
import { webConfig } from '@/lib/config';

/**
 * Tenant switcher: remembers the chosen household (httpOnly cookie). The API still
 * decides: a household the user is not an active member of resolves to nothing.
 */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const id = String(form.get('householdId') ?? '');
  const back = String(form.get('back') ?? '/');
  // Relative Location (RFC 9110): correct behind a proxy, whatever host the app sees, and never off-site.
  const res = new NextResponse(null, { status: 303, headers: { Location: /^\/(?![/\\])/.test(back) ? back : '/' } });
  if (/^[0-9a-f-]{36}$|^sample-[a-z]+$/.test(id)) {
    res.cookies.set(webConfig.householdCookie, id, { httpOnly: true, sameSite: 'lax', secure: webConfig.secureCookies, path: '/',
                                                    domain: webConfig.cookieDomain, maxAge: 60 * 60 * 24 * 180 });
  }
  return res;
}
