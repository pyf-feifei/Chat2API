# Upstream Compression Backends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `balanced` mode recoverable, replace the arbitrary recent-message window with a prompt-cache-aware live zone, and route the block rewrite through interchangeable TypeScript, WASM, and Python backends that all ship on Electron and Docker.

**Architecture:** The existing decision layer in `upstreamTokenOptimizer.ts` keeps ownership of eligibility, protection, thresholds, and measurement. It gains a live-zone bound, tool-pair atomicity, and a CCR archive. The byte-level rewrite of a single text block is delegated to a `CompressionBackend` selected by `CHAT2API_COMPRESS_BACKEND`, which always degrades to the TypeScript implementation.

**Scope warning — read Task 0.2 first.** On a real Codex replay, 90.7% of the estimated input tokens are inline base64 images that this plan cannot touch, and the text this plan does compress is the remaining 9.3%. The larger win is provider-neutral image slimming, specified in [`2026-09-26-provider-neutral-image-slimming-design.md`](../specs/2026-09-26-provider-neutral-image-slimming-design.md) and planned in [`2026-09-26-provider-neutral-image-slimming.md`](./2026-09-26-provider-neutral-image-slimming.md).

**Track order (decided 2026-09-26).** This plan runs A → C' → B'. Image slimming runs in parallel as an independent track, not as a phase here. The two share no code and no risk surface. Do not merge them, and do not read this plan's expected win as the whole story.

**Tech Stack:** TypeScript, Node.js, Koa, Rust → `wasm32-unknown-unknown`, Python 3.10+ (headroom compression modules), electron-builder, Vite/Rollup server build, Docker, Node test runner.

**Design:** [`docs/superpowers/specs/2026-09-26-upstream-compression-backends-design.md`](../specs/2026-09-26-upstream-compression-backends-design.md)

**All three backends ship.** The Python backend is not deferred. The cross-backend byte-parity suite is therefore a release gate.

---

## Critical Constraints

Read these before writing any code. Each one is a decision that was made deliberately.

1. **The decision layer never delegates its judgment.** A backend receives `(text, options)` and returns a rewrite. It may not decide whether a block is eligible, may not drop a line the decision layer marked protected, and may not touch `role`, `tool_call_id`, `tool_calls`, or `arguments`.
2. **Every backend must fail open.** A throw, a timeout, a missing file, or a missing interpreter results in the original text, not in a failed request. Follow the existing pattern at `forwarder.ts:1468-1473`.
3. **`safe` mode must be a no-op regression.** With `CHAT2API_COMPRESS_FROZEN_PREFIX_MESSAGES=0` and no `cache_control` in the request, the live zone must resolve to exactly the same message set the current `recentMessages` computation selects. There is a test for this and it must pass before any other behavior is considered.
4. **`ts` is the reference implementation.** `wasm` and `python` are measured against it, byte for byte, on the fixture corpus. Divergence is a bug.
5. **Never log archive content or hashes.** A hash is a content identifier for a tool output that may contain credentials, file contents, or source code. Log counts only.
6. **Do not touch `slidingWindow` / `tokenLimit` / `summary`.** They stay user-opt-in with their current behavior. headroom retired message-dropping for good reason, but removing a user-facing feature is out of scope here.
7. **`off` stays the default** for `CHAT2API_UPSTREAM_TOKEN_OPTIMIZER`, and `ts` stays the default for `CHAT2API_COMPRESS_BACKEND`. Nothing in this plan changes what a default deployment sends upstream.

---

## Upstream Sync Policy

This implementation must preserve a small patch surface, following `docs/superpowers/plans/2026-06-11-docker-server.md`.

New, Chat2API-owned:

```text
crates/chat2api-compress/
scripts/compress/
src/main/proxy/services/liveZone.ts
src/main/proxy/services/compressionArchive.ts
src/main/proxy/services/retrievalTool.ts
src/main/proxy/services/backends/
tests/proxy/compression/
```

Already created by Task 0.1:

```text
scripts/compress/extract-corpus.mjs
tests/proxy/compression/types.ts
tests/proxy/compression/fixtures.ts
```

Edits to upstream-owned files, all expected to be small:

```text
src/main/proxy/services/upstreamTokenOptimizer.ts   # cutoff -> liveZone, delegate rewrite, new settings
src/main/proxy/forwarder.ts                         # settings source gains a backend field
package.json                                         # extraResources entry
Dockerfile                                           # wasm COPY, scripts/compress COPY, env
docker-compose.yml                                   # env passthrough
docs/docker.md                                       # document the new variables
```

Leave alone:

