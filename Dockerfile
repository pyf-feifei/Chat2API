ARG NODE_IMAGE=node:22.21.1

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build:server

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV CHAT2API_HOST=0.0.0.0
ENV CHAT2API_PORT=8080
ENV CHAT2API_DATA_DIR=/data
# Docker deployments allow long active generations while still bounding
# streams that stop producing data. Queue admission remains independent.
ENV CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS=120000
# Managed-tool validation buffering is opt-in; the default preserves live SSE.
ENV CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS=false
ENV CHAT2API_VALIDATED_SSE_MAX_HOLD_MS=60000
ENV QWEN_AI_REQUEST_TIMEOUT_MS=600000
ENV QWEN_AI_RESPONSE_TIMEOUT_MS=600000
ENV QWEN_AI_STREAM_IDLE_TIMEOUT_MS=180000
ENV QWEN_AI_OSS_STS_REFRESH_INTERVAL_MS=240000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/out-server ./out-server
COPY --from=build /app/out-admin ./out-admin
COPY --from=build /app/sha3_wasm_bg.7b9ca65ddd.wasm ./sha3_wasm_bg.7b9ca65ddd.wasm
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "out-server/server/index.js"]
