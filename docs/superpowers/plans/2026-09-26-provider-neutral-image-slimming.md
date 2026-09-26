# Provider-Neutral Image Slimming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing replay image slimming available to every vision-capable provider, not only Qwen AI, with a capability signal, an explicit keep policy, and measurement, while leaving Qwen's current behavior byte-identical.

**Architecture:** Split the three concerns that are currently one function. The message rewrite (`slimQwenAiReplayImages`) stays as it is and is already provider-neutral. A new policy resolver answers "may this request be slimmed, and how aggressively", and a provider-neutral proactive trigger joins the existing Qwen-only reactive one. Nothing moves out of the routes, because `on-busy` needs the per-attempt signal only the failover loops have.

**Tech Stack:** TypeScript, Node.js, Koa, existing Chat2API proxy modules, Node test runner. No new dependency, no new runtime, no new build target.

**Design:** [`docs/superpowers/specs/2026-09-26-provider-neutral-image-slimming-design.md`](../specs/2026-09-26-provider-neutral-image-slimming-design.md)

**Track:** Independent of the text-compression plan. Runs in parallel, shares no code with it, and must not be merged into it. Its measurement is what the text plan's acceptance gates compare against.

**Status:** Phase 0-6 complete. Live-validated against a real container:
20/20 feature checks and 8 passed / 0 failed / 7 blocked-by-upstream on the
default-off path. Results and the three defects only a live run could find are in
[`2026-09-26-image-slimming-acceptance.md`](./2026-09-26-image-slimming-acceptance.md).

---

## Critical Constraints

1. **Qwen behavior must not change.** A Qwen deployment's behavior must be identical after this work, whether or not any new environment variable is set. The `CHAT2API_QWEN_AI_REPLAY_*` family keeps its exact meaning and wins outright for Qwen.
2. **The new provider-neutral mode defaults to `off`.** Defaulting a lossy behavior on for eight providers is not defensible from a single replay measurement.
3. **A provider or model not known to consume images is never slimmed.** The capability lookup fails closed, and an unlisted provider logs once per process.
4. **The newest image-bearing message is never slimmed.** A placeholder is a downgrade; the current turn's reference image must survive. `keepLast` is clamped to at least 1 and the clamp is logged.
5. **`file` parts are out of scope.** Only `image_url`, `input_image`, and `image` are touched. User document attachments go through provider-specific upload paths and are not image parts.
6. **The transform stays pure.** It must keep returning new objects, mutating nothing, preserving role, `tool_call_id`, ordering, and every non-image part.

---

## Upstream Sync Policy

New, Chat2API-owned:

```text
src/main/proxy/imageSlimPolicy.ts
tests/server/image-slim-policy.test.ts
```

Small edits to upstream-owned files:

```text
src/main/proxy/replayImageSlimming.ts   # keep-newest guarantee, shared internals
src/main/proxy/routes/chat.ts            # provider-neutral trigger
src/main/proxy/routes/responses.ts       # provider-neutral trigger
src/shared/types.ts                      # ProviderModelCapability.vision
docker-compose.yml                       # new env passthrough
docs/docker.md                           # document the new variables
```

Leave alone:

```text
src/main/proxy/adapters/*.ts             # no adapter logic changes
src/main/proxy/services/*.ts             # the text-compression track owns these
```

After pulling upstream:

```bash
npm install
npm run test:server-compat
npm run build:server
docker build -t chat2api:server .
```

---

## File Structure

Create:

```text
src/main/proxy/imageSlimPolicy.ts
tests/server/image-slim-policy.test.ts
tests/server/image-slim-capability.test.ts
```

Modify:

```text
src/main/proxy/replayImageSlimming.ts
src/main/proxy/routes/chat.ts
src/main/proxy/routes/responses.ts
src/shared/types.ts
docker-compose.yml
docs/docker.md
```

Keep and extend:

```text
tests/server/replay-slimming-and-busy-cap.test.ts
```

---

## Phase 0: Guardrails

### Task 0.1: Freeze Qwen's current behavior

**Files:**
- Create: `tests/server/image-slim-policy.test.ts`

DONE. `tests/server/image-slim-policy.test.ts` — 11 tests, green against unchanged source.

- [x] **Step 1: Characterize the current Qwen behavior**

