# Anthropic Compatibility with LiteLLM

Chat2API exposes OpenAI-compatible endpoints. LiteLLM provides the Anthropic-compatible `/v1/messages` boundary and converts requests to Chat2API's `/v1/chat/completions` endpoint.

```text
Anthropic client -> LiteLLM :4000 -> Chat2API :8080 -> configured provider
```

The Compose file pins LiteLLM `1.93.0`. Its wildcard route preserves the incoming model name, so a request for `client-model` reaches Chat2API as `client-model`. Configure that name in Chat2API's model mappings when the provider uses a different model ID.

## Start

Start the Chat2API proxy on `127.0.0.1:8080` first. This can be the desktop application or the headless server:

```powershell
# Optional: hold managed-tool SSE until its first complete protocol boundary.
# Set these before starting Chat2API. This lets Chat2API retry a malformed
# tool stream before LiteLLM commits a 200 response. It can delay the first
# byte, so choose the hold budget for the deployment rather than for a
# particular client or model.
$env:CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS = 'true'
$env:CHAT2API_VALIDATED_SSE_MAX_HOLD_MS = '600000'

npm run build:server
npm run start:server
```

Then start LiteLLM:

```powershell
$env:LITELLM_MASTER_KEY = 'sk-change-this-key'
# Optional: outer LiteLLM read/first-byte budget in seconds (default 900).
# Keep this above Chat2API's active response limit and tolerated queue wait.
$env:LITELLM_REQUEST_TIMEOUT = '900'
# The bundled deployment pins its model route to num_retries: 0 so a queued
# request or client cancellation is not submitted a second time.

# Set this only when Chat2API API-key authentication is enabled.
$env:CHAT2API_API_KEY = 'your-chat2api-key'

docker compose -f docker-compose.litellm.yml up -d
docker compose -f docker-compose.litellm.yml ps
```

The Anthropic-compatible base URL is `http://127.0.0.1:4000`. The Compose service listens only on loopback by default.

The bundled route is intentionally generic: it preserves each incoming model
name and forwards it to Chat2API. If a client sends a startup probe or another
alias that differs from the provider model ID, create a normal Chat2API model
mapping through the UI or `/v0/management/model-mappings` (including an optional
preferred provider/account). No client-specific probe or provider is enabled by
the Compose defaults.

If Chat2API is listening on another address, set a URL reachable from the container before starting LiteLLM:

```powershell
$env:CHAT2API_BASE_URL = 'http://host.docker.internal:18080/v1'
```

## Verify

```powershell
$headers = @{
  'x-api-key' = $env:LITELLM_MASTER_KEY
  'anthropic-version' = '2023-06-01'
}

$body = @{
  model = 'your-chat2api-model'
  max_tokens = 128
  messages = @(
    @{ role = 'user'; content = 'Reply with exactly: LiteLLM works' }
  )
} | ConvertTo-Json -Depth 10

Invoke-RestMethod `
  -Method Post `
  -Uri 'http://127.0.0.1:4000/v1/messages' `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body $body
```

Anthropic SDK clients use the same endpoint:

```python
from anthropic import Anthropic

client = Anthropic(
    api_key="sk-change-this-key",
    base_url="http://127.0.0.1:4000",
)

message = client.messages.create(
    model="your-chat2api-model",
    max_tokens=128,
    messages=[{"role": "user", "content": "Hello"}],
)
print(message.content[0].text)
```

For Claude Code, point its Anthropic base URL at LiteLLM and use the LiteLLM master key as its Anthropic token.

For example, the user-level `~/.claude/settings.json` can contain:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4000",
    "ANTHROPIC_AUTH_TOKEN": "sk-change-this-key",
    "ANTHROPIC_MODEL": "your-chat2api-model",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "your-chat2api-model",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "your-chat2api-model",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "your-chat2api-model"
  },
  "permissions": {
    "defaultMode": "bypassPermissions"
  }
}
```

The `permissions` block is optional. `bypassPermissions` disables local tool
approval checks, so use it only in directories whose contents and commands you
trust.

Claude Code captures its permission mode when a session starts. After changing
`permissions.defaultMode`, exit the existing session and start `claude` again;
continuing or resuming an older session keeps that session's previous mode.

Some interactive clients send a preliminary connectivity request before the
first conversation. If that request uses an alias rather than the configured
provider model, add a mapping for the exact alias in Chat2API. This keeps the
protocol bridge usable for both interactive and non-interactive clients without
embedding a client name, project path, or provider model in the deployment.

The deployment enables LiteLLM 1.93's supported
`general_settings.cancel_on_disconnect` option. Its request processor monitors
the downstream connection and cancels an in-flight upstream call when the
client closes the connection, so abandoned work does not keep provider
capacity occupied. This lifecycle policy is independent of client, model, and
provider selection.

## Compatibility Details

LiteLLM 1.93.0 normally sends Anthropic Messages requests for an OpenAI target to the OpenAI Responses API. Chat2API does not expose `/v1/responses`, so the Compose service enables the protocol bridge through the configurable environment value:

```text
LITELLM_USE_CHAT_COMPLETIONS_URL_FOR_ANTHROPIC_MESSAGES=true
```

Keep this enabled when the selected Chat2API target only exposes Chat
Completions; override it only when the target also supports the Responses API.
The supplied config reads the value from the environment so it does not encode
a client-specific model or request path. It also strips the non-Anthropic
`usage.total_tokens` extension and drops parameters that cannot be represented
by the selected OpenAI-compatible provider.

