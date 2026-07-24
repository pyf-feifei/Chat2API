# Chat2API Docker Server

The Docker image runs the existing Koa proxy and management API without Electron. Data is stored under `/data`, so mount it as a volume.

## Build

```bash
docker build -t chat2api:server .
```

If Docker Hub access is restricted or you already have a preferred Node base image locally:

```bash
docker build --build-arg NODE_IMAGE=node:22.21.1 -t chat2api:server .
```

## Run

```bash
docker run -d \
  --name chat2api \
  -p 8080:8080 \
  -v chat2api-data:/data \
  -e CHAT2API_HOST=0.0.0.0 \
  -e CHAT2API_PORT=8080 \
  -e CHAT2API_ENABLE_MANAGEMENT_API=true \
  -e CHAT2API_MANAGEMENT_SECRET=mgmt_change_me \
  chat2api:server
```

## Docker Compose

```bash
$env:CHAT2API_MANAGEMENT_SECRET='mgmt_change_me'
docker compose up -d --build
```

## Health Check

```bash
curl http://localhost:8080/health
```

## Web Admin

Open the browser admin page:

```text
http://localhost:8080/admin/
```

If `localhost` does not resolve correctly on Windows, use:

```text
http://127.0.0.1:8080/admin/
```

Enter `CHAT2API_MANAGEMENT_SECRET` on the login screen. The Docker build serves the existing React management UI from the Electron app, backed by `/v0/management/*` endpoints. The main pages are available in the browser:

- Dashboard
- Providers and accounts
- Proxy settings
- Models and model mapping
- Session settings
- API keys
- Logs
- Settings
- About

Provider account management supports the same manual credential forms used by the Electron UI. For Qwen, add accounts with the `SSO Ticket` field, which maps to the stored credential key `ticket`.

The Docker web admin and proxy run in the same Koa process. Start, stop, restart, and port publishing are therefore managed by Docker or Docker Compose, not by the in-app Stop Proxy button. If you change the listening port or bind address in the UI, restart the container and update your `-p`/Compose port mapping accordingly.

Electron-only automatic in-app login cannot run in Docker because it depends on an Electron `BrowserWindow`. The Docker web admin provides a browser-assisted import flow for Qwen and Kimi providers so you do not have to manually search DevTools storage fields.

## Browser-Assisted Qwen AI Import

For `Qwen AI (International)` (`chat.qwen.ai`):

1. Open `http://localhost:8080/admin/#/providers`.
2. Open the `Qwen AI (International)` account dialog.
3. Switch to the OAuth tab. In Docker this tab becomes `Docker Browser-Assisted Import`.
4. Click `Open Provider Website` and log in at `https://chat.qwen.ai`.
5. Click `Generate Import Script`, then `Copy Import Script`.
6. On the logged-in `chat.qwen.ai` page, open the browser console, paste the script, and run it.
7. Return to Chat2API. The token is filled automatically; click `Validate Credentials`, then `Add Account`.

The script reads `localStorage.token` and readable cookies from the already logged-in `chat.qwen.ai` page, then posts them to the local Docker admin import endpoint using a short-lived random import ID. It does not receive or need the management secret.

For domestic `Qwen` (`www.qianwen.com`), the same flow attempts to read `tongyi_sso_ticket` from `document.cookie`. If the site marks that cookie as `HttpOnly`, browser JavaScript cannot read it and the UI will show a clear failure. In that case, use the manual `SSO Ticket` field.

## Browser-Assisted Kimi Import

For Kimi (`www.kimi.com`):

1. Open `http://localhost:8080/admin/#/providers`.
2. Open the Kimi account dialog and switch to the OAuth tab.
3. Click `Open Provider Website` and log in at `https://www.kimi.com`.
4. Click `Generate Import Script`, copy it, then run it in the logged-in Kimi page's browser console.
5. Return to Chat2API. The access token is filled automatically; validate it and add the account.