```text
src/main/runtime/types.ts          # node:child_process works under both targets
src/main/store/types.ts            # the archive is not application config
src/main/proxy/services/contextManagementService.ts
src/main/window/  src/main/tray/  src/main/updater/  src/renderer/
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
src/main/proxy/services/liveZone.ts
src/main/proxy/services/compressionArchive.ts
src/main/proxy/services/retrievalTool.ts
src/main/proxy/services/backends/types.ts
src/main/proxy/services/backends/tsBackend.ts
src/main/proxy/services/backends/wasmBackend.ts
src/main/proxy/services/backends/pythonBackend.ts
src/main/proxy/services/backends/registry.ts
src/main/proxy/services/backends/fixtures.ts
src/main/proxy/services/compressionSettings.ts
scripts/compress/compress.py
scripts/compress/requirements.txt
crates/chat2api-compress/Cargo.toml
crates/chat2api-compress/src/lib.rs
crates/chat2api-compress/src/log_compressor.rs
crates/chat2api-compress/src/json_compactor.rs
crates/chat2api-compress/Cargo.lock
tests/proxy/compression/live-zone.test.ts
tests/proxy/compression/tool-pairs.test.ts
tests/proxy/compression/archive.test.ts
tests/proxy/compression/backend-parity.test.ts
tests/proxy/compression/retrieval-tool.test.ts
tests/proxy/compression/safe-regression.test.ts
```

Modify:

```text
src/main/proxy/services/upstreamTokenOptimizer.ts
src/main/proxy/forwarder.ts
package.json
Dockerfile
docker-compose.yml
docs/docker.md
```

---

## Phase 0: Guardrails

Establish the no-regression baseline before writing any feature.

### Task 0.1: Build the golden corpus from real captures

**Files:**
- Create: `scripts/compress/extract-corpus.mjs`
- Create: `tests/proxy/compression/types.ts`
- Create: `tests/proxy/compression/fixtures.ts` (generated, 732 KB)
- Modify: `package.json` (`corpus:extract`, `corpus:stats`)

Hand-written strings would have missed the most important shape in the data. The extractor is already written and produces 220 fixtures from four real captures.

- [ ] **Step 1: Review `scripts/compress/extract-corpus.mjs` and keep it as is**

It extracts from `.testimg/req_real.json`, `codex-replay-payload.json`, `codex-session-*.md`, and `dev-data/*.log`, then redacts. Current output:

```
fixtures : 220   (209 captured + 11 synthetic boundaries)
est tok  : 846,119
image 18 | json 17 | trace 15 | cjk 22 | mojibake 2 | repeated 10
over 16000 chars (balanced threshold): 12
```

- [ ] **Step 2: Read the corpus finding in the design doc before proceeding**

`Corpus Finding: 90% of the Estimated Tokens Cannot Be Compressed`. It changes the expected win from this plan and it may change whether the whole plan is worth doing in this order.

- [ ] **Step 3: Add the redaction self-check to CI**

`verifyRedaction()` already runs inside the extractor and refuses to write the corpus on a leak. Wire it as a check that a committed `fixtures.ts` matches a fresh extraction:

```bash
npm run corpus:extract && git diff --exit-code tests/proxy/compression/fixtures.ts
```

- [ ] **Step 4: Write the freeze test**

For every captured fixture, run the current `optimizeUpstreamRequest` in `safe` mode and assert the output matches. This is the tripwire: if it fails, a refactor changed behavior before any new behavior was added. It must pass against the current implementation with no source changes.

- [ ] **Step 5: Run**

```bash
npm run corpus:stats
npx tsx --test tests/proxy/compression/safe-regression.test.ts
```

### Task 0.2: Record the image measurement as a reproducible check

**Files:**
- Create: `tests/proxy/compression/image-share.test.ts`

The finding that motivated the corpus should not rot into a claim in a document.

- [ ] **Step 1: Assert the share on the captured fixtures**

```ts
const captured = FIXTURES.filter((f) => f.source !== 'synthetic')
const imageTokens = captured
  .filter((f) => f.image)
  .reduce((sum, f) => sum + f.estimatedTokens, 0)
const total = captured.reduce((sum, f) => sum + f.estimatedTokens, 0)
assert.ok(imageTokens / total > 0.8, `image share drifted to ${(100 * imageTokens / total).toFixed(1)}%`)
```

- [ ] **Step 2: Assert the optimizer cannot reduce those fixtures**

For every `image` fixture, `optimizeUpstreamRequest` in `safe` mode must leave the base64 payload byte-identical. This documents the gap as an executable fact rather than prose.

- [ ] **Step 3: Link the failure to the follow-up design**

The test comment points at the image-slimming follow-up so whoever trips it knows where the work went.

---

## Phase 1: Live zone and tool pairs

### Task 1.1: Tool-pair atomicity

DONE. `src/main/proxy/services/liveZone.ts` + `tests/proxy/compression/tool-pairs.test.ts` (10 tests).

- [x] **Step 1: Write the failing test** — 10 tests covering both id shapes, multi-call turns, orphans, unanswered calls, replayed ids, and malformed input.

- [x] **Step 2: Implement `computeToolPairs`**

```ts
export interface ToolPair { assistantIndex: number; responseIndex: number }
export function computeToolPairs(messages: ChatMessage[]): ToolPair[]
```

