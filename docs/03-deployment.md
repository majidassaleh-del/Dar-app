# 03 · Deployment on the SaaS domain (`darerp.net`)

The platform runs on its own domain, independent of any customer's domain. Every setting below is an environment variable. The templates are `apps/api/.env.example` and `apps/web/.env.example`. Nothing domain-specific is hard-coded.

## 1. Host layout

| Host | Serves | Notes |
|---|---|---|
| `darerp.net` | Marketing / sign-in landing | |
| `app.darerp.net` | Web app with the household switcher | A reserved subdomain, never a household |
| `<slug>.darerp.net` | Web app pinned to one household, e.g. `efa.darerp.net`, `afa.darerp.net` | `slug` is `households.slug` |
| `api.darerp.net` | NestJS API (`/v1`) | Called by the web app's server and by the mobile app |

Use one wildcard TLS certificate (`*.darerp.net`) plus one for the apex. Point `*.darerp.net` and the apex at the web app's load balancer, and `api.darerp.net` at the API. A specific DNS record such as `api` wins over the wildcard.

## 2. API (`apps/api`)

| Variable | Production value | Purpose |
|---|---|---|
| `PUBLIC_APP_URL` | `https://app.darerp.net` | Links in notifications and e-mails. Must be https in production |
| `PUBLIC_API_URL` | `https://api.darerp.net` | Absolute API URLs. Must be https in production |
| `CORS_ORIGINS` | `https://darerp.net,https://app.darerp.net,https://*.darerp.net` | Browser origins allowed by CORS (see below) |
| `TRUST_PROXY` | `1` | Load-balancer hops trusted for `X-Forwarded-For` / `-Proto` |
| `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE` | the identity provider's values | Already required in production |
| `AUTH_ADMIN_URL`, `AUTH_ADMIN_KEY` | `https://<project>.supabase.co/auth/v1`, the project's **service-role** key | Creates the sign-in identity while an invitation is accepted. Required in production. Server-side secret: API only |
| `AUTH_BRAND_NAME` | `Dar ERP` | Name in verification messages before a person belongs to a household |

**CORS:**
* The web app calls the API **server-to-server**, and the mobile app sends no `Origin`, so neither needs CORS. The allow-list covers any browser client served from the domain.
* An entry is an exact origin, or a wildcard of exactly one label: `https://*.darerp.net` matches `efa.darerp.net`, but not `a.b.darerp.net`, the apex, `http://` or look-alikes such as `darerp.net.evil.example`.
* Boot fails in production on `*`, on any non-https entry and on a TLD wildcard (`https://*.net`). `http://*.localhost:3000` is accepted for local development only.
* Allowed request headers: `Authorization`, `Content-Type`, `Accept-Language`, `X-Household-Id`, `X-Request-Id`, `Idempotency-Key`. `X-Request-Id` is exposed to the browser.
* `credentials: false`: the API never accepts cookies cross-origin. Browsers authenticate with a bearer token.
* An origin that is not on the list gets no `Access-Control-*` headers.
* The behaviour is covered by `apps/api/test/domain.e2e.test.ts`.

## 3. Web (`apps/web`)

| Variable | Production value | Purpose |
|---|---|---|
| `HERP_API_URL` | `https://api.darerp.net` (or the internal service URL) | Server-side API base URL |
| `HERP_AUTH_URL`, `HERP_AUTH_KEY` | `https://<project>.supabase.co/auth/v1`, the project's anon key | Identity provider for the sign-in code (called server-side only) |
| `HERP_SESSION_COOKIE` | `__Secure-herp_session` | httpOnly cookie holding the bearer token |
| `HERP_HOUSEHOLD_COOKIE` | `herp_household` | Switcher choice on the app host |
| `HERP_COOKIE_DOMAIN` | `.darerp.net` | One sign-in covers `app.` and every tenant subdomain. Leave unset for host-only cookies |
| `HERP_TENANT_BASE_DOMAIN` | `darerp.net` | Turns on `<slug>.darerp.net` routing |
| `HERP_TENANT_RESERVED` | `app,www,api,admin,auth,static,cdn,mail,status` | Subdomains that are never a household slug |
| `HERP_COOKIE_SECURE` | — | Cookies are always `Secure` in production. Set `true` to force it on an https staging host |

`HERP_DEV_TOKEN` is ignored when `NODE_ENV=production`.

