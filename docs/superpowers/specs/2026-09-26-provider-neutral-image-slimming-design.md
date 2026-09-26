# Provider-Neutral Image Slimming Design

> Status: design approved, not implemented.
> Related: [`docs/superpowers/specs/2026-09-26-upstream-compression-backends-design.md`](./2026-09-26-upstream-compression-backends-design.md) (text compression), [`src/main/proxy/replayImageSlimming.ts`](../../src/main/proxy/replayImageSlimming.ts) (the existing Qwen-scoped implementation).

## Background

`src/main/proxy/replayImageSlimming.ts` already replaces old inline images in a replayed conversation with a text placeholder. It works. It is also scoped to exactly one provider, and the corpus built for the text-compression plan shows that scoping is where nearly all of the remaining token budget lives.

From `codex-replay-payload.json`, a real 435-item Codex Responses replay, 181 `function_call_output` items, 787,376 estimated input tokens:

| Segment | Tool outputs | Estimated tokens | Share |
| --- | ---: | ---: | ---: |
| Contain an inline base64 image | 17 (9.4%) | 714,462 | **90.7%** |
| Text only | 164 (90.6%) | 72,914 | 9.3% |

The five largest single tool outputs are 196–222 KB each and consist entirely of `[{"type":"input_image","image_url":"data:image/png;base64,..."}]`.

The text-compression plan addresses the 9.3%. This document addresses the 90.7%. They are independent and both are needed; they share no code and share no risk.

## Can It Be Generalized?

Yes, and more cheaply than expected. The existing implementation is already provider-neutral in substance; only its call site is not.

`slimQwenAiReplayImages` takes `readonly ChatMessage[]` and:

- recognizes the three standard image part types — `image_url`, `input_image`, `image` — which are the OpenAI Chat, OpenAI Responses, and legacy shapes respectively;
- replaces each with `{ type: 'text', text: placeholder }`, itself a standard content part;
- preserves role, `tool_call_id`, ordering, and every non-image part;
- returns new objects throughout and mutates nothing.

Nothing in that function knows what a provider is. The Qwen scoping lives entirely in two call sites:

`src/main/proxy/routes/chat.ts:673-676`
```ts
const requestForAttempt = QwenAiAdapter.isQwenAiProvider(selection.provider)
    && shouldSlimQwenAiAttemptImages(imageSlimMode, slimImagesOnNextAttempt)
  ? { ...request, messages: slimQwenAiReplayImages(request.messages) }
  : request
```

`src/main/proxy/routes/responses.ts:1483-1487` carries the same shape.

So the work is not "port a compressor to seven providers". It is deciding the policy the Qwen-only build never had to answer.

## Why It Was Scoped to Qwen

Three reasons, and each one still matters.

**1. The reactive trigger is Qwen-specific.** `on-busy` mode exists because a long tool session re-uploads every embedded image with the transcript, and each upload costs one `getstsToken` call against a per-minute quota, after which the upstream risk page rejects the request. That is a Qwen Web transport property. DeepSeek has no equivalent, so `on-busy` does not transfer and must not be reused as the generic trigger.

**2. The keep-set heuristic came from Qwen traffic.** The default `KEEP_FIRST=0, KEEP_LAST=1` was derived from observed Codex visual-iteration sessions on Qwen, where the earliest attachment is the ground-truth reference and the newest is the working render. That reasoning is about the client's behavior, not the provider's, so it should hold elsewhere — but it was never validated anywhere else, and the defaults are aggressive enough to need per-provider confirmation.

**3. The evidence for the need is per-provider.** 90.7% is a measurement of one replay to one provider. Whether a GLM or M365 session carries the same shape is unmeasured.

## Goals

1. Make image slimming available to every provider, not only Qwen AI, without changing Qwen's current behavior.
2. Keep the decision provider-aware: never slim for a provider or model that cannot consume images, and never slim a request that carries no inline image.
3. Make the policy configurable per provider with safe defaults, and keep the existing Qwen environment variables working unchanged.
4. Report what slimming saved, in the same terms as the text optimizer's measurement.

## Non-Goals

