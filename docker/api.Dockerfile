# HRVO API (ADR 020). Targets:
#   api      the NestJS server (REST, sockets, jobs), non-root
#   migrate  one-off: prisma migrate deploy + role provisioning (run before each release)
# Build: docker build -f docker/api.Dockerfile --target api -t hrvo-api .
ARG NODE_IMAGE=node:22.23.1-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/agent/package.json apps/agent/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --ignore-scripts && npm rebuild argon2
COPY tsconfig.json ./
COPY apps/api apps/api
COPY packages/shared packages/shared
# tsconfig.json compiles scripts/*.ts too (the LAN helpers; apps/api/test/lan-config.test.ts imports one).
COPY scripts scripts
RUN npx prisma generate --schema apps/api/prisma/schema.prisma && npx tsc -p tsconfig.json

# Runtime dependencies only (root "dependencies"; no web, agent or dev packages).
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/agent/package.json apps/agent/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev --workspaces=false --ignore-scripts && npm rebuild argon2 && npm cache clean --force

FROM ${NODE_IMAGE} AS api
WORKDIR /app
ENV NODE_ENV=production PORT=3001 PGSSLROOTCERT=/app/certs/rds-global-bundle.pem
# Amazon RDS CA bundle: the API verifies the database certificate (PGSSLMODE=verify-full).
ADD --chown=node:node https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/certs/rds-global-bundle.pem
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
# The generated Prisma client (engines) from the build stage.
COPY --from=build --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3001
CMD ["node", "dist/apps/api/src/main.js"]

FROM build AS migrate
ENV NODE_ENV=production PGSSLROOTCERT=/app/certs/rds-global-bundle.pem
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/certs/rds-global-bundle.pem
COPY docker/migrate-entrypoint.mjs docker/restore-verify.mjs docker/
USER node
CMD ["node", "docker/migrate-entrypoint.mjs"]