The Compose service also sets LiteLLM's generic `REQUEST_TIMEOUT` to `900`
seconds by default (override it with `LITELLM_REQUEST_TIMEOUT`). LiteLLM uses
this as an outer HTTP connect/read budget; it is not a total-generation timer,
and streaming reads can refresh it. Chat2API independently bounds streams that
stop making meaningful progress, while active generations have no absolute
wall-clock cap by default. It does not change Chat2API's queue policy.
The bundled config sets both the deployment `num_retries` and
`router_settings.num_retries` to the integer `0`. LiteLLM 1.93 has separate
SDK and Router retry budgets; setting only the deployment value still leaves
the Router default at two retries. Zeroing both prevents a duplicate request
after Chat2API returns a queue `429` or a client cancellation. Configure
retries in a separately managed LiteLLM route only when the upstream operation
is known to be idempotent.

The adapter covers regular messages, streaming SSE, Anthropic tool use, tool results, and token counting. Actual support for thinking, images, tools, and other model features still depends on the provider selected by Chat2API.

For Qwen AI managed-tool requests, live SSE forwarding is the default. This
keeps the first generated bytes visible to the downstream client even when a
generation lasts several minutes. Deployments that explicitly need atomic
validation can set `CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS=true`; in that mode
Chat2API holds the transformed SSE prefix for at most
`CHAT2API_VALIDATED_SSE_MAX_HOLD_MS` (60 seconds by default), then releases it
and forwards the rest live. Only validation failures completed before release
can be retried. After bytes are committed, a later failure is reported
in-band and is never transparently retried. Set
`CHAT2API_QWEN_AI_RETRY_COUNT=0` to disable the opt-in recovery retry or use an
integer from `1` to `10` to override its count.

The first validated tool-stream recovery may bypass the ordinary per-account
minimum interval so it cannot collide with the queue timeout. It still obeys
the global start interval, concurrency limit, account and global risk
cooldowns, and client cancellation. This exception is scoped to the same
logical request and is never based on a project path, prompt text, or tool
name. `CHAT2API_QWEN_AI_VALIDATED_STREAM_MAX_BYTES` controls the validation
buffer limit; the default is 16 MiB. Reaching that limit during a bounded hold
also switches the response to live forwarding instead of failing a healthy
long stream.

When the Qwen AI governor cannot start a queued request within
`CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS`, Chat2API returns `429` with a
`Retry-After` header and marks the failure as retryable. A real client
disconnect remains `499` and is not retried. The Compose default is `120000`
ms (120 seconds); override it through the environment when a deployment is
willing to keep clients waiting longer. Pacing and cooldown settings remain
available through the generic Qwen AI governor panel or management API; no
Claude-specific model or request path is required.

Long-context Qwen responses use separate generic transport and response limits.
`QWEN_AI_REQUEST_TIMEOUT_MS` defaults to `600000` ms in the Docker image and
Compose example, while `QWEN_AI_STREAM_IDLE_TIMEOUT_MS` defaults to `180000`
ms. `QWEN_AI_RESPONSE_TIMEOUT_MS=0` disables the optional absolute response
deadline, so meaningful thinking or answer progress is not killed solely by
elapsed wall time. Set it to a positive millisecond value only when an absolute
deployment cap is required. The queue timer applies only before a governor slot
is acquired, and the response/idle timers apply after the upstream request has
started. A long generation therefore does not consume the queue timer, but it
can keep a slot busy long enough for later requests to receive `429`. Do not
raise the queue timeout solely because a single generation is slow; raise it
only when the client and deployment are intended to tolerate a longer
admission wait.
The queue limit is applied per governor admission attempt; a logical request
that opts into a provider recovery retry can have more than one attempt and a
longer total wall-clock duration. A client abort during a later attempt is
still a genuine `499`, not a queue timeout.
Override these environment values for deployments with different latency
budgets.

LiteLLM 1.93.0 has two error-response differences in this database-free setup:

- A missing client key returns `401`, but an unknown key returns `400` with `error.type=no_db_connection` because LiteLLM attempts a virtual-key database lookup.
- Upstream failures preserve the HTTP status but use an OpenAI-style `{ "error": ... }` body instead of Anthropic's outer `{ "type": "error", "error": ... }` body.

Both cases deny the request correctly, but clients that require the exact Anthropic error envelope need an additional response-normalization layer or a future LiteLLM release that changes this behavior.

## Offline Integration Test

The integration test uses fake keys, a temporary Chat2API data directory, and a local mock OpenAI server. It does not read configured accounts or call a real model provider.

```powershell
docker pull docker.litellm.ai/berriai/litellm:v1.93.0
npm run test:litellm
```

It verifies the complete `Anthropic client -> LiteLLM -> Chat2API -> mock upstream` chain, including non-streaming text, streaming SSE, tool calls and results, token counting, authentication, and upstream errors.

## References

- [LiteLLM Anthropic pass-through documentation](https://docs.litellm.ai/docs/pass_through/anthropic_completion)
- [LiteLLM 1.93.0 wildcard configuration](https://github.com/BerriAI/litellm/blob/v1.93.0/litellm/proxy/wildcard_config.yaml)
- [LiteLLM 1.93.0 Anthropic endpoint implementation](https://github.com/BerriAI/litellm/blob/v1.93.0/litellm/proxy/anthropic_endpoints/endpoints.py)
- [LiteLLM 1.93.0 compatibility flag source](https://github.com/BerriAI/litellm/blob/v1.93.0/litellm/__init__.py)

## Stop

```powershell
docker compose -f docker-compose.litellm.yml down
```
