import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');
const production = process.env.NODE_ENV === 'production';

/** Sent on every response. HSTS only in production (https on the SaaS domain and its tenant subdomains). */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  ...(production ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000' }] : []),
];

const config: NextConfig = {
  transpilePackages: ['@herp/i18n'],
  poweredByHeader: false,
  // A second local dev server (e.g. without the dev token) needs its own build folder.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Local stand-in for tenant subdomains: efa.localhost:3000 (HERP_TENANT_BASE_DOMAIN=localhost).
  allowedDevOrigins: ['*.localhost'],
  // Transfer screenshots and documents are posted to server actions (the API accepts up to 15 MB).
  experimental: { serverActions: { bodySizeLimit: '16mb' } },
  async headers() { return [{ source: '/:path*', headers: securityHeaders }]; },
};

export default withNextIntl(config);