The first draft of this task said to assert `resolveImageSlimPolicy` against the current pair. That was wrong: `resolveImageSlimPolicy` is a Phase 2 function, so a Phase 0 test for it cannot pass. The task now characterizes the functions that exist today, which is what a guardrail has to do.

Covered: mode parsing including the `on-busy` default and unknown-value fallback; the full six-cell trigger matrix; the transform's keep-newest behavior, its no-op under `off`, its non-mutation of the input array, and its preservation of `tool_call_id` and ordering; both keep counts; and the default `first=0 last=1`.

- [x] **Step 2: Pin that the new variable family is inert today**

A test asserts `CHAT2API_REPLAY_SLIM_IMAGES=always` does not affect the Qwen path, which still reads only the Qwen variable. Without it, a later edit that made the transform read the new family early would go unnoticed.

- [x] **Step 3: Run the existing suite unchanged**

```bash
node --test tests/server/replay-slimming-and-busy-cap.test.ts
```

15 pass. The new file adds 11 more on top.

### Task 0.2: Pin the corpus measurement

**Files:**
- Create: `tests/server/image-slim-capability.test.ts`

DONE. `tests/server/image-slim-capability.test.ts`.

- [x] **Step 1: Assert the 90.7% figure**

**The first draft of this task was wrong and its test failed at 0.1%.** It computed the share from the committed corpus, which cannot produce it, for two independent reasons:

1. `chars` on each fixture is recorded *after* redaction, so no fixture retains its original size and the 200 KB payloads left no trace.
2. even the token count collapses, because `redactDataUrls` turns each base64 payload into a ~30-character digest.

The 90.7% is a property of the raw capture. `measureRawCapture()` in `scripts/compress/extract-corpus.mjs` now computes it before redaction, `npm run corpus:stats` reports it, and the test asserts against that: 181 tool outputs, 17 with images, 787,376 total estimated tokens, 714,462 in images.

- [x] **Step 2: Lock in why the corpus cannot be used for this**

A companion test asserts the corpus's own image share stays under 0.2 and that it disagrees with the raw capture by more than an order of magnitude. The next person to try the naive computation gets a clear failure instead of a silently wrong number.

- [x] **Step 3: Keep the tripwire property**

The threshold assertion still exists on the raw measurement and still carries the comment saying it is *expected to go red* when this plan lands. The corpus is a fixed artifact, so the corpus-side number will not move on its own; the raw capture is a local file, so the assertion goes red only if the fixture capture itself is replaced. Update it in the same commit that records the post-rollout measurement.

---

## Phase 1: Vision capability

### Task 1.1: Add the capability field

**Files:**
- Modify: `src/shared/types.ts`

DONE. `src/shared/types.ts`.

- [x] **Step 1: Add `vision` to `ProviderModelCapability`**

```ts
export interface ProviderModelCapability {
  thinkingSkippable?: boolean
  maxContextLength?: number
  maxSummaryGenerationLength?: number
  /**
   * Whether the provider adapter actually forwards inline image content parts
   * for this model.
   *
   * This is a statement about Chat2API's adapter, not about the vendor's API.
   * ...
   */
  vision?: boolean
}
```

Optional, so no existing provider config or stored provider object breaks.

- [x] **Step 2: Confirm both builds tolerate the new field**

`npm run build:server` and `npm run build` both pass. `vite.server.config.ts` treats providers as opaque config, so a type-only addition needed no build change.

### Task 1.2: Provider default table

**Files:**
- Modify: `src/main/proxy/imageSlimPolicy.ts`

DONE. `src/main/proxy/imageSlimPolicy.ts` + `tests/server/image-slim-capability.test.ts`.

- [x] **Step 1: Verify each adapter individually, not by grep**

The seed table in the first draft of this task came from a grep count and got **two of ten wrong**. Kimi and MiniMax each have exactly one `image_url` reference and both are `false`: `kimi.ts:628` and `minimax.ts:514` use it only to pick a focus system message, and neither adapter ever uploads the image. Reading the code found this; counting matches did not.

