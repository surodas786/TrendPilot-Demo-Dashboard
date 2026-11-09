# TrendPilot Paper staging image: one image for the web app, worker, market feed and one-off
# operator commands (migrate, bootstrap). Paper only: no exchange credentials exist in this build,
# and the web app, worker and feed refuse to start unless LIVE_ORDER_TRANSPORT=disabled.
#
#   docker build -t trendpilot:staging .
#
# Dev dependencies stay installed because the worker, feed and operator CLIs run TypeScript
# through tsx (no separate compile step in this release).
FROM node:22-bookworm-slim

ENV NEXT_TELEMETRY_DISABLED=1 \
    LIVE_ORDER_TRANSPORT=disabled
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/db/package.json packages/db/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN npm ci --no-audit --no-fund

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
COPY apps/worker ./apps/worker
COPY scripts ./scripts

# Production build. NODE_ENV=production is set only for the build and the runtime, so npm ci
# above still installs the dev dependencies the CLIs need.
RUN NODE_ENV=production npm run build

ENV NODE_ENV=production
RUN chown -R node:node /app/apps/web/.next
USER node
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@trendpilot/web"]
