FROM node:22-bookworm-slim AS frontend-build

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-bookworm-slim AS web-runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    DATA_DIR=/data \
    PUBLIC_DIR=/app/frontend/dist

WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY backend/ ./
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist

RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 3001
VOLUME ["/data"]

CMD ["node", "web-launcher.mjs"]
