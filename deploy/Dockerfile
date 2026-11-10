# syntax=docker/dockerfile:1.7
# Images for the two services. Build from the repository root:
#   docker build -f deploy/Dockerfile --target api -t dar-api .
#   docker build -f deploy/Dockerfile --target web -t dar-web .
#   docker build -f deploy/Dockerfile --target db  -t dar-db  .      (one-shot database tooling)
# docker-compose.yml does this for you.
# Behind a TLS-inspecting proxy only: add  --secret id=extra_ca,src=/path/to/ca.pem  (plus the usual proxy build args).

# The full Debian image, not "slim": Prisma's engine needs OpenSSL and the system CA certificates,
# and this way the build needs no package downloads beyond npm.
FROM node:22-bookworm AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1 CI=1
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages packages
COPY prisma prisma

# ------------------------------------------------------------------ API --
FROM base AS api-build
COPY apps/api apps/api
COPY apps/web/package.json apps/web/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile --filter "@herp/api..." \
 && pnpm --filter @herp/api exec prisma generate --schema ../../prisma/schema.prisma \
 && pnpm --filter @herp/api build

FROM node:22-bookworm AS api
RUN mkdir -p /data/storage && chown -R node:node /data
ENV NODE_ENV=production PORT=4000 STORAGE_DIR=/data/storage
WORKDIR /repo
# node_modules as installed (pnpm's layout keeps the generated Prisma client next to @prisma/client).
COPY --from=api-build --chown=node:node /repo/node_modules node_modules
COPY --from=api-build --chown=node:node /repo/packages packages
COPY --from=api-build --chown=node:node /repo/apps/api/node_modules apps/api/node_modules
COPY --from=api-build --chown=node:node /repo/apps/api/dist apps/api/dist
COPY --from=api-build --chown=node:node /repo/apps/api/package.json apps/api/package.json
WORKDIR /repo/apps/api
USER node
VOLUME /data/storage
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

# ------------------------------------------------------------------ Web --
FROM base AS web-build
COPY apps/web apps/web
COPY apps/api/package.json apps/api/package.json
ENV NODE_ENV=production NEXT_OUTPUT=standalone
RUN --mount=type=cache,id=pnpm,target=/pnpm/store --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    NODE_ENV=development pnpm install --frozen-lockfile --filter "@herp/web..." \
 && pnpm --filter @herp/web build

FROM node:22-bookworm-slim AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=web-build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/ar/sign-in').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

# ------------------------------------------------- Database tooling (psql) --
FROM postgres:16-bookworm AS db
WORKDIR /repo
COPY prisma prisma
COPY deploy/db-apply.sh deploy/operator-key.sh deploy/
ENTRYPOINT []
CMD ["deploy/db-apply.sh"]
