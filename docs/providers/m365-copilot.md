# M365 Copilot

| Item | Value |
| --- | --- |
| Provider ID | `m365-copilot` |
| Website | https://m365.cloud.microsoft/chat |
| API base | `wss://substrate.office.com/m365Copilot/Chathub` (SignalR WebSocket) |
| Authentication | OAuth2 PKCE refresh token (officeweb client) |

Microsoft 365 Copilot is adapted through the same substrate Chathub protocol
the m365.cloud.microsoft web client uses. Each account opens its own
WebSocket per request, so accounts load-balance without a browser bridge.

## Default models

| Public model key | Notes |
| --- | --- |
| `gpt-5.6-sol` | Equivalent aliases; the ChatHub consumer payload carries no |
| `gpt-5.6-terra` | model selector, so the upstream Copilot service decides the |
| `gpt-5.6-luna` | actual backend model for every alias. |

## Authentication

Personal Microsoft accounts (consumer MSA) use the in-app **browser login**
in the account dialog:

1. Click **浏览器登录** (browser login). Chat2API starts a PKCE session with
   the officeweb client (`c0ab8ce9-…`) and the full sydney v2 permission set,
   then opens the Microsoft sign-in page.
2. Sign in and pick the account. The flow lands on
   `login.live.com/oauth20_desktop.srf?code=…` — the code stays visible in
   the address bar (the "page not normally shown" notice is expected; it is
   Microsoft's anti-phishing banner for desktop redirect targets).
3. Copy the full address-bar URL back into the dialog and click **完成登录**.
   The access token, refresh token, object ID (home PUID), and tenant ID are
   filled automatically.
4. Click **添加账户**.

Device-code login is not available for personal accounts: the officeweb
client is not a device-flow client (AADSTS70002), and legacy clients that do
support device flow cannot mint substrate tokens.

Work/school accounts use the commercial Chathub variant with their own
configured client and scopes.

## Token lifecycle

- Access tokens are refreshed automatically before expiry, and once more on
  an in-flight 401.
- Consumer refreshes must redeem against the officeweb client with the full
  sydney v2 scope set **without an `Origin` header** (any origin header makes
  MSA answer AADSTS90023 for this client).
- Rotated refresh tokens are persisted to the encrypted store; concurrent
  requests share one in-flight refresh per token.

## Conversation history

The Chathub backend persists conversations server-side. They appear in the
account's sidebar at `m365.cloud.microsoft/chat` — not at
`copilot.microsoft.com`; Microsoft keeps the two surfaces' histories
separate even for the same account.

## Tool calling

M365 has **no native caller-defined tool channel**: the consumer invocation
carries one free-text field (`message.text`) plus backend plugins. Every
declared tool is therefore taught as a **fenced protocol** — a Markdown code
fence whose info-string is the tool name (`m365_fenced`, implemented in
`src/main/proxy/toolCalling/protocols/m365Fenced.ts`).

Five controls make the model comply. Each is listed with the measured reason
it exists, because removing one regresses compliance rather than failing
loudly.

| Control | Where | Why |
| --- | --- | --- |
| Strip the code-interpreter option sets on tool-bearing turns | `chathub/client.ts` | With M365's own sandbox enabled it answers file/command requests itself, so the caller's tool call is never produced and the protocol looks "ignored". M365Bridge TOOL-CALLING.md calls this "essential", not an optimisation. |
| Strip an invented `<tool_response>` instead of failing the request | `ToolStreamParser` / `ToolCallingEngine` | This model keeps writing after its own call and fabricates the result it expects, then acts on the fiction (cramt #31: 38 of 80 Sonnet 4.6 turns). The real call sits at the head of the text; failing the request throws it away. |
| Keep only the first fence per turn | `m365Fenced.parse` | The model batches its whole plan into one reply and narrates results for steps it never ran; later steps then execute on guessed state (cramt "One call per turn"). |
| Drop mixed prose when a call was emitted | `m365Fenced.parse` + forwarder | "Let me check…" before the fence and "All done!" after it were written before any result existed. The client gets the tool call alone. |
| Label each result with the call that produced it | `m365Fenced.formatToolResult` | An unlabelled result is read as "whatever step this was": observed live, a directory listing was mistaken for an empty file (cramt F16). |
| M365-scoped denial wording table | `adapters/m365ToolDenial.ts` | This backend's denials have their own vocabulary. The shared table is used by zai, qwen-ai and mimo, whose measured wordings are unrelated, so the extras live here and widen detection for M365 only. |

### Scoping rule for this provider

Every shared file this work touches is inert for every other provider, and the
rule is pinned by tests rather than asserted in prose:

| Shared surface | How it stays inert |
| --- | --- |
| `ToolStreamParser` new `stripOnlyToolResultWrappers` option | Off by default; only the M365 forwarder passes it |
| `ManagedToolResultGuard` attributed-opener recognition | Off by default (`attributedResultOpeners`); only the m365_fenced result block is attributed, so only M365 opts in |
| `ToolCallingEngine.applyNonStreamResponse` | Reads a provider-profile flag that is set only for `m365-copilot`; `stripOnly` stays false elsewhere |
| `classifyZaiManagedAnswer` marker gate | Delegates to a leaf that returns `deliver` for every protocol except `m365_fenced`, so the early return is preserved elsewhere |
| `qwenAiProgressIntent` denial table | **Unchanged.** M365's extra wordings live in `adapters/m365ToolDenial.ts` |
| `providerProfiles` new flag | Optional field, set only for `m365-copilot` |

`CHAT2API_QWEN_AI_TOOL_DENIAL_PATTERNS` keeps its documented meaning in the
M365 detector: an explicit value replaces the table outright, extras included.

A non-compliant turn (prose, capability denial, false completion claim) is
re-prompted through the fresh-conversation replay in `forwardM365Copilot`,
bounded by `CHAT2API_M365_WORKFLOW_CONTINUATION_ATTEMPTS` and
`CHAT2API_M365_WORKFLOW_CONTINUATION_TIMEOUT_MS`. Set
`CHAT2API_M365_DEBUG_STREAM=1` to log raw branch text while diagnosing.

### Route B: a Copilot Studio agent (implemented, blocked on this account type)

The measurements above say the per-request prompt is not the lever. cramt
identifies what is: the tool contract has to arrive as a **server-side system
prompt**, delivered by a Copilot Studio agent.

> with prompt-injection alone, M365 **ignores the instructions and answers in
> prose, or hallucinates tool results**. The thing that actually makes it comply
> is a server-side system prompt, delivered via a Copilot Studio agent.
> — cramt/m365-copilot-proxy, `docs/m365-copilot-api.md` §10

> the JSON *format* (bare vs ` ```json ` vs ` ```tool_call `) barely matters —
> all ~3/3 compliant **with the agent on**. **The agent is the lever, not the
> syntax.**

Implemented in `src/main/providers/builtin/m365/agent/`:

| File | Role |
| --- | --- |
| `agentIdentity.ts` | Pure: the server-side instructions, the name/versioning hash, the two-label Power Platform host derivation, the agent id, the `threadLevelGptId` / `gpts` wire fields |
| `agentProvisioner.ts` | Network: BAP environment discovery, `minimalBots` create, publish, id cache |

Wire shape (the agent fields are what route the turn; `plugins` stays):

```json
"threadLevelGptId": { "id": "<agentId>", "source": "MOS3" },
"gpts": [{ "id": "<agentId>", "source": "MOS3", "version": "1.0.0", ... }]
```

Three properties that are load-bearing, all pinned by
`tests/server/m365-studio-agent.test.ts`:

- **Off by default** (`CHAT2API_M365_STUDIO_AGENT`), because provisioning
  *creates an agent in the tenant*.
- **Only attached to tool-bearing turns.** Measured: the declarative agent
  **overrides the tone and forces GPT-5**, so a non-default tone would silently
  change model on a plain chat turn.
- **Fail-safe.** Any failure — off, no consent, provisioning error — returns
  null and the turn proceeds on the fenced protocol. Verified live: with the
  flag on and no consent, M365 behaves identically to flag-off and the request
  still fails the same way.

Agent versioning: instructions are baked in at create and the update API needs a
`changeToken` that only create returns, so the agent is versioned **by name** —
`m365-tool-agent-<first 8 hex of sha256(instructions)>`. Editing the
instructions provisions a fresh agent; stale ones are never deleted, because a
second proxy sharing the tenant may still hold a conversation with one.

#### Blocker on THIS account type (measured 2026-09-30)

The provisioned accounts are **personal Microsoft accounts (consumer MSA)**, and
the consumer client cannot request the environment-discovery scope at all:

```
AADSTS70011: The scope 'https://api.bap.microsoft.com/.default' does not exist.
```

This is not a consent that can be granted to fix it — the scope is not offered
to that app id. So on a consumer pool this route cannot be made to work with the
officeweb/ChatHub client the provider authenticates with. It needs a
**work/school** account, whose app registration exposes the Power Platform and
BAP scopes, plus tenant consent to both.

Until such an account exists, `CHAT2API_M365_STUDIO_AGENT` must stay `off`.
The fenced protocol plus the confabulation/empty-response guards above is what
currently protects tool-bearing turns — it makes them fail loudly instead of
delivering a fabrication, but at this compliance rate it cannot make them
call tools reliably.

### Measured on this tenant (2026-09-29, 25-account MSA pool, gpt-5.6-sol)

Prompt hardening and confabulation detection are **not** what makes this
backend comply. Measured with a single-turn `read_file` request, 4 requests,
`CHAT2API_M365_DEBUG_STREAM=1`:

| Turn | Model output | Delivered as |
| --- | --- | --- |
| before | "The file `/etc/hostname` contains: " (no call) | prose answer |
| before | "`uname -a` returned: Kernel version: **6.1.158.2**" | invented result |
| after | 4/4 rounds exhausted, `m365_workflow_recovery_exhausted` | typed error |

**Tool-call compliance on this pool is very low, not zero.** Across ~40
measured tool turns the fenced protocol produced **one** compliant turn (a
`bash` `cat /etc/hostname` call, on the fenced path with no agent attached).
Every other turn was a capability denial ("I don't have access to your local
filesystem") or a fabricated payload:

```
The file `/etc/hostname` contains:

```text
SandboxHost-639262996218002518
```
```

The `bash` fence it volunteers is rejected as an undeclared name, which is
correct: routing it would require the client to have declared a shell tool.
Adding a declared `shell` tool did not change the outcome (measured), so this
is not the shell-routing gap.

What this means: per-request prompt injection is **not authoritative** for this
backend. That matches cramt's own finding — it ranks a Copilot Studio agent
carrying the instructions in its server-side system prompt as "the most
important layer", and reports that without one, M365 ignores the per-request
injection and answers in prose or hallucinates. See "Route B" above for that
implementation and for the scope blocker that keeps it off on a consumer pool.

### Failure contract (this is what the fix delivers)

A non-compliant turn never reaches the client as an answer. It is re-prompted
up to the limit and then fails with a typed, retryable error
(`m365_workflow_recovery_exhausted`), which the Responses translator renders as
`response.failed` so codex-class clients discard the turn and retry on another
account. An empty turn is likewise never returned as a success:
`m365_empty_answer` (stream) and a 502 (non-stream). Measured 4/4 loud
failures, 0 confabulations delivered, 0 empty successes.

Two subtleties the live text exposed, both now covered by tests:

- **The completion marker is not proof of work.** The model appends it to a
  fabrication (`... contains: \n\n```text\n<value>\n```\n\n<marker>`), which
  satisfied the marker gate and reached the first-turn auto-answer fall-through.
  The gate now re-examines a marked answer for confabulation signals first
  (`managedMarkerConfabulation.ts`), and the checks run on the marker-**stripped**
  text — the raw text ends in `/>`, not `:`, so the colon signal cannot match
  otherwise.
- **Denial phrasings are per-tenant and endless.** Every wording the pool
  produced on 2026-09-29 is in `adapters/m365ToolDenial.ts` and in the tests.
  The shared table is shared with zai, qwen-ai and mimo, so it is left alone and
  the M365 vocabulary is layered on top; `CHAT2API_QWEN_AI_TOOL_DENIAL_PATTERNS`
  still replaces the whole table when set.

### Known unused approaches

- **A Copilot Studio agent carrying the instructions server-side.** Implemented
  (see "Route B" above) and measured as the only lever that moves compliance —
  but blocked on this account type: the consumer MSA client is refused the BAP
  scope outright (AADSTS70011), so it needs a work/school account. M365Bridge
  independently rejects agent provisioning and ships stateless.
- **Native `plugins: [{Id, Source: "API"}]` on the wire.** The two highest-
  starred implementations (HEXUXIU/M365-Copilot2API, shenping1200/m365-copilot-bridge)
  do send caller tools that way and read real tool calls back out of the
  stream frames; both then **skip the prompt injection entirely** when plugins
  are present. This repo stays on the fenced path, so treat the two as
  unverified against this account shape rather than as a known equivalent.
  `CHAT2API_M365_DEBUG_STREAM=1` plus the raw branch log is the way to tell
  which one the tenant actually honours.

## Environment overrides

| Variable | Purpose |
| --- | --- |
| `CHAT2API_M365_MANAGED_TONE` | Tone used for managed-tool turns (default `Assist`; `Magic` confabulates) |
| `CHAT2API_M365_TOOL_OPTION_SET_STRIP` | `off` keeps M365's code-interpreter option sets on tool-bearing turns |
| `CHAT2API_M365_MAX_TOOL_CALLS_PER_TURN` | Fenced calls accepted per turn (default `1`) |
| `CHAT2API_M365_WORKFLOW_CONTINUATION_ATTEMPTS` | Re-prompts for a non-compliant managed turn (`auto` = 1, `0` disables) |
| `CHAT2API_M365_WORKFLOW_CONTINUATION_TIMEOUT_MS` | Wall-clock budget across continuation rounds (default 180000) |
| `CHAT2API_M365_DEBUG_STREAM` | `1` logs raw branch text for non-compliant turns |
| `CHAT2API_M365_STUDIO_AGENT` | `on` provisions and references a Copilot Studio agent for tool turns. Requires a work/school account; refused on consumer MSA (see Route B) |
| `CHAT2API_QWEN_AI_TOOL_DENIAL_PATTERNS` | Replace the capability-denial pattern table (this backend's denial wordings are per-tenant; see the measured section) |
| `M365_CONSUMER_REFRESH_CLIENT` | Override the client id used for consumer token refresh |
| `M365_CONSUMER_REFRESH_SCOPE` | Override the consumer refresh scope |
| `M365_TIME_ZONE` | Time zone sent in chat message metadata |
| `M365_BROWSER_CLIENT_ID` / `M365_BROWSER_REDIRECT_URI` / `M365_BROWSER_SCOPE` | Work/school login parameters |

## Tutorial

1. Open **Providers**, add **Microsoft 365 Copilot**, then open its account
   dialog.
2. Choose **个人** (personal), click **浏览器登录**, sign in with the target
   Microsoft account, paste the redirect URL, and add the account.
3. Repeat per account; active accounts enter the configured routing
   strategy automatically.
4. Verify with an OpenAI-compatible call:

```bash
curl -N -X POST "http://127.0.0.1:8080/v1/chat/completions" \
  -H "Authorization: Bearer <chat2api-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-sol","stream":true,"messages":[{"role":"user","content":"Hello"}]}'
```
