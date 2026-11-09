import { NextResponse, type NextRequest } from 'next/server';
import { API_URL, apiGet, resolveHousehold } from '@/lib/api';

/**
 * Opens a stored file (e.g. a transfer screenshot) for the signed-in user: asks the API for a
 * short-lived signed link under the user's own session and streams the bytes back. The browser
 * never holds an API token, and the API re-checks access (and audits sensitive files).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const locale = req.nextUrl.searchParams.get('locale') ?? 'ar';
  const hh = await resolveHousehold(locale);
  if (!hh) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const link = await apiGet<{ url: string }>(`/v1/files/${id}/url`, { household: hh.id, locale });
  if (!link?.url) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const r = await fetch(`${API_URL}${link.url}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!r?.ok || !r.body) return NextResponse.json({ error: 'not available' }, { status: 502 });
  return new NextResponse(r.body, { headers: {
    'Content-Type': r.headers.get('content-type') ?? 'application/octet-stream',
    'Content-Disposition': 'inline', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  } });
}