FIFO matching: a pending declaration consumes the earliest matching result, so a replayed id produces one pair per real turn rather than collapsing.

- [x] **Step 3: Run the tests** — 10 pass.

- [x] **Step 4: Strict-superset check against `isOldToolMessage`**

`isOldToolMessage` is retained in `upstreamTokenOptimizer.ts` and is still applied alongside `liveZone.isEligible`, so the two are composed with AND rather than one replacing the other. The superset property is therefore structural, and `safe-regression.test.ts` pins the orphan and unanswered-call cases end to end.

**Two test premises were wrong and are recorded in the test file:** a "three calls" case declared `call_1/2/3` and answered `toolu_1/2/3`, which is two id namespaces and correctly produced zero pairs; and a "repeated id" case expected only the later pair, which would have left the first result looking like an orphan and therefore ineligible.

### Task 1.2: Live-zone boundary

DONE. `src/main/proxy/services/liveZone.ts` + `tests/proxy/compression/live-zone.test.ts` (21 tests).

- [x] **Step 1: Write the failing tests** — 21 tests. Floor precedence, ceiling resolution, eligibility, and three separate regression guards.

- [x] **Step 2: Implement `computeLiveZone`** — floor from `cache_control` breakpoints, `frozenPrefixMessages`, or zero; ceiling from the latest user and latest tool message; `isEligible` composes role, bounds, floor, ceiling, the latest-tool rule and pairing.

- [x] **Step 3: Wire it into `upstreamTokenOptimizer.ts`** — the `cutoff` line is replaced by `computeLiveZone`, and `liveZoneSource` / `liveZoneFloor` / `liveZoneCeiling` are reported on the result and in the `[Forwarder] upstream-token-optimizer` log.

- [x] **Step 4: Run the full test set** — 46 compression tests, 1104 server tests, 23 image-slimming tests, all green. Both builds pass.

- [x] **Step 5: Verify `safe` mode byte-identical** — the freeze holds: no fixture's estimated token count changed.

### What Phase 1 changed, exactly

One behavior change, and it is a narrowing:

> The **latest** tool message is now never rewritten. Before, `collectToolCallState` only knew whether an id had a result somewhere in the request, so with `recentMessages=1` the newest tool result passed every check and `balanced` rewrote the output the model was about to act on.

Two things Phase 1 did NOT do, deliberately:

- **`recentMessages` is still the ceiling clamp when no cache boundary is declared.** The pre-Phase-1 rule was `index < max(0, length - recentMessages)`, whose highest eligible index is `length - recentMessages - 1`. The design promised an unconfigured deployment would behave exactly as before, and a first draft of the implementation dropped that clamp and widened the surface. It is restored, with a regression test.
- **The floor only moves when the client declares a `cache_control` breakpoint or an operator sets `frozenPrefixMessages`.** Both default to off.

One implementation gap the tests caught: `isEligible` accepted out-of-range indices, so a caller iterating a different array would have had garbage compressed. There is now a bounds check.

One existing test file needed rewriting. `tests/server/upstream-token-optimizer.test.ts` transpiled-and-`eval`d the module in isolation, which cannot resolve a new relative import, so it is now a `.test.ts` using real imports. Six of its tests used a `[tool, user]` shape where the tool result **is** the latest — correctly protected by the new rule — so they now place the payload in the middle of three tool turns via a shared helper. The rule was not weakened to make them pass.

## Phase 2: CCR archive and retrieval

Partially done. Task 2.1 complete; Task 2.2 (writing to the archive from
`balanced`) and Task 2.3 (the retrieval tool) not started.

### Task 2.1: Archive store

DONE. `src/main/proxy/services/compressionArchive.ts` + `tests/proxy/compression/archive.test.ts` (14 tests).

**Files:**
- Create: `src/main/proxy/services/compressionArchive.ts`
- Create: `tests/proxy/compression/archive.test.ts`

- [ ] **Step 1: Write the failing tests**

Cover: record then resolve; TTL expiry; char-bound eviction is oldest-first; scope isolation between accounts; a resolve for an unknown hash returns `undefined` and does not throw; concurrent record calls do not lose entries.

- [ ] **Step 2: Implement `CompressionArchive`**

Storage path comes from `CHAT2API_COMPRESS_ARCHIVE_PATH`, defaulting to `join(getRuntime().getDataDir(), 'compression-archive.json')`. **Use `getRuntime().getDataDir()`, never a hardcoded path** — this is what keeps the file inside the same directory as `accounts.json` on both targets.

Shape follows `src/main/store/storage/nodeJsonStore.ts`: mkdir on construction, rename-to-`.corrupted.<ts>.json` on parse failure, atomic write.

- [ ] **Step 3: Add scope keying**

Scope is `providerId:accountId:conversationKey`, falling back to `providerId:accountId:requestId` when there is no session id. A resolve with a different scope returns `undefined`.

- [ ] **Step 4: Run the tests**