| Provider id | Adapter evidence | Default |
| --- | --- | --- |
| `qwen-ai` | `qwen-ai.ts` / `qwen-ai-files.ts` upload image refs | `true` |
| `glm` | `glm.ts:268-284` collects `image_url` into image refs | `true` |
| `zai` | `zai-files.ts:251-258` decodes data URLs; `:311-315` selects parts for upload | `true` |
| `mimo` | `mimo-files.ts:192-199` converts to `kind: 'image'` | `true` |
| `m365-copilot` | `m365.ts:388-392` maps to an image attachment | `true` |
| `kimi` | `kimi.ts:628` focus hint only | `false` |
| `minimax` | `minimax.ts:514` focus hint only | `false` |
| `qwen`, `deepseek`, `perplexity` | no image handling | `false` |
| unknown / custom | — | `false`, logged once per process |

Note M365's id is `m365-copilot`, and `m365.ts:92-94` also matches on provider *name*, so a custom provider named `m365` is reachable by the adapter but is not in the table and resolves to `false`. That is the safe direction; noted rather than worked around.

- [x] **Step 2: Implement three-level resolution**

```ts
export function isVisionProvider(provider: Provider, actualModel: string): boolean {
  return provider.modelCapabilities?.[actualModel]?.vision
    ?? VISION_PROVIDER_DEFAULTS[provider.id]
    ?? false
}
```

An unlisted provider resolves to `false` and logs once per process. Custom providers added by a user land in the same bucket, which is the safe direction: a deployment that knows its custom provider handles images sets `modelCapabilities[model].vision` explicitly.

- [x] **Step 3: Run the capability tests**

12 tests, green. Each provider entry is pinned against its adapter source, so if an adapter later gains or loses image transport the test fails and names the file to re-verify. Two of them assert the *absence* of transport code for Kimi and MiniMax, which is the specific regression that the grep-based table would have reintroduced.

---

## Phase 2: Policy resolver

DONE. `src/main/proxy/imageSlimPolicy.ts` + `tests/server/image-slim-precedence.test.ts` (15 tests).
Routing into the routes is Task 4 and is not started.

### Task 2.1: Resolver

**Files:**
- Create: `src/main/proxy/imageSlimPolicy.ts`
- Modify: `tests/server/image-slim-policy.test.ts`

- [x] **Step 1: Write the failing tests**

`resolveImageSlimPolicy` must return `undefined` for every disqualifier, one test each:

- mode `off`
- provider not in `CHAT2API_REPLAY_SLIM_PROVIDERS`
- model not in `CHAT2API_REPLAY_SLIM_MODELS`
- model without vision per Task 1.2
- unknown provider id

And return a policy for each combination of mode, busy flag, provider, and keep counts.

- [x] **Step 2: Implement the types**

```ts
export type ImageSlimMode = 'off' | 'on-busy' | 'always'

export interface ImageSlimPolicy {
  enabled: boolean
  keepFirstImageMessages: number
  keepLastImageMessages: number
  placeholder: string
  reason: 'qwen-busy' | 'proactive'
}

export function resolveImageSlimPolicy(input: {
  provider: Provider
  actualModel: string
  mode: ImageSlimMode
  afterBusyRejection: boolean
}): ImageSlimPolicy | undefined
```

Returning `undefined` rather than `{ enabled: false }` means a call site cannot ignore the answer by forgetting a field.

- [x] **Step 3: Implement mode parsing**

Mirror `qwenAiImageSlimModeFromEnv` exactly: case and whitespace tolerant, unknown values fall back to the safe default. The Qwen parser and the new one must agree on what `off`, `on-busy`, and `always` mean.

- [x] **Step 4: Run the tests**

### Task 2.2: Environment precedence

**Files:**
- Modify: `src/main/proxy/imageSlimPolicy.ts`

- [x] **Step 1: Write the precedence tests**

| Provider | Qwen vars | New vars | Expected |
| --- | --- | --- | --- |
| Qwen AI | set | unset | Qwen values |
| Qwen AI | set | set | Qwen values, new ignored |
| Qwen AI | unset | set | Qwen default, new ignored |
| other | irrelevant | set | new values |
| other | irrelevant | unset | falls back to Qwen-named values |
| other | irrelevant | unset | `off` |

- [x] **Step 2: Implement the resolution order**

1. Qwen AI → `CHAT2API_QWEN_AI_REPLAY_*` wins outright.
2. Other providers → `CHAT2API_REPLAY_*`.
3. An unset `CHAT2API_REPLAY_*` falls back to its `CHAT2API_QWEN_AI_REPLAY_*` counterpart, so a deployment that already tuned keep-counts gets the same numbers everywhere.
4. `CHAT2API_REPLAY_SLIM_IMAGES` itself defaults to `off` with no fallback to the Qwen value. Critical Constraint 2: a Qwen deployment running `on-busy` must not turn on proactive slimming for its other providers as a side effect.

