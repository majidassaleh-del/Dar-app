import { NextResponse, type NextRequest } from 'next/server';
import { apiGet, authToken, resolveHousehold } from '@/lib/api';
import { sampleSettlement } from '@/lib/settlement-sample';

/**
 * Settlement calculator backend: proxies the API's authoritative calculations
 * (Art. 16 end of service, Art. 10 leave, final settlement) for one worker and
 * date. The browser never sees the API token.
 */
export async function GET(req: NextRequest) {
  const staffId = req.nextUrl.searchParams.get('staffId') ?? '';
  const asOf = req.nextUrl.searchParams.get('asOf') ?? '';
  const locale = req.nextUrl.searchParams.get('locale') ?? 'ar';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return NextResponse.json({ error: 'asOf must be YYYY-MM-DD' }, { status: 400 });
  if (!(await authToken())) {
    const s = sampleSettlement(staffId, asOf);
    return s ? NextResponse.json({ ...s, mode: 'sample' }) : NextResponse.json({ error: 'unknown worker' }, { status: 404 });
  }
  if (!/^[0-9a-f-]{36}$/.test(staffId)) return NextResponse.json({ error: 'staffId' }, { status: 400 });
  const hh = await resolveHousehold(locale);
  if (!hh) return NextResponse.json({ error: 'no household' }, { status: 404 });
  const opts = { household: hh.id, locale };
  const q = `asOf=${asOf}`;
  const [esb, leave, settlement] = await Promise.all([
    apiGet(`/v1/staff/${staffId}/end-of-service?${q}`, opts),
    apiGet(`/v1/staff/${staffId}/leave-balance?${q}`, opts),
    apiGet(`/v1/staff/${staffId}/final-settlement?${q}`, opts),
  ]);
  if (!esb || !leave || !settlement) return NextResponse.json({ error: 'not available' }, { status: 404 });
  return NextResponse.json({ esb, leave, settlement, mode: 'live' }, { headers: { 'Cache-Control': 'no-store' } });
}