- [ ] **Step 5: Verify the data directory is correct on both targets**

Confirm the Electron build writes under the app data dir and the server build writes under `CHAT2API_DATA_DIR` (`/data` in Docker).

### Task 2.2: Archive integration into `balanced`

**Files:**
- Modify: `src/main/proxy/services/upstreamTokenOptimizer.ts`
- Modify: `tests/proxy/compression/safe-regression.test.ts`

- [ ] **Step 1: Add the archive write to `compactBalancedText`'s call site**

Write to the archive **only** when `balanced` actually omits content, and only for blocks above the size threshold. `safe` mode must produce zero archive writes. Assert this in the test.

- [ ] **Step 2: Emit the retrieval marker in place of the terminal marker**

```
[Chat2API archive:tool:<hash> Nchars/Mlines; call retrieve_tool_output to expand]
```

Keep the existing omitted-char count so an operator reading the transcript can still see the size of what was dropped.

- [ ] **Step 3: Report archive counts, never hashes**

`UpstreamTokenOptimizerResult` gains `archivedCount` and `archivedChars`. No hash field is added to the result type.

- [ ] **Step 4: Run the tests**

### Task 2.3: Retrieval tool

SPLIT. 2.3a is done; 2.3b is not started and needs its own plan.

#### 2.3a — the resolvable core (DONE)

`src/main/proxy/services/retrievalTool.ts`, `retrievalSettings.ts`,
`tests/proxy/compression/retrieval-tool.test.ts` (21 tests).

- [x] **Step 1: Failing tests** — 18 tests covering definition, stripping, injection, hash extraction, and every failure mode.
- [x] **Step 2: The tool definition and resolver**
  - `buildRetrieveTool`, `isRetrievalToolName`, `stripRetrievalTool`, `shouldInjectRetrievalTool`, `extractArchiveHashes`, `resolveRetrievalCall`
  - `getRetrievalSettings` parses `CHAT2API_COMPRESS_RETRIEVAL` and `CHAT2API_COMPRESS_MAX_RETRIEVALS_PER_REQUEST`; retrieval defaults to **off**
- [x] **Step 3 (partial): the tool is never forwarded upstream.** `stripRetrievalTool` is the boundary helper. It is **not yet called** — see 2.3b.
- [x] **Step 4: Run the tests** — 21 pass.

Decisions worth recording:

- **A hash this request never advertised is refused before the archive is read.** The archive is already scope-isolated, but refusing at the entry point means a model cannot probe for another turn's spans even if it guesses a hash.
- **Every failure is a normal tool result carrying an error.** Unknown hash, malformed argument, non-hex hash, wrong scope, expired span, and exhausted budget all return `{ isError: true, content: <explanation> }`. Nothing throws: the alternative is a turn that dies on a recoverable mistake.
- **A non-positive budget falls back to the default rather than disabling retrieval.** A deployment that sets `0` gets the documented default instead of silently losing recoverability.
- **The budget is per request, not per span.** `maxRetrievalsPerRequest` bounds a retrieve loop regardless of how many spans were archived.

#### 2.3b — interception and continuation

A and C are done. B is not started and needs its own plan.

##### The self-review finding that made the rest necessary

After 2.3a and 2.3b-A were "complete" with 22 passing tests,
`grep -rn "buildRetrieveTool" src/` returned **only the definition**. The model
was never taught the tool, the partition never fired, and the loop was dead
code. No test asked how the tool reaches the prompt, so the suite was green and
the feature did nothing.

`tests/server/retrieval-tool-injection.test.ts` exists so that failure cannot
recur. Its first assertion is that `buildRetrieveTool` has a production call
site.

##### 2.3b-A — non-streaming (DONE)

| Piece | File |
| --- | --- |
| Partition | `ToolCallingEngine.applyNonStreamResponse`, before `message.tool_calls` is assigned |
| Context | `toolCalling/localToolCalls.ts`, carried in an `AsyncLocalStorage` |
| Loop | `services/retrievalLoop.ts` |
| Arming | `forwarder.ts` `localToolsForRequest`, which also teaches the tool |

`AsyncLocalStorage` rather than a module singleton, because the proxy serves
requests concurrently and a singleton leaks one account's archive scope into
another's retrieval. `local-tool-calls.test.ts` runs two interleaved contexts to
prove it.

The loop wraps the single `doForward` call site, so none of the ten provider
forwarders changed.

##### 2.3b-C — streaming (DONE)

`services/retrievalStream.ts`. The first turn is buffered; if it asked for
something local, the continuation is built from the reconstructed assistant turn
and only that is emitted.

Three decisions worth keeping:

- **A `Proxy`, not a property copy.** The chat route reads six
  `qwenAi*` properties off `result.stream`. Copying a known list breaks silently
  when a property is added; forwarding every read to the current underlying
  stream is future-proof, and the target is swappable so post-continuation
  metadata comes from the turn the client is actually receiving.
- **A failed or budget-exhausted turn still emits its first turn.** The client
  already paid for it.
