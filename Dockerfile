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
# Keep the proxy transport-only by default. Clients that need the explicit
# compaction workflow can opt in with CHAT2API_COMPACTION_DETECTION=auto.
ENV CHAT2API_COMPACTION_DETECTION=off
ENV CHAT2API_QWEN_AI_COMPACTION_THINKING=auto
# Compaction input uses live model limits first; these values are deployment
# controls for an explicit override, optional metadata cap, or a
# catalogue-without-limits fallback. Zero leaves live metadata uncapped.
ENV CHAT2API_QWEN_AI_COMPACTION_INPUT_TOKEN_BUDGET=0
ENV CHAT2API_QWEN_AI_COMPACTION_METADATA_MAX_INPUT_TOKENS=0
ENV CHAT2API_QWEN_AI_COMPACTION_FALLBACK_INPUT_TOKENS=12000
ENV CHAT2API_QWEN_AI_COMPACTION_PROMPT_TOKEN_RESERVE=512
ENV CHAT2API_QWEN_AI_COMPACTION_CHUNK_DELAY_MS=0
ENV CHAT2API_QWEN_AI_COMPACTION_MAX_REDUCTION_ROUNDS=6
# Zero means use the complete active account pool discovered at runtime.
ENV CHAT2API_QWEN_AI_COMPACTION_MAX_ACCOUNT_ATTEMPTS=0
# Limit simultaneous recovery candidates only; account rotation still uses
# the complete active pool unless the deployment sets an attempt cap.
ENV CHAT2API_QWEN_AI_COMPACTION_FAILOVER_WAVE_SIZE=2
# Keep failover bounded even when a large account pool is configured.
ENV CHAT2API_QWEN_AI_MAX_ACCOUNT_FAILOVERS=5
# Keep the adaptive pacing floor aligned with the validated multi-account
# deployment; upstream 429/risk responses still control account cooldowns.
ENV CHAT2API_QWEN_AI_AUTO_TUNE_MIN_GLOBAL_INTERVAL_MS=1000
# Repair active Qwen AI accounts that have a JWT but no Web session cookie.
# Sign-ins are serialized and globally paused when Qwen returns risk control.
ENV CHAT2API_QWEN_AI_SESSION_REPAIR_ENABLED=true
ENV CHAT2API_QWEN_AI_SESSION_REPAIR_INTERVAL_MS=25000
ENV CHAT2API_QWEN_AI_SESSION_REPAIR_RESCAN_MS=60000
ENV CHAT2API_QWEN_AI_SESSION_REPAIR_RISK_COOLDOWN_MS=180000
ENV CHAT2API_QWEN_AI_SESSION_REPAIR_FAILURE_RETRY_MS=300000
ENV CHAT2API_QWEN_AI_SESSION_REPAIR_CREDENTIAL_RETRY_MS=21600000
# Docker deployments allow long active generations within the cumulative
# request deadline while separately bounding streams that stop producing data.
# Queue admission has its own timer but still shares the route deadline.
ENV CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS=120000
# Keep one effective governor slot available for ordinary client requests
# while a context-compaction map/reduce is active.
ENV CHAT2API_QWEN_AI_COMPACTION_RESERVED_SLOTS=1
# Buffer managed branches until their terminal tool/completion state validates.
ENV CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS=true
# Start document offload before a large Qwen Web request reaches its model context.
# This is a transport target, not a local client request limit; zero disables it.
ENV CHAT2API_QWEN_AI_REQUEST_MAX_BYTES=92160
# Bound inline Hermes routing summaries while complete tool documentation stays
# in the account-scoped reference attachment. Zero omits inline descriptions.
ENV CHAT2API_QWEN_AI_HERMES_ROUTING_SUMMARY_MAX_CODE_POINTS=240
# Managed-branch and upstream-busy recovery counts are deployment controls.
# Their request deadlines remain authoritative; zero disables each path.
ENV CHAT2API_QWEN_AI_RETRY_COUNT=1
ENV CHAT2API_QWEN_AI_BUSY_RETRY_COUNT=0
# A transport reset can continue the same Qwen response without resubmitting
# the prompt. Deployments can tune or disable this bounded recovery budget.
ENV CHAT2API_QWEN_AI_STREAM_RESUME_ATTEMPTS=1
ENV CHAT2API_QWEN_AI_STREAM_RESUME_DELAY_MS=1000
ENV CHAT2API_QWEN_AI_WORKFLOW_CONTINUATION_ATTEMPTS=1
ENV CHAT2API_QWEN_AI_RECOVERY_BUDGET_MS=600000
# Semantic continuation branches also share an absolute wall-clock deadline.
ENV CHAT2API_QWEN_AI_WORKFLOW_RECOVERY_TIMEOUT_MS=840000
# Busy-chat admission is bounded separately from the long generation timeout.
# Retry the exact same continuation payload at most once by default; operators
# can opt into deadline mode explicitly without changing client-specific code.
ENV CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_MODE=attempts
ENV CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS=1
ENV CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_BUDGET_MS=300000
ENV CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS=1000
# Keep retained Responses tool-result continuations on the same provider chat
# through short transient CHAT_IN_PROGRESS windows before account failover.
ENV CHAT2API_QWEN_AI_RESPONSES_CONTINUATION_RETRY_ATTEMPTS=1
ENV CHAT2API_VALIDATED_SSE_MAX_HOLD_MS=60000
ENV CHAT2API_SSE_KEEPALIVE_INTERVAL_MS=15000
# Responses clients consume typed events rather than SSE comments when
# refreshing their stream idle deadline.
ENV CHAT2API_RESPONSES_PROGRESS_INTERVAL_MS=15000
# Persist bounded Responses previous_response_id lineages across restarts.
ENV CHAT2API_RESPONSES_STORE_PATH=/data/responses/conversations.jsonl
ENV CHAT2API_RESPONSES_STORE_TTL_MS=86400000
ENV CHAT2API_RESPONSES_STORE_CHECKPOINT_INTERVAL=32
# Stop unchanged command cycles before another upstream request is made.
ENV CHAT2API_RESPONSES_TOOL_LOOP_THRESHOLD=3
ENV CHAT2API_RESPONSES_TOOL_LOOP_WINDOW=8
# Tool names are client-defined; deployments may explicitly configure a
# comma-separated exclusion list when their client has polling primitives.
ENV CHAT2API_RESPONSES_TOOL_LOOP_IGNORED_TOOLS=
# Anthropic Messages clients recognize typed ping events as stream activity.
ENV CHAT2API_ANTHROPIC_PING_INTERVAL_MS=15000
# Keep the HTTP listener alive long enough for the longest configured request
# to finish when Docker sends SIGTERM during an update.
ENV CHAT2API_SHUTDOWN_DRAIN_TIMEOUT_MS=540000
# Cumulative request deadline shared by upstream generation and recovery.
ENV QWEN_AI_REQUEST_TIMEOUT_MS=840000
# Zero disables only the additional post-admission response cap. The
# cumulative QWEN_AI_REQUEST_TIMEOUT_MS deadline still bounds the full request.
ENV QWEN_AI_RESPONSE_TIMEOUT_MS=0
ENV QWEN_AI_STREAM_IDLE_TIMEOUT_MS=180000
# Bound each account's document parse stage independently so a stalled parse
# can move to another account while the cumulative request deadline remains.
ENV QWEN_AI_FILE_PARSE_POLL_INTERVAL_MS=2000
ENV QWEN_AI_FILE_PARSE_TIMEOUT_MS=120000
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
