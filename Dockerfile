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
# Upstream token optimizer, on by default in `safe` mode: it rewrites
# only old, CLOSED tool results and archives the original text, so the
# omission is recoverable. Verified 2026-09-26 (21264 -> 18001 prompt
# tokens on a 12-tool-call history, answer intact; ordinary prose saved
# nothing because it has no eligible content). `dry-run` measures
# without rewriting, `balanced` drops omitted lines, `off` disables.
ENV CHAT2API_UPSTREAM_TOKEN_OPTIMIZER=safe
ENV CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_MIN_TOKENS=20000
ENV CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_RECENT_MESSAGES=8
ENV CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_MIN_SAVINGS=64
ENV CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_MAX_TOOL_TEXT_CHARS=16000
# MiMo Web rejects rendered queries around 44k–52k characters. Leave room for
# managed tool prompts and the active turn when offloading long Codex history.
ENV MIMO_FILE_OFFLOAD_THRESHOLD_CHARS=8000
ENV MIMO_QUERY_MAX_CHARS=32000
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
ENV CHAT2API_QWEN_AI_MANAGED_MAX_ACCOUNT_FAILOVERS=1
ENV CHAT2API_QWEN_AI_RISK_CIRCUIT_THRESHOLD=2
ENV CHAT2API_QWEN_AI_RISK_CIRCUIT_COOLDOWN_MS=600000
# Keep the adaptive pacing floor aligned with the validated multi-account
# deployment; upstream 429/risk responses still control account cooldowns.
ENV CHAT2API_QWEN_AI_AUTO_TUNE_MIN_GLOBAL_INTERVAL_MS=1000
# Repair active Qwen AI accounts that have a JWT but no Web session cookie.
# Sign-ins are serialized and globally paused when Qwen returns risk control.
ENV CHAT2API_QWEN_AI_SESSION_REPAIR_ENABLED=true
ENV CHAT2API_QWEN_AI_SESSION_REPAIR_INTERVAL_MS=25000
ENV CHAT2API_QWEN_AI_SESSION_REPAIR_RESCAN_MS=60000
ENV CHAT2API_QWEN_AI_SESSION_REPAIR_RISK_COOLDOWN_MS=180000
# Token-refresh risk control is an egress/WAF verdict (aliyun challenge page),
# not a credential problem: stop issuing refreshes for this window after the
# first hit so healthy accounts are not frozen one by one.
ENV CHAT2API_QWEN_AI_REFRESH_RISK_GATE_MS=300000
# One upstream "this account does not exist" verdict is not enough to freeze an
# account. Require N consecutive verdicts inside the window; a single verdict
# only records a strike and keeps the account serving traffic.
ENV CHAT2API_QWEN_AI_UNREGISTERED_STRIKES=3
ENV CHAT2API_QWEN_AI_UNREGISTERED_STRIKE_WINDOW_MS=1800000
# Several accounts rejected in a row is an egress verdict, not N dead
# credentials: open the same shared refresh gate instead of sweeping the pool.
ENV CHAT2API_QWEN_AI_REFRESH_REJECTION_STREAK_LIMIT=5
ENV CHAT2API_QWEN_AI_REFRESH_REJECTION_STREAK_WINDOW_MS=300000
# A frozen account still holds its login credentials, so the pool stays
# recoverable: re-authenticate it on this interval instead of parking it.
# Without this, one bad verdict could take the whole pool offline for good.
ENV CHAT2API_QWEN_AI_SESSION_REPAIR_PROBE_INTERVAL_MS=21600000
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
# Controls Chat2API-generated transcript documents only; false keeps the full
# transcript inline while preserving original user attachment uploads.
ENV CHAT2API_QWEN_AI_TRANSCRIPT_UPLOAD_ENABLED=true
# Synthetic transcript format: txt (default) or md.
ENV CHAT2API_QWEN_AI_TRANSCRIPT_EXTENSION=txt
# Z.ai context offload mirrors the Qwen document transport: oversized inline
# history is uploaded as a transcript document; zero disables the offload.
ENV CHAT2API_ZAI_REQUEST_MAX_BYTES=92160
# Set false to keep the complete Z.ai transcript inline.
ENV CHAT2API_ZAI_TRANSCRIPT_UPLOAD_ENABLED=true
# Bound inline Hermes routing summaries while complete tool documentation stays
# in the account-scoped reference attachment. Zero omits inline descriptions.
ENV CHAT2API_QWEN_AI_HERMES_ROUTING_SUMMARY_MAX_CODE_POINTS=240
# Managed-branch and upstream-busy recovery counts are deployment controls.
# Their request deadlines remain authoritative; zero disables each path. A
# busy RGV587 window usually clears within seconds, so the default retries
# the same account once with backoff before account rotation.
ENV CHAT2API_QWEN_AI_RETRY_COUNT=1
ENV CHAT2API_QWEN_AI_BUSY_RETRY_COUNT=1
# Content-determined 422s follow the request, not the account: cap account
# rotation ('off' disables). Busy across >= threshold distinct accounts in
# one logical request is a storm: cool those accounts for the configured
# window and feed the existing global risk circuit + recovery probe.
ENV CHAT2API_QWEN_AI_CONTENT_FAILOVER_ROTATION_MAX=0
# An aliyun content verdict (bxpunish/RGV587) is decided by the request payload:
# -1 stops account rotation on the FIRST hit (measured: 6 accounts and ~79s
# burned per request for an identical, unmovable verdict).
ENV CHAT2API_QWEN_AI_CONTENT_VERDICT_ROTATION_MAX=-1
ENV CHAT2API_QWEN_AI_BUSY_STORM_ACCOUNT_THRESHOLD=2
ENV CHAT2API_QWEN_AI_BUSY_STORM_COOLDOWN_MS=600000
# A transport reset can continue the same Qwen response without resubmitting
# the prompt. Deployments can tune or disable this bounded recovery budget.
ENV CHAT2API_QWEN_AI_STREAM_RESUME_ATTEMPTS=2
ENV CHAT2API_QWEN_AI_STREAM_RESUME_DELAY_MS=1000
ENV CHAT2API_QWEN_AI_WORKFLOW_CONTINUATION_ATTEMPTS=2
# A dangling same-chat continuation escalates once to a fresh-chat replay.
ENV CHAT2API_QWEN_AI_SEMANTIC_FRESH_CHAT_ESCALATIONS=1
# A leaked tool-result wrapper is replaced in a fresh chat; a second attempt
# covers the case where the first replay re-drew the same poisoned context.
ENV CHAT2API_QWEN_AI_WRAPPER_LEAK_RECOVERY_ATTEMPTS=2
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
# Long managed-tool sessions can spend several full reasoning+answer rounds
# inside same-chat continuations and fresh-chat replays before converging;
# 25 minutes covers that worst case while still bounding a stuck request.
ENV QWEN_AI_REQUEST_TIMEOUT_MS=1500000
# Zero disables only the additional post-admission response cap. The
# cumulative QWEN_AI_REQUEST_TIMEOUT_MS deadline still bounds the full request.
ENV QWEN_AI_RESPONSE_TIMEOUT_MS=0
ENV QWEN_AI_STREAM_IDLE_TIMEOUT_MS=180000
# Bound each account's document parse stage independently so a stalled parse
# can move to another account while the cumulative request deadline remains.
ENV QWEN_AI_FILE_PARSE_POLL_INTERVAL_MS=2000
ENV QWEN_AI_FILE_PARSE_TIMEOUT_MS=180000
ENV QWEN_AI_OSS_STS_REFRESH_INTERVAL_MS=240000
# Install Chromium and Python deps for Z.ai captcha solver
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    chromium-driver \
    python3-pip \
    python3-numpy \
    python3-pil \
    && pip3 install --no-cache-dir --break-system-packages patchright \
    && python3 -m patchright install chromium 2>/dev/null || true \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
