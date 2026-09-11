# onnxruntime-node ships glibc binaries only - Debian slim, not Alpine.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN npm ci --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @helpdesk/shared && npm run build -w @helpdesk/api
# Embedding model goes into the image: no download on first start.
COPY deploy/prefetch-model.mjs deploy/
RUN RAG_MODEL_DIR=/app/data/models node deploy/prefetch-model.mjs

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/data/models data/models
COPY data/catalog data/catalog
COPY data/raw data/raw
RUN chown -R node:node /app/data
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s CMD curl -fsS http://127.0.0.1:8080/health || exit 1
CMD ["node", "apps/api/dist/index.js"]