- **One predicate arms both the prompt and the loop** (`localToolsForRequest`).
  Two predicates can disagree, and both disagreements are silent.

##### The second self-review finding: a green suite over dead code again

The C stream wrapper read its context from `AsyncLocalStorage` inside the `end`
handler. A streaming forwarder resolves as soon as the PassThrough exists, so
that context is **already gone** when `end` fires — the loop could never fire in
production, and all 13 tests passed, because they all awaited the whole flow
inside `runWithLocalToolContext` rather than returning the stream and letting it
finish afterwards.

The fix passes the context into the wrapper explicitly. The regression test
reproduces the production shape: arm, **return** the stream, then emit.

Two bugs, two green suites. The pattern is worth stating: a test that awaits a
call the production path does not await is not testing the production path.

##### 2.3b-B — Qwen sticky continuation (NOT STARTED)

Reuse `qwenAiSessionBridge` so a retrieval call continues on the same upstream
chat rather than through a proxy loop. Not started, and the plan is to keep it
that way for now: it optimizes the time-to-first-token of a feature that is off
by default, in the most collision-prone area of the repository, and the C loop
already covers the Qwen case for both streaming and non-streaming.

##### Two real bugs found on the way, both in the depth-prompt integration

Both are in `qwen-ai.ts`, both are crashes rather than semantic disagreements,
and both were invisible because the harness could not load the module at all.

1. A temporal-dead-zone `ReferenceError`: `content` was assigned six lines above
   its `let` declaration, so **every** Qwen continuation turn threw. Fixed by
   folding the depth directive into the initializer.
2. `nativeSystemPromptChars: lastDepthPlacement.systemPrompt.length` in a debug
   block. `placeQwenAiDepthDirective` returns the caller's `systemPrompt`
   unchanged, and `preparedUserMessage.nativeSystemPrompt` is undefined on the
   paths that build no native system prompt, so the read threw a `TypeError` out
   of the logging statement and took the request with it. Fixed with
   `?.length ?? 0`.

##### A contaminated control experiment, recorded so it is not repeated

The first attribution attempt stashed `qwen-ai.ts`, got 214/214 green, and
looked like proof that my own change had caused the failures. It had not: the
**staged** version of that file predates the depth feature entirely (zero
references to it), so stashing it removed the whole feature rather than isolating
my edit. A stash is only a control if what it removes is what you think it
removes — check the index, not just the diff.

The remaining failure is not fixable without the depth author's intent.
`qwen-ai-thinking-model-selection.test.mjs:27-28` asserts the literal source
strings `thinkingEnabled: effective.thinkingEnabled` and `autoThinking:
effective.autoThinking ?? effective.thinkingEnabled`. The depth refactor
replaced them with a local `const thinkingEnabled = ...` and
`autoThinking: effective.autoThinking ?? thinkingEnabled`, which satisfies the
assertions' *intent*. Rewriting them is a judgment about someone else's test, so
they are reported rather than changed.

## Phase 3: Backend abstraction

### Task 3.1: Interface and TypeScript reference backend

DONE. `src/main/proxy/services/backends/{types,tsBackend,registry}.ts`
+ `tests/proxy/compression/backend.test.ts` (10 tests).

- [x] **Step 1: The interface.** `CompressionBackend` with `available()` and `compact(text, options)`. The contract states what a backend may not do: decide eligibility, drop a protected line, or touch anything structural.

- [x] **Step 2: The logic moved.** `isCriticalLine`, `looksLikeCodeOrMarkup`, `compactValidJson`, `compactRepeatedLines`, `compactToolText`, `queryTerms`, `lineMatchesQuery`, `compactBalancedText` and the `BalancedCompactionResult` type now live in `tsBackend.ts`. The optimizer shrank from 872 to ~640 lines.

- [x] **Step 3: `optimizeUpstreamRequest` is async and delegates.** `compactMessageContent` is now a thin delegator. The forwarder awaits it and logs the backend.

- [x] **Step 4: The freeze test passes unchanged.** 100 compression tests, including the 15-test safe-mode freeze. The refactor changed no output.

- [x] **Step 5: The forwarder still works.** 1149 server tests green.

**Two things the tests caught, both of which had to be fixed:**

- `compressedRunCount` and `compactedJson` were dropped from the backend result, so the forwarder log reported `0` for both. They are metrics, not control flow, so a backend that does not report them loses observability rather than correctness. Both are now optional fields on `CompactBlockResult` and are threaded through.
- A backend that returns a LONGER string is discarded by the decision layer rather than applied. A backend is not trusted to check its own work.

**The registry never fails.** `ts` is always registered and always available. An unavailable or throwing backend degrades to `ts` and logs once per process, not once per request. `auto` tries `wasm`, `python`, `ts` in that order.

### Task 3.2: Settings and registry

**Files:**
- Create: `src/main/proxy/services/compressionSettings.ts`
- Create: `src/main/proxy/services/backends/registry.ts`
- Modify: `src/main/proxy/services/contextManagementService.ts` (re-export only)