ENV CHROME_PATH=/usr/bin/chromium
ENV ZAI_CAPTCHA_SOLVER_PATH=/app/scripts/zai-captcha/solve.py
ENV ZAI_CAPTCHA_ARTIFACT_DIR=/tmp/zai-captcha
# No display and nobody in front of it: never park a refresh waiting on a human.
# (The desktop app defaults this to on; pinned here so container behaviour is
# explicit rather than left to runtime detection.)
ENV ZAI_REFRESH_ALLOW_HUMAN=0
# Qwen RGV587 risk-session refresher (aliyun slider solve -> x5sec cookie harvest)
ENV QWEN_CAPTCHA_SOLVER_PATH=/app/scripts/qwen-captcha/refresh.py
ENV QWEN_CAPTCHA_ARTIFACT_DIR=/tmp/qwen-captcha
# Perturb uploaded transcripts for every attempt. Reconnect-driven replays
# otherwise reuse the upstream content-fingerprint verdict; the risk circuit
# stops repeated terminal failures after the first request.
ENV CHAT2API_QWEN_AI_RETRY_NONCE=true
ENV CHAT2API_QWEN_AI_RETRY_NONCE_SCOPE=always
# Mimo has no refresh endpoint: serviceToken renewal re-runs the Xiaomi password
# login. HTTP passport is risk-controlled from datacenter IPs, so auto mode
# falls back to this patchright driver (Geetest slide + email OTP), which reuses
# the Chromium/patchright runtime installed for the Z.ai/Qwen solvers above.
ENV MIMO_REFRESH_MODE=auto
ENV MIMO_LOGIN_SCRIPT_PATH=/app/scripts/mimo-login/login.py
ENV MIMO_LOGIN_ARTIFACT_DIR=/tmp/mimo-login
ENV MIMO_REFRESH_BROWSER_TIMEOUT_MS=300000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/out-server ./out-server
COPY --from=build /app/out-admin ./out-admin
COPY --from=build /app/sha3_wasm_bg.7b9ca65ddd.wasm ./sha3_wasm_bg.7b9ca65ddd.wasm
COPY scripts/zai-captcha /app/scripts/zai-captcha
COPY scripts/qwen-captcha /app/scripts/qwen-captcha
COPY scripts/mimo-login /app/scripts/mimo-login
RUN mkdir -p /data /tmp/zai-captcha /tmp/qwen-captcha /tmp/mimo-login
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "out-server/server/index.js"]
