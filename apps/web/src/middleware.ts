import createMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';
import { isLocale, negotiateLocale } from '@herp/i18n';
import { routing } from './i18n/routing';

const intl = createMiddleware(routing);

/**
 * Locale-prefixed paths (/ar/…, /tl/…) go straight to next-intl.
 *
 * Unprefixed paths are negotiated here rather than by next-intl: its matcher
 * canonicalises tags through ICU, which rewrites "tl" to "fil", so Tagalog
 * and fil-PH visitors never matched our `tl` locale and fell back to Arabic.
 * Order: NEXT_LOCALE cookie → Accept-Language (q-ordered, fil → tl) → ar.
 */
export default function middleware(req: NextRequest) {
  const first = req.nextUrl.pathname.split('/')[1];
  if (isLocale(first)) return intl(req);

  const cookie = req.cookies.get('NEXT_LOCALE')?.value;
  const locale = isLocale(cookie) ? cookie : negotiateLocale(req.headers.get('accept-language'), routing.defaultLocale);
  const url = req.nextUrl.clone();
  url.pathname = `/${locale}${req.nextUrl.pathname === '/' ? '' : req.nextUrl.pathname}`;
  const res = NextResponse.redirect(url, 307);
  res.headers.set('Vary', 'Accept-Language, Cookie');
  return res;
}

export const config = {
  // Everything except API routes, Next internals and files with an extension.
  matcher: '/((?!api|_next|_vercel|.*\\..*).*)',
};