- [ ] **Step 1: Write the parser**

Follow `getUpstreamTokenOptimizerSettings` (`upstreamTokenOptimizer.ts:91-113`) exactly: every parser is total, an empty string is distinguished from a valid zero, unknown values fall back to the safe default, and an unknown backend name resolves to `ts`.

- [ ] **Step 2: Write the registry**

`resolveCompressionBackend(name)` returns the requested backend, or the first available one from the `auto` order `wasm → python → ts`. Log the fallback reason once per process, never per request.

- [ ] **Step 3: Re-export from `contextManagementService.ts`**

`forwarder.ts:82-87` already imports the optimizer surface from there. Keep that import path working so `forwarder.ts` needs a one-line change, not a refactor.

- [ ] **Step 4: Run the tests**

---

## Phase 4: WASM backend — NOT BUILT, with reasons

## Phase 5: Python backend — NOT BUILT, with reasons

## Phase 6: Measurement and rollout

DONE for everything that ships. `tests/server/compression-measurement.test.ts`
(6 tests) pins what an operator can see.

- [x] **The optimizer log reports the compute backend, the live zone, and the archive counters** — and only counters. A hash is a content identifier for tool output that may hold credentials or file contents, so no hash field exists on the result object at all.
- [x] **Both retrieval loops report their outcome** — turns, resolved count, and one of seven explicit stop reasons. The Phase C wiring originally took `.response` off the loop result and discarded the rest, so a loop that spun to its budget looked identical to one that never fired.
- [x] **Both tracks' numbers are comparable.** `imageCharsSlimmed` and the optimizer's `estimatedSaved` convert through the same estimator, so an operator can add them.
- [x] **A default deployment changes nothing on the wire.** Both features are opt-in, and arming is gated on markers actually being present rather than on the feature flag alone.

## Phases 4 and 5 were not built

Both are **performance** work, not token reduction. The token goal is met by
phases 0-2 plus the image-slimming track; 4 and 5 would make the 9.3% text
portion faster to compress, and neither would change how many tokens are sent.

**Phase 4 (WASM).** The repository has no Cargo toolchain, no `rust-toolchain`,
and no CI target for it. Adding `crates/chat2api-compress` means a new build
matrix for an Electron app that currently builds with `electron-vite` alone, plus
one artifact per target. The reference backend is pure TypeScript with no
dependency, so the gain is bounded by a string pass that is already
microseconds. If a measurement ever shows the TypeScript path is the bottleneck,
this phase becomes worth its cost; nothing measured so far says it is.

**Phase 5 (Python).** `headroom-ai` pulls `tiktoken`, `litellm`, `onnxruntime`,
`transformers`, `magika`, `rapidocr`, `mcp` and `zstandard`, and downloads
`difft` and `scc` binaries at startup unless `HEADROOM_BINARIES_OFFLINE=1` is set.
That is a 500 MB dependency tree and a startup network fetch inside a desktop
application, in exchange for porting rules that the TypeScript backend already
implements. It also creates a parity obligation: a second implementation of the
same rules that must be kept byte-identical, enforced only by a test.

`CHAT2API_COMPRESS_BACKEND` already accepts `wasm`, `python` and `auto`, so
enabling either later is a build-and-register change, not a redesign.

**If either is wanted, the honest prerequisite is the same measurement that was
skipped for `CHAT2API_COMPRESS_RETRIEVAL` in
[`2026-09-26-image-slimming-acceptance.md`](./2026-09-26-image-slimming-acceptance.md):
real traffic, a fixed task set, and an acceptance gate that can fail.**

## Phase 4: WASM backend

### Task 4.1: Rust crate

**Files:**
- Create: `crates/chat2api-compress/Cargo.toml`
- Create: `crates/chat2api-compress/src/lib.rs`
- Create: `crates/chat2api-compress/src/log_compressor.rs`
- Create: `crates/chat2api-compress/src/json_compactor.rs`

**This is not a port of `headroom-core`.** That crate cannot compile to WASM: `tokenizers` vendors the `onig` C library, `hf-hub` downloads model weights at startup, and `fastembed` pulls `ort` with an auto-downloading native ONNX Runtime. Build the minimum instead.

- [ ] **Step 1: `Cargo.toml` with no blocked dependencies**

Target `wasm32-unknown-unknown`. Allowed: `serde`, `serde_json`, `serde-wasm-bindgen` or raw `extern "C"` exports, `wasm-bindgen`. Forbidden: `tokenizers`, `hf-hub`, `fastembed`, `ort`, anything that opens a socket or reads a filesystem path.

No tokenizer. Token counting stays in the TypeScript decision layer via the existing `estimateTextTokens` (`upstreamTokenOptimizer.ts:115`).

- [ ] **Step 2: `log_compressor.rs`**

