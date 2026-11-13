# Open Arthur — production image.
#
# Built in CI (.github/workflows/publish-image.yml) and pushed to GHCR so the
# host can pull a prebuilt image instead of building from source on deploy.
# Two stages: build everything with pnpm, then ship only what the server
# needs at runtime.

# ---- Build stage -----------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Match the repo's pinned package manager (root package.json packageManager).
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate

COPY . .

RUN pnpm install --frozen-lockfile

# Builds the server (tsc -> dist/) and the Expo web export
# (apps/mobile/dist/web, the server's default WEB_DIR).
RUN pnpm build

# ---- Runtime stage ---------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/mobile/dist ./apps/mobile/dist

# recall_arthur_record resolves its bundled knowledge snapshot from the
# source-tree path (apps/server/src/knowledge/arthur-sync-state.md, relative
# to the working directory) when the compiled dist copy is absent — tsc does
# not copy the .md asset into dist. Ship the source snapshot so the tool
# works in this image.
COPY --from=build /app/apps/server/src/knowledge ./apps/server/src/knowledge

# Render (and most hosts) assign the real port via $PORT, which the server
# already reads; 10000 is Render's conventional default.
EXPOSE 10000

CMD ["node", "dist/apps/server/src/index.js"]