- Do not change the placeholder text semantics. The existing placeholder already tells the model how to recover the image ("view it again with your image tool"), and that instruction is the reason slimming is survivable.
- Do not touch `file` parts, only `image_url` / `input_image` / `image`. User document attachments go through provider-specific upload paths (`qwen-ai-files.ts`, `zai-files.ts`, `mimo-files.ts`) and are not in scope.
- Do not fold this into the text-compression plan. It is a different layer with a different risk profile and a different measurement, and merging them would put base64 handling behind the backend abstraction where it does not belong.
- Do not change the Qwen reactive path. `on-busy` is a Qwen transport defense and stays exactly as it is.

## Current State

| Fact | Evidence |
| --- | --- |
| 5 adapters transport images | `glm.ts:268-284`, `qwen-ai.ts` / `qwen-ai-files.ts`, `zai-files.ts:251-258` and `:311-315`, `mimo-files.ts:192-199`, `m365.ts:388-392` |
| 2 adapters mention `image_url` but never transport it | `kimi.ts:628` and `minimax.ts:514` use it only to pick a focus system message |
| 3 adapters have no image handling at all | `deepseek.ts`, `perplexity.ts`, `qwen.ts` |
| No vision capability flag existed | `ProviderModelCapability` in `src/shared/types.ts:214-220` carried `thinkingSkippable`, `maxContextLength`, `maxSummaryGenerationLength` and nothing about images |
| Existing tests are provider-agnostic | `tests/server/replay-slimming-and-busy-cap.test.ts` tests the function directly with no provider setup |
| Compose passthrough exists, Qwen-named | `docker-compose.yml:319,330-332` |

**Correction to the first draft of this document.** Its table was built from a grep count and listed Kimi and MiniMax as `true`. Both are `false`. Each of those adapters has exactly one `image_url` reference and neither ever uploads the image; the reference only selects a focus system message. That is the concrete case the "a grep count is a starting point, not evidence" rule exists for, and it is why the implemented table cites adapter line numbers instead.

The missing capability flag was the real prerequisite, and it is now implemented: `ProviderModelCapability.vision`, per-adapter defaults in `src/main/proxy/imageSlimPolicy.ts`, and a test per provider that fails if the adapter source drifts away from the declared default.

## Recommended Approach

Separate the three concerns that are currently one function.

```
policy resolution  ──>  which requests may be slimmed, and how aggressively
slimming transform ──>  the existing pure message rewrite (unchanged)
trigger             ──>  why this attempt is slimmed (Qwen busy vs proactive)
```

Keep `slimQwenAiReplayImages` as the transform, unchanged. Add a policy resolver and a provider-neutral proactive trigger around it.

### 1. Add a vision capability signal

```ts
// src/shared/types.ts
export interface ProviderModelCapability {
  thinkingSkippable?: boolean
  maxContextLength?: number
  maxSummaryGenerationLength?: number
  /** Provider accepts inline image content parts for this model. */
  vision?: boolean
}
```

Default resolution, in priority order:

1. `provider.modelCapabilities[actualModel].vision`
2. a per-provider default table in the policy module
3. `false`

The table is implemented in `VISION_PROVIDER_DEFAULTS` and pinned per provider in `tests/server/image-slim-capability.test.ts`:

| Provider id | Adapter evidence | Default |
| --- | --- | --- |
| `qwen-ai` | `qwen-ai.ts` / `qwen-ai-files.ts` upload image refs | `true` |
| `glm` | `glm.ts:268-284` collects `image_url` into image refs | `true` |
| `zai` | `zai-files.ts:251-258` decodes data URLs; `:311-315` selects parts for upload | `true` |
| `mimo` | `mimo-files.ts:192-199` converts to `kind: 'image'` | `true` |
| `m365-copilot` | `m365.ts:388-392` maps to an image attachment | `true` |
| `kimi` | `kimi.ts:628` focus hint only, no transport | `false` |
| `minimax` | `minimax.ts:514` focus hint only, no transport | `false` |
| `qwen`, `deepseek`, `perplexity` | no image handling | `false` |
| anything else | — | `false`, logged once per process |

The flag describes Chat2API's adapter, not the vendor's API. A provider whose public API accepts images but whose adapter never uploads them is `false` here, because the only thing the flag gates is image slimming, and slimming a request whose images were already being dropped upstream would be measuring the wrong thing.

### 2. Split the trigger

| Trigger | Applies to | Keep as-is |
| --- | --- | --- |
| `on-busy` — react to `qwen_ai_upstream_busy` | Qwen AI only | Yes. Qwen STS quota defense. |
| `always` — slim proactively, first attempt included | Provider-neutral, new | Generalized from the existing Qwen-only behavior. |
| `off` | — | Yes. |

