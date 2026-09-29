# Codex CLI Compatibility

Chat2API exposes the HTTP Responses endpoint required by Codex CLI:

```text
Codex CLI -> Chat2API /v1/responses -> configured provider
```

## Configure Codex

Add a custom provider to the user-level `~/.codex/config.toml`. Codex does not
load provider definitions from a project-local `.codex/config.toml`.

```toml
model = "your-chat2api-model"
model_provider = "chat2api"

[model_providers.chat2api]
name = "Chat2API"
base_url = "http://127.0.0.1:8080/v1"
env_key = "CHAT2API_API_KEY"
wire_api = "responses"
```

Set the API key in the environment before starting Codex:

```powershell
$env:CHAT2API_API_KEY = 'your-chat2api-key'
codex
```

If Chat2API API-key authentication is disabled, set `CHAT2API_API_KEY` to a
non-empty placeholder. Codex still requires its configured credential variable
to exist.

The `wire_api` value is intentionally `responses`. Current Codex custom model
providers use the Responses protocol; Chat Completions is not a supported Codex
provider wire value. See OpenAI's
[custom model provider guide](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers)
and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference#configtoml).

## Compatibility

The bridge supports streamed text, function and custom tool calls, tool-result
continuations, multimodal tool results, reasoning effort, and bounded
`previous_response_id` continuation. The provider selected by Chat2API still
determines model quality, context size, reasoning behavior, and native feature
availability.

Image generation is request-driven. An API client must include a Responses
`image_generation` tool, and the selected provider must support it. For Qwen AI,
Chat2API translates that tool request to Qwen's image-generation mode and
returns both a standard `image_generation_call` item and Markdown image content.
A normal Codex coding request does not generate an image merely because the
selected model can produce one.

Codex-specific server-side namespace tools are not representable in a generic
Chat Completions upstream and are omitted from that provider request. Ordinary
Codex coding tools are function or custom tools and pass through the bridge.

## Retries and failures

Codex (measured on 0.158) waits only for an in-stream `response.failed` whose
code is `rate_limit_exceeded` and whose message contains `try again in Ns`. Any
other code is retried after 0.2 s and 0.4 s and then surfaces as
`stream disconnected before completion`. An HTTP 429 is not retried at all.

Chat2API therefore reports retryable Responses failures in that shape and
keeps the provider's code in `upstream_code`:

```json
{"code": "rate_limit_exceeded", "upstream_code": "qwen_ai_content_verdict",
 "message": "... Please try again in 60s.", "retry_after_seconds": 60}
```

Set `CHAT2API_RESPONSES_PACED_FAILURE_CODE=off` to keep provider codes.

For Qwen AI content verdicts the proxy first retries the same request in place
(`CHAT2API_QWEN_AI_VERDICT_PACED_RETRIES`, default 2, 60 s then 120 s). A single
request can therefore take several minutes before Codex shows
`Reconnecting... n/5`; that is expected, not a hang.

If one request keeps failing with `qwen_ai_content_verdict` after every retry
while other requests succeed, the upstream is judging that transcript. Retrying
cannot pass it; send a different message (or start a new session) so the
payload changes.