Collapse runs of identical lines into one line plus a count marker, matching `tsBackend` exactly, including the "not a critical line and not code/markup" guard and the minimum-saving threshold.

- [ ] **Step 3: `json_compactor.rs`**

Whitespace-only compaction of valid JSON, matching `compactValidJson` (`upstreamTokenOptimizer.ts:195-211`) including the "must be strictly shorter" rule.

- [ ] **Step 4: `lib.rs` exports**

Export `compact_log`, `compact_json`, and a `version` string used to detect a stale artifact.

- [ ] **Step 5: Build**

```bash
rustup target add wasm32-unknown-unknown
cargo build --manifest-path crates/chat2api-compress/Cargo.toml \
  --target wasm32-unknown-unknown --release
```

- [ ] **Step 6: Commit `Cargo.lock`**

Deterministic builds across three target platforms require it.

### Task 4.2: Loader

**Files:**
- Create: `src/main/proxy/services/backends/wasmBackend.ts`

- [ ] **Step 1: Load through `getRuntime().getResourcePath()`**

Mirror `src/main/lib/challenge.ts:108-135` exactly. This is the pattern that makes one artifact serve both distribution targets.

- [ ] **Step 2: `available()` returns false on any failure**

Missing file, instantiation error, version mismatch. Log once per process with the reason.

- [ ] **Step 3: `compact()` returns `undefined` on any throw**

An exception inside WASM memory or a bad pointer is caught at the boundary and turned into "no compaction", which is the current behavior for blocks the backend declines to touch.

- [ ] **Step 4: Write the cross-backend parity test** (see Task 5.1) and require it to pass

### Task 4.3: Packaging

**Files:**
- Modify: `package.json`
- Modify: `Dockerfile`

- [ ] **Step 1: Add the `extraResources` entry**

Mirror the existing `sha3_wasm_bg.7b9ca65ddd.wasm` entry in `build.extraResources`. `asar` is `true`, so `getResourcePath` resolves outside the archive.

- [ ] **Step 2: Add the `Dockerfile` COPY**

Mirror line 220. Without it the server build cannot find the artifact.

- [ ] **Step 3: Check `scripts/check-source-artifacts.js`**

`npm run build` runs this gate first. The compiled `.wasm` is a build output. If the gate rejects it, gitignore the artifact and produce it in the build stage. **Do not weaken the gate.**

- [ ] **Step 4: Verify both targets load it**

```bash
npm run build && npm run build:unpack
npm run build:server
```

---

## Phase 5: Python backend

### Task 5.1: Cross-backend parity suite

**Files:**
- Create: `tests/proxy/compression/backend-parity.test.ts`

- [ ] **Step 1: Write the suite**

For every fixture in `fixtures.ts` and every `CompactBlockOptions` variant, run `ts`, `wasm`, and `python` and assert the outputs are byte-identical.

- [ ] **Step 2: Make this a release gate**

This is the direct cost of shipping all three backends (see *Resolved Decisions* in the design doc). A backend that is not available on the current platform is skipped, and the test reports which ones ran. A backend that runs and diverges **fails**.

- [ ] **Step 3: Add a CLI check**

```bash
npx tsx --test tests/proxy/compression/backend-parity.test.ts
```

### Task 5.2: Interpreter resolution

**Files:**
- Create: `src/main/proxy/services/backends/pythonBackend.ts`
- Create: `scripts/compress/compress.py`
- Create: `scripts/compress/requirements.txt`

- [ ] **Step 1: Copy the probe strategy from `zai-token-refresh.ts:34-95`**

Reuse the shape: `pythonCandidates()` returns an ordered list (`CHAT2API_COMPRESS_PYTHON_PATH` first, then `python` / `python3` / `py` plus `windowsPythonInstalls()` on win32), and `pythonBin()` probes with `spawnSync(python, ['-c', 'import ...'])` once per process and caches the answer.

**Do not re-invent this. Import or mirror `pythonCandidates`;** two divergent interpreter-discovery implementations is exactly the class of bug the parity suite is meant to prevent.

- [ ] **Step 2: Write the compression script**

A stdio JSON protocol: one JSON request in, one JSON result out, matching `CompactBlockResult`. No framework, no daemon, no state between calls. It must be importable on a bare Python 3.10 install.

- [ ] **Step 3: `requirements.txt`**