The Qwen env var keeps its current three-way meaning. A new provider-neutral var governs the other providers.

### 3. Precedence and back-compat

```bash
# Existing, unchanged meaning, Qwen only
CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES=off|on-busy|always
CHAT2API_QWEN_AI_REPLAY_KEEP_LAST_IMAGE_MESSAGES=1
CHAT2API_QWEN_AI_REPLAY_KEEP_FIRST_IMAGE_MESSAGES=0
CHAT2API_QWEN_AI_REPLAY_IMAGE_PLACEHOLDER=

# New, provider-neutral
CHAT2API_REPLAY_SLIM_IMAGES=off|on-busy|always          # default: off
CHAT2API_REPLAY_SLIM_PROVIDERS=                         # default: empty = all vision providers
CHAT2API_REPLAY_SLIM_MODELS=                            # default: empty = all
CHAT2API_REPLAY_KEEP_LAST_IMAGE_MESSAGES=               # unset -> fall back to the Qwen value
CHAT2API_REPLAY_KEEP_FIRST_IMAGE_MESSAGES=
CHAT2API_REPLAY_IMAGE_PLACEHOLDER=                      # unset -> fall back to the Qwen value
```

Resolution rules, in order:

1. For Qwen AI, `CHAT2API_QWEN_AI_REPLAY_*` wins outright. A Qwen deployment's behavior must not change because a new variable was added.
2. For every other provider, the `CHAT2API_REPLAY_*` variables apply.
3. When a `CHAT2API_REPLAY_*` variable is unset, fall back to its `CHAT2API_QWEN_AI_REPLAY_*` counterpart, so a deployment that already tuned keep-counts gets the same numbers everywhere.
4. `CHAT2API_REPLAY_SLIM_IMAGES` defaults to `off`. Defaulting a lossy behavior on for eight providers is not defensible from a single replay measurement.

Every parser is total and every unknown value falls back, matching `qwenAiImageSlimModeFromEnv`.

### 4. Policy object

```ts
export interface ImageSlimPolicy {
  enabled: boolean
  keepFirstImageMessages: number
  keepLastImageMessages: number
  placeholder: string
  /** Why this request is being slimmed, for the log line. */
  reason: 'qwen-busy' | 'proactive'
}

export function resolveImageSlimPolicy(input: {
  provider: Provider
  actualModel: string
  mode: ImageSlimMode
  afterBusyRejection: boolean
}): ImageSlimPolicy | undefined
```

Returns `undefined` when the request must not be slimmed: mode `off`, unknown provider, model without vision, or the provider is excluded by `CHAT2API_REPLAY_SLIM_PROVIDERS`. An explicit `undefined` is better than an `enabled: false` policy that a call site could ignore.

### 5. The live turn is never slimmed

A placeholder is a downgrade, so the newest image-bearing message must survive unless it is already inside the keep set. The existing `keepLast` default of 1 covers this, but the guarantee deserves to be explicit rather than incidental: the most recent image-bearing message index is always in the keep set, regardless of configuration. A `keepLast: 0` configuration that would slim the current turn's reference image is a configuration error, and the resolver clamps to 1 and logs.

This is a behavior change to the transform's contract, so it goes in with a test that pins it.

### 6. Placement

Slimming runs in the routes, before `forwardChatCompletion`, exactly where it runs today. It does not move into the forwarder or the optimizer:

- the routes already own failover triggers, and `on-busy` needs the per-attempt signal only they have;
- the forwarder's optimizer deals in prompt text and routes messages through a backend abstraction that has no representation for a content part;
- the request log and the upstream payload should agree, and they will if both transformations happen before the log write.

### 7. Measurement

Extend the existing log rather than adding a new one. The routes already log around the failover decision; add:

```
imageSlimApplied, imageSlimReason, imageSlimKeepFirst, imageSlimKeepLast
imageMessagesSlimmed, imagePartsSlimmed, imageCharsSlimmed
```

`imageCharsSlimmed` is the number that matters. It converts directly into the token estimate the routes already record via `estimateQwenAiRequestInputTokens`, so a before/after comparison lands in the same units as the text optimizer's `estimatedSaved` and the two can be added together.

The logs are additive, so existing consumers keep working.

## Distribution Support Matrix

