# syntax=docker/dockerfile:1
# UltraSearch MCP server image.
# Generic build and runtime infrastructure for the public MCP package.
# No secrets, private registry references, or production host assumptions.

ARG GIT_SHA=unknown

FROM node:22-bookworm-slim AS build
ARG GIT_SHA
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN pnpm build
RUN printf '%s\n' "${GIT_SHA}" > /app/build/git-sha.txt

FROM node:22-bookworm-slim AS runtime
ARG GIT_SHA
WORKDIR /app
ENV NODE_ENV=production
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY --from=build /app/build ./build
COPY domains.json ./domains.json
RUN chown -R node:node /app
USER node
EXPOSE 3001
LABEL org.opencontainers.image.source="https://github.com/SolResearchLabs/ultrasearch-mcp" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      io.modelcontextprotocol.server.name="io.github.solresearchlabs/ultrasearch-mcp"
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "build/src/index.js"]