Rule 4 is the one that is easy to get wrong. It has its own named test, `RULE 4: the provider-neutral mode does not inherit the Qwen value`.

**One design error the tests caught.** `imageSlimModeFromEnv` originally took no arguments and picked the variable family from the shape of the environment. That cannot work: a deployment that sets both families and one that sets neither both need a per-provider answer, and three precedence tests failed against it. The function is now provider-explicit — `imageSlimModeFromEnv(provider)` — because the mode belongs to a provider, not to a process.

**One test-harness defect worth noting.** `Object.assign(process.env, { KEY: undefined })` writes the STRING `"undefined"`, because `process.env` coerces every value. An unset variable therefore looked set, and the placeholder-fallback test failed against a literal. The helper now deletes unset keys explicitly.

- [x] **Step 3: Run the tests, including the Phase 0 Qwen guardrail**

---

## Phase 3: Keep-set invariants

DONE. This phase was implemented during Phase 4's work and the checkboxes were
left unticked; corrected here rather than left to drift.

- [x] **Step 1: Write the failing test** — `image-slim-measurement.test.ts` plus the keep-set cases in `image-slim-policy.test.ts`.
- [x] **Step 2: Clamp in the policy, not the transform** — `MIN_KEEP_LAST` in `imageSlimPolicy.ts`; `resolveImageSlimPolicy` applies `Math.max(keepLast, MIN_KEEP_LAST)` so a caller that inspects the policy sees the clamp.
- [x] **Step 3: Add the explicit keep-newest guarantee to the transform** — `replayImageSlimming.ts` adds the last image-bearing index to the keep set unconditionally, independently of the policy clamp. A hand-built config cannot slim the current turn's reference image.
- [x] **Step 4: Run the existing transform suite** — 15 existing tests, all green.

## Phase 4: Route wiring

DONE.

- [x] **Step 1: Write the failing route test** — `image-slim-routes.test.ts`, 9 tests.
- [x] **Step 2: Wire chat route** — `routes/chat.ts:676` replaces the `isQwenAiProvider && shouldSlimQwenAiAttemptImages` gate with `resolveImageSlimPolicy`.
- [x] **Step 3: Wire the Responses route identically** — `routes/responses.ts` the same shape.
- [x] **Step 4: Keep the busy-flag update where it is** — `slimImagesOnNextAttempt` is still set only on a `qwen_ai_upstream_busy` verdict, and `resolveImageSlimPolicy` honors it only for Qwen.

- [x] **Step 5: Keep the existing transform suite green** — all 15 tests pass; two of them were rewritten because they pinned the old contract (the transform no longer reads `process.env`).

## Phase 5: Measurement

DONE. `tests/server/image-slim-measurement.test.ts` (10 tests), plus
`docker-compose.yml` and `docs/docker.md`.

### Task 5.1: Log fields

- [x] **Step 1: The transform returns counts.** `slimQwenAiReplayImages` now returns `ImageSlimResult` (`messages`, `messagesSlimmed`, `partsSlimmed`, `charsSlimmed`) instead of a bare array. `charsSlimmed` counts only the dropped image payload, not the whole message, because the text part of a slimmed message survives as the placeholder.

- [x] **Step 2: Both routes log the counters.** `[ChatSlim] replay image slimming` with `imageSlimApplied`, `imageSlimReason`, `imageSlimKeepFirst`, `imageSlimKeepLast`, `imageMessagesSlimmed`, `imagePartsSlimmed`, `imageCharsSlimmed`. Additive, so existing log consumers keep working.

- [x] **Step 3: Same units as the text track.** `charsSlimmed` converts through the same `estimateTextTokens` rule the text optimizer uses, so the two tracks' savings add without double counting.

- [x] **Step 4: Nothing identifying is logged.** A test asserts the slimming log block does not serialize the rewritten messages. A part count is not identifying; a data URL, a filename, or a placeholder body is.

### Task 5.2: Environment passthrough and docs

- [x] **Step 1: Compose passthrough.** Six new variables with the same defaults as the Qwen family, except the mode which defaults to `off`. A test asserts the default is literally `off` in the compose file, not merely absent.