| Aspect | Electron desktop | Docker server | Note |
| --- | --- | --- | --- |
| Transform | Shared code | Shared code | Already provider-neutral |
| Policy resolution | Shared code | Shared code | `modelCapabilities` comes from the store, present in both |
| Env | `process.env` | `process.env` + compose passthrough | Add the new vars to `docker-compose.yml` |
| Capability table | Shared code | Shared code | One table, both targets |
| Network | none added | none added | No hosted service, no model download |

Nothing in this design requires a new dependency, a new runtime, a new build target, or a change to either packaging pipeline. That is the main reason to keep it separate from the compression plan rather than folding it in: the compression plan adds a WASM artifact and a Python sidecar, and this design needs neither.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| The model loses visual access to an image it could previously see | The placeholder states how to recover it. The keep set retains the earliest and newest attachments. Defaults are `keepFirst=0, keepLast=1`, and `keepLast` is clamped to at least 1. |
| A deployment enables this and does not notice | `imageCharsSlimmed` is logged per request and lands in the same units as the existing token estimate, so the effect is visible without reading raw payloads. Default is `off`. |
| The vision capability table is wrong for a provider | Every entry is pinned by a test against the adapter's actual handling. An unlisted provider is treated as `false` and logs once. |
| A provider rejects a `text` part where an image was | `{ type: 'text', text }` is a standard content part in all three shapes, but this is verified per adapter as part of the capability work, not assumed. |
| Renaming env variables breaks deployments | Qwen variables keep their exact meaning and win for Qwen. The new variables are additive and default to `off`. |
| The corpus measurement does not generalize from one provider | Documented as a single measurement. The `--stats` output makes the local number reproducible; the per-provider decision is the log line from real traffic, not this document. |

## Testing

Unit:

- `resolveImageSlimPolicy` — mode parsing, provider allowlist, model allowlist, vision lookup including the three-level fallback, `undefined` on every disqualifier.
- Precedence — a Qwen deployment with both variable families set behaves exactly as before; a non-Qwen provider with only the new variables set uses them; a non-Qwen provider with neither is `off`.
- Transform — the existing `tests/server/replay-slimming-and-busy-cap.test.ts` suite, plus the new guarantee that the newest image-bearing message survives `keepLast: 0`.
- Capability table — one test per provider asserting the declared default matches the adapter.

Integration:

- The route-level assertion already in `replay-slimming-and-busy-cap.test.ts:333` ("both failover routes consult the slim mode on every attempt") extends to the provider-neutral trigger.
- A test that a non-vision provider with `CHAT2API_REPLAY_SLIM_IMAGES=always` produces a byte-identical request to mode `off`.

Acceptance:

- On a real image-bearing replay, `imageCharsSlimmed` accounts for the expected share of the reduction, and the routes' `estimatedInputTokens` drops correspondingly.
- Task-success rate unchanged on a visual-iteration task set, measured the same way the text-compression plan measures it.
- Tool-call schema success stays at 100%.

## Upstream Sync Policy

New, Chat2API-owned:

```text
src/main/proxy/imageSlimPolicy.ts
tests/server/image-slim-policy.test.mjs
```

Small edits to upstream-owned files:

```text
src/main/proxy/replayImageSlimming.ts     # keep-newest guarantee, rename internals
src/main/proxy/routes/chat.ts             # provider-neutral trigger
src/main/proxy/routes/responses.ts        # provider-neutral trigger
src/shared/types.ts                       # ProviderModelCapability.vision
docker-compose.yml                        # new env passthrough
docs/docker.md                            # document the new variables
```

Leave alone:

```text
src/main/proxy/adapters/*.ts              # no adapter logic changes
```

## Open Questions

1. Should `CHAT2API_REPLAY_SLIM_PROVIDERS` default to empty (all vision providers, gated only by `CHAT2API_REPLAY_SLIM_IMAGES`) or to an explicit allowlist? Default: empty. An explicit list is safer but makes the feature unusable until someone enumerates providers, and the mode switch already defaults to `off`.
2. Is `keepFirst=0` right for non-Qwen providers? The Qwen default assumes the earliest attachment is a ground-truth reference. If another provider's traffic is single-shot (one image, no iteration), `keepFirst=0` is exactly right and `keepLast=1` is the whole policy. Default: keep the Qwen numbers and revisit when per-provider logs exist.
3. Should the placeholder name a provider-specific recovery tool? The current text says "your image tool", which assumes a vision tool exists in the client's tool set. Default: keep it generic, since Chat2API does not control the client's tool inventory.