The script reads `localStorage.access_token` and `localStorage.refresh_token`. The `volcano-token-info` object is used only for request identifiers (`webId`, `ssid`, and `userId`), which become the stored `deviceId`, `sessionId`, and `trafficId`; it is not treated as a token container. The script also checks the `kimi-auth` cookie/local-storage value when available. Kimi may mark that cookie as `HttpOnly`, so the local-storage tokens are preferred. If the browser blocks the cross-origin POST, the script prints and copies a one-time payload that can be pasted into the Docker admin page.

## Add Qwen Accounts

Add the first Qwen account:

```bash
curl -X POST http://localhost:8080/v0/management/accounts \
  -H "Authorization: Bearer mgmt_change_me" \
  -H "Content-Type: application/json" \
  -d '{
    "providerId": "qwen",
    "name": "qwen-account-1",
    "credentials": {
      "ticket": "tongyi_sso_ticket_value"
    }
  }'
```

Add another Qwen account:

```bash
curl -X POST http://localhost:8080/v0/management/accounts \
  -H "Authorization: Bearer mgmt_change_me" \
  -H "Content-Type: application/json" \
  -d '{
    "providerId": "qwen",
    "name": "qwen-account-2",
    "credentials": {
      "ticket": "another_tongyi_sso_ticket_value"
    }
  }'
```

The proxy load balancer will select among active Qwen accounts according to `CHAT2API_LOAD_BALANCE_STRATEGY` or the persisted config.

Built-in provider records are created lazily when the first account is added for that provider. A fresh container can therefore return an empty provider list until you add an account or otherwise create a provider record.

## Pin A Model To One Account

List accounts:

```bash
curl http://localhost:8080/v0/management/providers/qwen/accounts \
  -H "Authorization: Bearer mgmt_change_me"
```

Create a model mapping with `preferredAccountId`:

```bash
curl -X POST http://localhost:8080/v0/management/model-mappings \
  -H "Authorization: Bearer mgmt_change_me" \
  -H "Content-Type: application/json" \
  -d '{
    "requestModel": "qwen-primary",
    "actualModel": "Qwen3.7-Max",
    "preferredProviderId": "qwen",
    "preferredAccountId": "account_id_from_previous_response"
  }'
```

## Environment Variables

```text
CHAT2API_HOST=0.0.0.0
CHAT2API_PORT=8080
CHAT2API_DATA_DIR=/data
CHAT2API_ENABLE_MANAGEMENT_API=true
CHAT2API_MANAGEMENT_SECRET=mgmt_change_me
CHAT2API_ENABLE_API_KEY=false
CHAT2API_LOG_LEVEL=info
CHAT2API_LOAD_BALANCE_STRATEGY=round-robin
CHAT2API_STORAGE_ENCRYPTION_KEY=
CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS=120000
# Optional guarded throughput profile for a larger Qwen AI account pool.
# These environment values override persisted governor settings.
CHAT2API_QWEN_AI_AUTO_TUNE_ENABLED=true
CHAT2API_QWEN_AI_AUTO_TUNE_MAX_CONCURRENT=20
CHAT2API_QWEN_AI_AUTO_TUNE_MIN_GLOBAL_INTERVAL_MS=1000
CHAT2API_QWEN_AI_ACCOUNT_MIN_INTERVAL_MS=30000
QWEN_AI_REQUEST_TIMEOUT_MS=600000
QWEN_AI_RESPONSE_TIMEOUT_MS=0
QWEN_AI_STREAM_IDLE_TIMEOUT_MS=180000
QWEN_AI_OSS_STS_REFRESH_INTERVAL_MS=240000
CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS=false
CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS=15000
CHAT2API_VALIDATED_SSE_MAX_HOLD_MS=60000
CHAT2API_SSE_KEEPALIVE_INTERVAL_MS=15000
```