- [x] **Step 2: `docs/docker.md`.** New `Replay Image Slimming` section: the two families and the five precedence rules, the eligibility table with per-adapter evidence, the keep-set invariants, the log format, and a desktop note.

- [x] **Step 3: The compose passthrough test was extended** to all six new knobs.

**One plan premise was wrong.** Task 5.2 Step 1 said to mirror "the Dockerfile's Qwen block". There is no such block: `CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES` exists only in `docker-compose.yml`, never in the `Dockerfile`. The new variables therefore follow the same compose-only pattern, which is also the smaller patch surface.

**One return-type change rippled.** Changing `slimQwenAiReplayImages` to return an object required adapting 14 call sites across two test files. Every one is the same mechanical `.messages` suffix, and a test asserts the transform's result object carries exactly the three counters and nothing else, so a future field addition has to be deliberate.

## Phase 6: Rollout

DONE, with the task-quality gates explicitly outstanding.
Results: [`2026-09-26-image-slimming-acceptance.md`](./2026-09-26-image-slimming-acceptance.md).
`tests/server/image-slim-rollout.test.ts` (9 tests).

- [x] **Task 6.1: the non-vision no-op.** Every provider whose capability default is `false` (5 of them) returns no policy at both `always` and `off`. Unlisted and custom providers likewise. The default really is `off` with a clean environment, and the mode does not inherit the Qwen value.

- [x] **Task 6.2 Step 1: measurement.** A vision provider at `always` with `KEEP_LAST=1` drops 3 of 4 image-bearing messages and reports `charsSlimmed >= 600,000` for 200 KB payloads. `keepFirst=2, keepLast=1` retains exactly indices `[0, 1, 4]`.

- [x] **Task 6.2 Step 2: the corpus measurement is reproducible.** `npm run corpus:stats` still reports 181 outputs, 17 with images, 90.7%.

- [x] **Task 6.2 Step 3: the task-quality gate is written down as OPEN, not passed.** The acceptance file records success rate, tool-call schema, p95 latency, the production image share, and custom-provider behaviour as outstanding. A test asserts the file keeps saying so, so it cannot quietly become a claim.

- [x] **Task 6.2 Step 4: the default is not flipped.** `CHAT2API_REPLAY_SLIM_IMAGES` stays `off`, asserted against the compose file.

**The bound that IS available.** With `always` and `KEEP_LAST=1`, a replay of N image-bearing messages drops N-1 of them. On the captured replay that is 16 of 17, bounding the reduction at roughly 90% of the image payload and roughly 82% of that request's total estimated input tokens. That is arithmetic from the keep-set rule, not an observed production saving, and the acceptance file says so.

## Verification

```bash
# Guardrails and unit
node --test tests/server/replay-slimming-and-busy-cap.test.ts
npm run test:imageslim

# Corpus baseline
npm run corpus:stats

# Both distribution targets
npm run build:server
npm run test:server-compat
npm run build && npm run build:unpack

# Containers, all three modes
docker build -t chat2api:server .
docker run --rm -e CHAT2API_REPLAY_SLIM_IMAGES=off    -p 8080:8080 chat2api:server
docker run --rm -e CHAT2API_REPLAY_SLIM_IMAGES=always -p 8080:8080 chat2api:server
```

---

## Definition of Done

- [ ] Qwen behavior is byte-identical with and without the new environment variables set
- [ ] A provider or model not known to consume images is never slimmed, and the no-op is byte-identical
- [ ] The newest image-bearing message survives `keepLast=0`
- [ ] `file` parts are untouched
- [ ] The transform still returns new objects and mutates nothing
- [ ] The existing fifteen tests in `replay-slimming-and-busy-cap.test.ts` still pass without weakening any assertion
- [ ] `CHAT2API_REPLAY_SLIM_IMAGES` defaults to `off` and does not inherit the Qwen value
- [ ] Every parser is total; unknown values fall back safely
- [ ] Logs carry `imageCharsSlimmed` in the same units as `estimatedInputTokens`, and nothing that identifies image content
- [ ] No new dependency, runtime, or build artifact; both packaging pipelines are unchanged
- [ ] `docs/docker.md` documents both variable families and the precedence rules
- [ ] Task 0.2's assertion is updated in the same commit that records the post-rollout image share