Pin the headroom modules actually used. Start with `headroom-ai` unpatched and measure image growth before considering a minimal subset (see *Remaining Open Questions* #1 in the design doc).

### Task 5.3: Docker and desktop coverage

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `docs/docker.md`

- [ ] **Step 1: Install the Python backend in the Docker image**

The image already installs `python3`, `pip`, `numpy`, `PIL`, and `patchright` for the captcha solvers. Add the compression requirements and `COPY scripts/compress /app/scripts/compress`.

- [ ] **Step 2: Set `HEADROOM_BINARIES_OFFLINE=1`**

`headroom/binaries.py` downloads `difft` and `scc` from GitHub releases at startup unless this is set. A container must not fetch executables on boot.

- [ ] **Step 3: Pass through the env in `docker-compose.yml`**

Mirror the `CHAT2API_UPSTREAM_TOKEN_OPTIMIZER*` block, defaulting to the same values as the Dockerfile.

- [ ] **Step 4: Document the desktop story honestly**

Desktop does not bundle a Python runtime and this plan does not add one. `CHAT2API_COMPRESS_BACKEND=python` on desktop is operator-provided, detected like `ZAI_PYTHON_PATH`, and degrades to `ts` when absent. Say exactly that in `docs/docker.md` and in the desktop settings UI.

- [ ] **Step 5: Run the parity suite on both targets**

```bash
npm run test:server-compat
```

---

## Phase 6: Measurement and rollout

### Task 6.1: Log fields

**Files:**
- Modify: `src/main/proxy/forwarder.ts`

- [ ] **Step 1: Add fields to the existing log**

Extend the `console.info('[Forwarder] upstream-token-optimizer', ...)` at `forwarder.ts:1447-1463`. The format is additive so existing log consumers keep working.

New fields:

```
liveZoneFloor, liveZoneCeiling, liveZoneSource
backend, backendFallbackReason
archivedCount, archivedChars
retrievalToolInjected, retrievalsServed, retrievalsFailed
```

- [ ] **Step 2: Add no hash field**

Critical Constraint 5. Counts only.

- [ ] **Step 3: Keep the fail-open catch intact**

`forwarder.ts:1468-1473` is the reference for what a backend failure must look like in the log.

### Task 6.2: `dry-run` verification

**Files:**
- Modify: `tests/proxy/compression/backend-parity.test.ts`

- [ ] **Step 1: Verify `dry-run` runs the selected backend and changes nothing**

`dry-run` must exercise the configured backend to measure the candidate, then return the original request. If it short-circuits, the measurement is meaningless for `wasm` and `python`.

- [ ] **Step 2: Run against a real long tool request in `dry-run` on both targets**

Record `estimatedSaved` per backend. This is the first production-shaped evidence that the three backends agree.

### Task 6.3: Acceptance gates

**Files:**
- Create: `docs/superpowers/plans/2026-09-26-compression-acceptance.md` (results, not code)

- [ ] **Step 1: Run the gate set from the design doc**

- [ ] **Step 2: Do not promote any mode on partial evidence**

`off` stays the default until every gate passes. `safe` may be promoted independently of `balanced`. **`balanced` is never promoted to a default, because CCR adds recoverability, not fidelity** — a lossy span the model chooses not to retrieve is still lossy.

- [ ] **Step 3: Record the `cache_control` decision in the release note**

Honoring client-supplied cache breakpoints means client input steers the live-zone floor. Operators need to know this.

---

## Verification

```bash
# Corpus: stats, regeneration, and the redaction gate
npm run corpus:stats
npm run corpus:extract && git diff --exit-code tests/proxy/compression/fixtures.ts

# Image slimming (separate plan — see the note above)
npx tsx --test tests/server/image-slim-policy.test.mjs

# Unit and parity
npx tsx --test tests/proxy/compression/

# Both distribution targets
npm run check:source-artifacts
npm run build:server
npm run test:server-compat
npm run build && npm run build:unpack

# WASM artifact
cargo build --manifest-path crates/chat2api-compress/Cargo.toml \
  --target wasm32-unknown-unknown --release

# Containers
docker build -t chat2api:server .
docker run --rm -e CHAT2API_COMPRESS_BACKEND=ts    -p 8080:8080 chat2api:server
docker run --rm -e CHAT2API_COMPRESS_BACKEND=wasm  -p 8080:8080 chat2api:server
docker run --rm -e CHAT2API_COMPRESS_BACKEND=python -p 8080:8080 chat2api:server
```

---

## Definition of Done

- [ ] The committed corpus is reproducible: `npm run corpus:extract` produces no diff
- [ ] The redaction self-check passes and is wired into CI
- [ ] Task 0.2's image-share assertion is in place and is expected to fail once image slimming generalizes; it is updated in the same commit that changes the share
- [ ] `safe` mode output is byte-identical to the pre-change implementation on the fixture corpus
- [ ] `ts`, `wasm`, and `python` produce byte-identical output on the fixture corpus
- [ ] A `balanced` omission is retrievable by hash and the retrieval costs zero upstream tokens
- [ ] Every backend fails open; no code path can fail a request because of compression
- [ ] `ts` is the default and requires no new dependency
- [ ] The WASM artifact loads on win x64, mac arm64, and linux x64/arm64 from one file
- [ ] The Python backend runs on Docker and degrades cleanly on desktop without an interpreter
- [ ] No hash and no archived content appears in any log line
- [ ] `off` remains the default for `CHAT2API_UPSTREAM_TOKEN_OPTIMIZER`
- [ ] `npm run check:source-artifacts` passes without being weakened
- [ ] `docs/docker.md` documents every new variable with its safe default