Set `CHAT2API_STORAGE_ENCRYPTION_KEY` if you want server-side credential encryption. If it is omitted, credentials are stored in the mounted data directory without the extra runtime encryption layer.

The Qwen AI queue timeout applies only while waiting for a governor slot. The
request and idle limits apply after admission. The idle timeout is refreshed
only by parsed SSE events that represent generation progress; empty events and
transport heartbeats keep the connection alive without resetting it. The
absolute response limit is disabled when `QWEN_AI_RESPONSE_TIMEOUT_MS=0`, so an
active long generation is not terminated solely because of elapsed wall time.
Set a positive value only when the deployment requires an absolute cap. A
stream with no meaningful progress still fails after 180 seconds by default.
An outer client or reverse proxy can impose a shorter end-to-end deadline, so
its timeout must be configured separately when the deployment is expected to
tolerate both queueing and a long generation.
When using the bundled LiteLLM Compose service, its generic outer
`REQUEST_TIMEOUT` defaults to `900` seconds (via `LITELLM_REQUEST_TIMEOUT`).
Streaming activity refreshes LiteLLM's outer connect/read budget. This value is
independent from Chat2API's queue and meaningful-idle limits and remains
configurable.
Chat2API emits legal SSE comment frames after
`CHAT2API_SSE_KEEPALIVE_INTERVAL_MS` of downstream silence. These comments do
not become model output and do not reset the Qwen meaningful-progress timer;
set the value to `0` only when another layer owns transport keep-alives.
If Qwen closes a response socket before its terminal event, Chat2API can ask
Qwen to continue the same response using its `chat_id` and `response_id`.
`CHAT2API_QWEN_AI_STREAM_RESUME_ATTEMPTS` (default `3`) bounds those
continuations and `CHAT2API_QWEN_AI_STREAM_RESUME_DELAY_MS` (default `1000`)
controls the pause between attempts. Set the attempts value to `0` to disable
this transport recovery. It never resubmits the original prompt and is not
selected by a session id, project path, or task content.
Qwen's early-error preflight is bounded by
`CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS`. Once that window expires, the
HTTP response switches to live SSE and later provider failures are reported
in-band instead of withholding the response indefinitely.
Managed SSE validation is opt-in through
`CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS=true`. The normal value (`false`)
forwards generated SSE immediately, so a long response does not wait for
validation before sending its first byte. When validation is enabled,
`CHAT2API_VALIDATED_SSE_MAX_HOLD_MS` bounds how long an active stream may be
withheld before its buffered prefix is released. This is not a generation
timeout; after release, later failures are reported in-band and are not
retried.

## Upstream Update Flow

The Docker-specific patch surface is intentionally small:

```text
src/server/
src/main/runtime/
src/main/store/storage/
src/renderer/admin.html
src/renderer/src/web-main.tsx
src/renderer/src/web-admin-api.ts
tests/server/
Dockerfile
docker-compose.yml
.dockerignore
docs/docker.md
vite.admin.config.ts
vite.server.config.ts
```

When pulling upstream:

```bash
git fetch upstream
git merge upstream/main
npm install
npm run test:server-compat
npm run build:server
docker build -t chat2api:server .
```

Resolve conflicts by keeping upstream provider, OAuth, adapter, and React UI logic first. Then reapply the Docker runtime boundary, server entrypoint, management API coverage, and web `window.electronAPI` adapter where direct Electron IPC or `BrowserWindow` usage blocks the Node server build.

After every upstream merge, verify the real container, not just the local build:

```bash
docker rm -f chat2api
docker run -d --name chat2api -p 8080:8080 \
  -v chat2api-data:/data \
  -e CHAT2API_ENABLE_MANAGEMENT_API=true \
  -e CHAT2API_MANAGEMENT_SECRET=mgmt_change_me \
  chat2api:server

curl http://127.0.0.1:8080/admin/
curl -H "Authorization: Bearer mgmt_change_me" \
  http://127.0.0.1:8080/v0/management/providers/builtin
```