**Tenant resolution** happens in `src/lib/api.ts` → `resolveHousehold`:
1. The `Host` header is matched against `HERP_TENANT_BASE_DOMAIN`, giving a slug. The proxy in front of the web app must therefore preserve `Host`.
2. On a tenant subdomain, the household is the caller's membership with that slug, taken from `GET /v1/me`. Membership in that household is required: otherwise the page is a 404, never another household or sample data.
3. On the app host, the household comes from the switcher cookie.
4. In every case the API is the authority. It re-checks the membership for `X-Household-Id` and enforces Postgres RLS. The subdomain only selects among the caller's own households; it can never grant access.

**Headers on every response:**
* `X-Content-Type-Options: nosniff`
* `Referrer-Policy: strict-origin-when-cross-origin`
* `X-Frame-Options: DENY`
* A restrictive `Permissions-Policy`
* `Strict-Transport-Security: max-age=31536000`, in production only. `includeSubDomains` is left to the domain owner, since it binds every subdomain of `darerp.net` to https.

## 3a. Invitation-only sign-up (identity provider)

Accounts are created only by an owner-issued invitation (`docs/02-api.md` §2b). Three things enforce it, and all three must be in place:

1. **Disable public sign-up at the provider.** Supabase dashboard → Authentication → Sign In / Providers → turn **"Allow new users to sign up" off** (self-hosted GoTrue: `GOTRUE_DISABLE_SIGNUP=true`; Supabase CLI `config.toml`: `[auth] enable_signup = false`). Keep phone and e-mail OTP sign-in enabled for existing users.
2. **Give the API, and only the API, the service-role key** (`AUTH_ADMIN_URL`, `AUTH_ADMIN_KEY`). The web app keeps using the anon key (`HERP_AUTH_KEY`) and always sends `create_user: false`.
3. **The API's own gate.** Even if step 1 were missed, an identity without an accepted invitation has no user row and is refused with `403` on every route.

Check after configuring (replace the placeholders; the number must be one nobody invited):

```bash
# 1. The provider refuses to create a user: expect a 4xx ("Signups not allowed"), and no new row under Authentication → Users.
curl -s -X POST "https://<project>.supabase.co/auth/v1/otp" -H "apikey: <anon key>" -H "Content-Type: application/json" \
     -d '{"phone":"+9665XXXXXXXX","create_user":true}'
# 2. The API refuses an invitation that does not exist: expect 403.
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://api.darerp.net/v1/auth/invitations/accept -H "Content-Type: application/json" -d '{"token":"x"}'
```

Then issue one real invitation as the owner, accept it, and sign in with the invited number end to end. This path has **not** been exercised against a live Supabase project yet.

## 4. Local equivalent

```bash
# API
CORS_ORIGINS=http://localhost:3000,http://*.localhost:3000
AUTH_ADMIN_URL=http://localhost:9999/auth/v1    # scripts/dev-idp.mjs stands in for the identity provider
AUTH_ADMIN_KEY=dev-service-role-key-0123456789
PUBLIC_APP_URL=http://localhost:3000
# Web
HERP_TENANT_BASE_DOMAIN=localhost      # then open http://efa.localhost:3000 or http://afa.localhost:3000
```

Browsers resolve `*.localhost` to loopback, and `next.config.ts` allows `*.localhost` as a dev origin.

## 5. Checklist

- [ ] DNS: the apex, `*.darerp.net` → web; `api.darerp.net` → API. TLS for both.
- [ ] API: `NODE_ENV=production`, `PUBLIC_APP_URL`, `PUBLIC_API_URL`, `CORS_ORIGINS`, `TRUST_PROXY`, plus the existing production requirements (JWKS, Cloud KMS, signing secrets, OTP gateway). The API refuses to boot without them.
- [ ] Identity provider: public sign-up **disabled**; `AUTH_ADMIN_URL` + `AUTH_ADMIN_KEY` (service role) set on the API only; both checks in §3a pass.
- [ ] Web: `HERP_API_URL`, `HERP_SESSION_COOKIE=__Secure-herp_session`, `HERP_COOKIE_DOMAIN=.darerp.net`, `HERP_TENANT_BASE_DOMAIN=darerp.net`.
- [ ] Household slugs are lowercase DNS labels and do not collide with `HERP_TENANT_RESERVED`.
- [ ] The proxy preserves `Host` for the web app and sets `X-Forwarded-Proto`.
