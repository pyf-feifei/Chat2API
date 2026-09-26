# Upstream Compression Backends Design

> Status: design approved, not implemented. All three backends (`ts`, `wasm`, `python`) are in scope. See *Resolved Decisions* for the questions closed during review.
> Related: [`docs/token-optimization-research.md`](../../token-optimization-research.md) (选型调研), [`docs/superpowers/specs/2026-06-11-docker-server-design.md`](./2026-06-11-docker-server-design.md) (双运行时边界).

## Background

`src/main/proxy/services/upstreamTokenOptimizer.ts` is the only component in Chat2API that rewrites an upstream request to reduce input tokens. It is opt-in (`CHAT2API_UPSTREAM_TOKEN_OPTIMIZER=off|dry-run|safe|balanced`), default `off`, and wired at `src/main/proxy/forwarder.ts:1426-1470`.

Two gaps keep it from being a real solution rather than a demonstration:

1. **`balanced` is one-way.** `compactBalancedText` (`upstreamTokenOptimizer.ts:380`) replaces the omitted span with a marker string. The model cannot get the dropped lines back, so `balanced` cannot be promoted out of "experimental" on quality grounds alone — no amount of A/B testing makes an unrecoverable lossy rewrite safe.
2. **The recent-message window is a guess, not a cache boundary.** `upstreamTokenOptimizer.ts:605` computes `cutoff = messages.length - recentMessages`. `recentMessages` defaults to `8` and has no relationship to the provider's prompt cache. On a provider with prefix caching the choice is arbitrary; on a provider without it, rewriting a block inside the cacheable prefix silently forfeits the cache discount for the rest of the conversation.

`docs/token-optimization-research.md` concluded that a PACE/ACON-style "task-aware + multi-granularity + recoverable" layer is the direction worth developing in this repository, and that provider-native cache control is the only zero-quality-risk cost reduction. It also explicitly declined to recommend LLMLingua on full tool history.

This design supersedes nothing in that document. It corrects one statement in it (see *Correct the prior research note* below) and turns its section 4.2 "第 2 层：PACE/ACON-lite" from a recommendation into a file-level design.

## Corpus Finding: 90% of the Estimated Tokens Cannot Be Compressed

Building the Phase 0 corpus from real captured payloads (Task 0.1) produced a measurement that reframes this work. It is recorded here because it changes what "reduce upstream tokens" should mean for this project.

`codex-replay-payload.json` is a real 435-item Codex Responses replay captured from a visual-iteration session. Its 181 `function_call_output` items estimate to **787,376 input tokens**. Of those:

| Segment | Tool outputs | Estimated tokens | Share |
| --- | ---: | ---: | ---: |
| Contain an inline base64 image | 17 (9.4%) | 714,462 | **90.7%** |
| Text only | 164 (90.6%) | 72,914 | 9.3% |

The five largest single tool outputs are 196–222 KB each and are entirely `[{"type":"input_image","image_url":"data:image/png;base64,..."}]` payloads.

Three consequences:

1. **`upstreamTokenOptimizer` cannot touch any of it.** `compactMessageContent` only rewrites parts where `part.type === 'text'`. An `input_image` / `image_url` part is copied through verbatim, while `estimateContentTokens` charges it ~72,000 tokens apiece. The optimizer's `minEstimatedTokens` gate is therefore tripped by payloads it is structurally incapable of reducing, and the `balanced` `maxChars` ceiling never applies to them.
2. **The one existing mitigation is Qwen-only.** `src/main/proxy/replayImageSlimming.ts` slims old inline images to text placeholders, but it is reached from the Qwen AI adapter path only. DeepSeek, GLM, Kimi, MiniMax, Z.ai, Perplexity, M365, and MiMo have no equivalent, so for those providers the same replay sends every screenshot on every turn.
3. **The research document's baseline was measured on the wrong axis.** `docs/token-optimization-research.md:70-80` concluded from log records that 94.96% of estimated tokens belong to tool-enabled requests, and directed attention at "managing old tool observation / conversation history". For a session with screenshots that guidance points at 9.3% of the payload.

This is why the corpus is built from real captures rather than hand-written strings, and why the corpus carries an `image` flag on every fixture. Two decisions follow:

- **The live zone and CCR work in this design is still correct and still worth doing.** It addresses the 9.3%, which is the part that is actually text and actually grows turn over turn.
- **A separate, larger win exists.** Extending image slimming to every provider is specified in [`2026-09-26-provider-neutral-image-slimming-design.md`](./2026-09-26-provider-neutral-image-slimming-design.md). It needs a different decision, changes wire payloads rather than prompt text, and shares no code or risk with this design.

### Sequencing (decided 2026-09-26)

Text compression runs first, in the order A → C' → B'. Image slimming proceeds in parallel as an independent track, not as a phase of this plan.

| Track | Plan | Depends on |
| --- | --- | --- |
| Text compression, `ts` live zone + CCR | `plans/2026-09-26-upstream-compression-backends.md` | — |
| Text compression, WASM backend | same plan, Phase 4 | Phase 3 |
| Text compression, Python backend | same plan, Phase 5 | Phase 3 |
| Provider-neutral image slimming | `plans/2026-09-26-provider-neutral-image-slimming.md` | — |

The two tracks touch different code and must not be merged. The image-slimming track adds no dependency, no runtime, and no build artifact, so it does not wait on the WASM artifact or the Python sidecar. The measurement it produces is what the text track's acceptance gates compare against.

The corpus keeps the measurement reproducible in the meantime:

```bash
npm run corpus:stats
```


This design takes the next step: adopt the **recoverable** and **cache-aware** ideas, and define how compression compute can be sourced from three backends without breaking either distribution target.

## Upstream Reference Analysis

`headroom` (`headroom-ai v0.38.0`, Apache-2.0, commit `e64b9f5`, 2026-09-25) was read as the reference implementation. Findings are source-verified, not from documentation.

### Adopt

| Idea | Source | What it actually is |
| --- | --- | --- |
| Live-zone bound | `crates/headroom-core/src/transforms/live_zone.rs:1-70` | Compression happens *within* messages, never between them. Floor = the frozen cacheable prefix; ceiling = the latest user message. Bytes outside the live zone are copied, never re-serialized, so the cache prefix survives. |
| Message-dropping is retired | `live_zone.rs:5-6` | "After Phase B PR-B1 retired the message-dropping machinery, all compression happens *within* messages, never *between* them." Independent confirmation that `slidingWindow` / `summary` are the wrong shape for agent tool history. |
| Tool-pair atomicity | `crates/headroom-core/src/transforms/safety.rs:1-40` | An `assistant.tool_calls[].id` and its `tool.tool_call_id` must be compressed as one unit; splitting them desynchronizes replay and produces upstream 400s. |
| CCR (Compress-Cache-Retrieve) | `headroom/ccr/__init__.py:1-20` | Reversible compression: inject a `headroom_retrieve` tool, intercept the model's call, serve the original from a local store. Plus a `context_tracker` that proactively expands content the new query turns out to need. |
| Content-type routing | `headroom/compression/handlers/` | JSON arrays and structured logs compress; source code deliberately does not (their own benchmark reports 0% on Python, intentionally). |

### Reject

| Rejected | Reason |
| --- | --- |
| The npm package as a dependency | `sdk/typescript/src/compress.ts:55-58` is a thin client: `client.compress(...)` → `fetch(HEADROOM_BASE_URL + "/v1/compress")`. 56 files, 1711 lines, **zero compression algorithm**. The npm artifact contains no functionality this repository could call. |
| A Python sidecar as a hard dependency | `pyproject.toml` pulls `tiktoken`, `litellm`, `ast-grep-cli`, and the `[proxy]` extra adds `fastapi`, `uvicorn`, `onnxruntime`, `transformers`, `magika`, `mcp`, `rapidocr`, `zstandard`, `websockets`, `sqlite-vec`. `headroom/binaries.py:1-22` additionally downloads `difft` and `scc` from GitHub releases at startup unless `HEADROOM_BINARIES_OFFLINE` is set. |
| Rust core as a napi addon | No `napi` / `node-api` binding exists in any `Cargo.toml`. Building one means 3 target platforms (win x64, mac arm64, linux x64/arm64) × 2 ABIs (Electron 33 main process, Node 20 server build). Docker's `npm ci --omit=dev --ignore-scripts` performs no native rebuild, so only prebuilt binaries are usable there. |
| `headroom-core` compiled to WASM | Blocked by its own dependency tree. `tokenizers` vendors `onig` (C library), `hf-hub` downloads model weights at startup, `fastembed` pulls `ort` with an auto-downloading **native** ONNX Runtime. None of these work under `wasm32-unknown-unknown`. |
| Their compression claims as evidence | `docs/content/docs/benchmarks.mdx` reports 48-54% on JSON arrays / structured logs and 92% on documentation prose, but its own QA section states: "Requires a paid LLM call to reproduce … No committed result artifact for this repo exists in this repo, so no number is published here." |

### Correct the prior research note

`docs/token-optimization-research.md:190-196` speculated that Headroom's hosted compression API could leak tool output off-machine. Source review shows the SDK only reads `HEADROOM_BASE_URL` / `HEADROOM_API_KEY` pointing at a self-hosted service, and no mandatory cloud path exists. The real concern is different: startup-time binary downloads from GitHub. The research note's conclusion (reference the architecture, do not copy the dependency, do not treat its benchmarks as quality evidence) stands; its stated privacy mechanism is wrong and should be corrected in a later revision.

## Goals

1. Make `balanced` recoverable: every omitted span must be addressable and retrievable by the model through a managed tool.
2. Replace the arbitrary `recentMessages` window with a live-zone bound derived from prompt-cache structure, so compression does not forfeit the provider's cache discount.
3. Allow compression compute to be sourced from a TypeScript, WASM, or Python backend, selected by configuration, with automatic degradation.
4. Ship every backend on both distribution targets — Electron desktop and Docker server — with a documented support matrix and no configuration that silently breaks one of them.
5. Keep the existing fail-open contract: any backend load or execution failure sends the unmodified request upstream.
6. Ship the Python backend as a first-class, tested backend on both distribution targets, with byte-parity against the TypeScript reference enforced by tests.

## Non-Goals

- Do not merge image slimming into this design. It is specified separately in [`2026-09-26-provider-neutral-image-slimming-design.md`](./2026-09-26-provider-neutral-image-slimming-design.md) and runs as a parallel track. It is the largest single lever and belongs in a layer where base64 content parts are a first-class concern, not behind a prompt-text backend abstraction.
- Do not add provider-native prompt cache breakpoints. The Qwen Web adapter posts to `/api/v2/chat/completions`, which does not accept `cache_control`; claiming cache support there would be false.
- Do not remove or re-purpose `slidingWindow` / `tokenLimit` / `summary`. They stay user-opt-in, and the UI keeps exposing them.
- Do not compress tool schemas, tool arguments, system messages, or `is_error` tool results.
- Do not make any lossy mode the default.
- Do not add a `napi` native addon.

## Current State

### Build and runtime seams that already exist

| Seam | Location | Note |
| --- | --- | --- |
| Two build outputs | `package.json` `build` / `build:server` | Electron → `out/`; server → `out-server/` + `out-admin/`. |
| Server build entry set | `vite.server.config.ts` | Only 4 entries; everything else is bundled into chunks, so new `src/main/proxy/**` modules ship to Docker with no config change. |
| Runtime abstraction | `src/main/runtime/types.ts` | `RuntimeAdapter` with `kind: 'electron' \| 'node'`, `getDataDir()`, `getResourcePath()`. `src/server/index.ts:14` calls `setRuntime(nodeRuntime)`. It has **no** process-spawning capability. |
| WASM dependency | `src/main/lib/challenge.ts:108-135` | Loads a Rust-compiled `.wasm` via `getRuntime().getResourcePath(...)`. `package.json` `build.extraResources` ships it; `Dockerfile:220` copies it. One code path serves both targets. |
| Python subprocess | `src/main/proxy/adapters/zai-token-refresh.ts:34-95` | `pythonCandidates()` / `windowsPythonInstalls()` / `pythonBin()` with a `spawnSync` dependency probe and fail-open callers. `Dockerfile` already installs `python3`, `pip`, `numpy`, `PIL`, `patchright`, `chromium`. |
| Native-module rebuild | `package.json` `postinstall` | `electron-builder install-app-deps`. Not invoked by the Docker build. |

### Compression seams that will change

Phase 1 is implemented. Status of each seam:

| Location | Phase 1 outcome |
| --- | --- |
| `upstreamTokenOptimizer.ts` | `cutoff` replaced by `computeLiveZone(request.messages, ...)`. The `recentMessages` clamp is retained so an unconfigured deployment is unchanged. |
| `upstreamTokenOptimizer.ts:315-330` | `isOldToolMessage` retained and composed with `liveZone.isEligible` using AND. It still catches orphans and unanswered calls. |
| `upstreamTokenOptimizer.ts:286-313` | `collectToolCallState` still runs. Pair-wise eligibility is layered on top via `computeToolPairs`, which handles the Anthropic shape too. |
| `upstreamTokenOptimizer.ts:380` | Unchanged. `compactBalancedText` still emits a terminal marker with no retrieval key; that is Phase 2's work. |
| `forwarder.ts` | Shape unchanged. The log gained `liveZoneSource`, `liveZoneFloor`, `liveZoneCeiling`. |
| `forwarder.ts:1933-1998` | `ContextManagementService` still runs only when the optimizer did not apply. Unchanged. |
| new `liveZone.ts` | `computeToolPairs`, `computeLiveZone`, `LiveZone`, `LiveZoneSettings`. |
| new env | `CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_FROZEN_PREFIX_MESSAGES`, default `0`. |

**The one behavior change Phase 1 makes is a narrowing.** The latest tool message is now never rewritten. Before, `collectToolCallState` only knew whether an id had a result *somewhere* in the request, so with `recentMessages=1` the newest tool result passed every check and `balanced` rewrote the output the model was about to act on. This matches `headroom` at `live_zone.rs:1842-1843`.

**`recentMessages` is deliberately still the ceiling clamp.** The design's promise was that an unconfigured deployment behaves exactly as before. An implementation of `computeLiveZone` that ignored `recentMessages` would have widened the compression surface for every existing `safe` deployment; the clamp is restored and pinned by a regression test that walks five message shapes across five window sizes and fails if anything above the old cutoff becomes eligible.

## Recommended Approach

One compression **decision** layer with three interchangeable **compute** backends.

The decision layer stays in TypeScript and stays where it is today. It owns eligibility, protection, thresholds, measurement, and the fail-open contract. It delegates only the byte-level rewrite of a single text block.

```
forwarder.ts
  └─ optimizeUpstreamRequest(request, settings)        ← unchanged decision layer
       ├─ computeLiveZone(messages, settings)           ← NEW  (cache-aware boundary)
       ├─ computeToolPairs(messages)                    ← NEW  (safety.rs parity)
       ├─ compactionArchive.record(hash, original)     ← NEW  (CCR store)
       └─ backend.compactBlock(text, { kind, budget }) ← NEW  pluggable
            ├─ TsBackend      default, zero dependencies
            ├─ WasmBackend    optional native speedups
            └─ PythonBackend  optional, Docker-preferred
```

Rationale for the split: the decision layer is where correctness risk lives, and it is also where the existing tests and the existing protection rules already are. Backends are pure functions from `(text, options) → { text, metadata }` and can be replaced, benchmarked, or disabled without touching a single protection rule.

### Decision: use WASM, not napi, for native compute

`src/main/lib/challenge.ts` is a working precedent for a single WASM binary serving both distribution targets: `getResourcePath()` resolves it, `extraResources` packages it, `Dockerfile` copies it. WASM has no ABI, no `electron-rebuild`, and one artifact covers every platform.

Consequence: the WASM backend cannot be a port of `headroom-core`. It is a small purpose-built crate containing only the transforms that have no blocked dependency: log-run collapsing, JSON structure compaction, and text-crusher-style redundancy removal. Token counting uses the existing `estimateTextTokens` (`upstreamTokenOptimizer.ts:115`) in the decision layer; the crate does not need a tokenizer.

### Decision: Python backend is a probe-and-degrade path, never a hard dependency

The precedent is `zai-token-refresh.ts`. The Python backend resolves an interpreter by probing for importable dependencies, and every failure path returns the original block. On Docker the interpreter is guaranteed by `Dockerfile`. On Electron it is best-effort: if no suitable interpreter is found, the backend reports unavailable and the chain falls through to the TypeScript backend.

## Architecture

### 1. Live zone

```ts
export interface LiveZone {
  /** Indices below this are the cacheable prefix: never rewritten. */
  floor: number
  /** Indices at or above this are the newest blocks: rewritten only under balanced. */
  ceiling: number
  /** Tool-call pairs whose two halves must be compressed together. */
  pairs: ToolPair[]
}

export function computeLiveZone(
  messages: ChatMessage[],
  settings: LiveZoneSettings,
): LiveZone
```

Floor resolution, in priority order:

1. `cache_control` breakpoints carried on assistant messages, when the client sends them. The last breakpoint index is the floor.
2. `settings.frozenPrefixMessages` (default `0`).
3. Fall back to the current `recentMessages` behavior, and report `source: 'recent-window'` in the optimizer log so operators can see when no cache signal existed.

Ceiling resolution:

1. Index of the latest `role: 'user'` message without a `tool_call_id`.
2. Index of the latest `role: 'tool'` message.
3. `messages.length - 1`.

Compression eligibility for a message is then `index >= floor && index <= ceiling && isToolMessage && isToolPairComplete && !isError`.

`safe` mode is unaffected in spirit: with the default `frozenPrefixMessages=0` and no `cache_control`, the boundary resolves exactly as it does today, so `safe` is a no-op regression. The live zone only bites when an operator opts in to a floor, or sends `cache_control`.

### 2. Tool-pair atomicity

```ts
export interface ToolPair {
  assistantIndex: number
  responseIndex: number
}

export function computeToolPairs(messages: ChatMessage[]): ToolPair[]
```

Pairs `assistant.tool_calls[i].id` with `tool.tool_call_id`, matching `safety.rs::tool_pair_indices`. A tool result whose id has no live assistant counterpart is an orphan and is never rewritten. A tool result whose assistant call is above the ceiling is an unresolved continuation and is never rewritten. This is a strict superset of the current `isOldToolMessage` checks at `upstreamTokenOptimizer.ts:315-330`; those checks stay as the inner predicate.

### 3. Compression archive (CCR)

```ts
export interface ArchiveRecord {
  hash: string            // sha256 of the original text, 16 hex chars, matches headroom
  chars: number
  lines: number
  createdAt: number
  /** Account/conversation scope so archives never leak across tenants. */
  scope: string
  text: string
}

export interface CompressionArchive {
  record(scope: string, text: string): string   // returns hash
  resolve(scope: string, hash: string): string | undefined
  forget(scope: string, hash: string): void
}
```

Storage: a `NodeJsonStore`-shaped JSON file under `getRuntime().getDataDir()`, following `src/main/store/storage/nodeJsonStore.ts`. Records are TTL'd (default 24h, aligned with `CHAT2API_RESPONSES_STORE_TTL_MS`) and bounded by total chars (default 64 MB) with oldest-first eviction. Scope key is `providerId:accountId:conversationKey` where `conversationKey` is the existing session id when available.

The archive is written **only** when `balanced` omits content, and **only** for blocks that actually pass the size threshold, so `safe` mode produces no archive writes at all.

### 4. Retrieval tool

A managed tool registered alongside the existing managed tool protocol:

```
name:     retrieve_tool_output
input:    { hash: string }
output:   { hash, chars, lines, text }
```

Behavior:

- Injected into `request.tools` only when the live zone actually omitted something in this request, and only when `settings.retrieval !== 'off'`.
- The proxy intercepts the call before it reaches the adapter, resolves it locally, and emits a normal `role: 'tool'` message. The upstream provider never sees the tool call for a local resolution.
- Unresolvable hash returns a normal protocol error result, not a crash.
- The proxy tracks retrieval attempts per request and gives up after `settings.maxRetrievalsPerRequest` (default 4) to stop a retrieve loop.

Proactive expansion, the second half of CCR's `context_tracker`, is **deferred** to a follow-up. It requires deciding relevance of a new query against archived spans, which is a task-quality judgment this repository has no evaluation set for. The explicit tool call is the reviewable half.

### 5. Backend interface

```ts
export type BlockKind = 'text' | 'json' | 'log' | 'code' | 'unknown'

export interface CompactBlockOptions {
  kind: BlockKind
  mode: 'safe' | 'balanced'
  maxChars: number
  activeQuery: string
  protectedLines: number[]      // critical + query-matching line indices
}

export interface CompactBlockResult {
  text: string
  omittedChars: number
  omittedLines: number
  /** Lines the backend wants kept verbatim, resolved by the decision layer. */
  retained: number[]
  backend: 'ts' | 'wasm' | 'python'
}

export interface CompressionBackend {
  readonly id: 'ts' | 'wasm' | 'python'
  available(): Promise<boolean>
  compact(text: string, options: CompactBlockOptions): Promise<CompactBlockResult | undefined>
}
```

Responsibility split, which is what makes this safe to extend:

- The backend never decides *whether* a block may be compressed. That is `computeLiveZone` + `computeToolPairs` + the existing protection checks.
- The backend never deletes a protected line. It reports `retained` indices and the decision layer enforces them.
- The backend never edits `role`, `tool_call_id`, `tool_calls`, or `arguments`.
- A backend returning a result that is not shorter is discarded by the decision layer.

`TsBackend` is the current `compactToolText` / `compactBalancedText` logic, moved. It is the reference implementation and the always-available floor.

`WasmBackend` loads `chat2api_compress.wasm` through `getRuntime().getResourcePath()`, mirroring `src/main/lib/challenge.ts:122`. Missing file or instantiation failure resolves `available()` to `false`.

`PythonBackend` spawns a script with an explicit stdio JSON protocol, resolving the interpreter through the same candidate-and-probe strategy as `zai-token-refresh.ts:34-95`. It is selected explicitly or via `auto`, and its unavailability is a normal, logged outcome.

### 6. Selection and degradation

`CHAT2API_COMPRESS_BACKEND=ts|wasm|python|auto`, default `ts`.

- `ts` — never probes, never spawns, never loads WASM.
- `wasm` — loads WASM once per process; falls back to `ts` on failure.
- `python` — probes the interpreter once per process; falls back to `ts` on failure.
- `auto` — tries `wasm`, then `python`, then `ts`.

Every fallback logs once per process with the reason. A backend that throws mid-request returns `undefined`, which the decision layer treats as "no compaction", which is the existing behavior.

Backend selection is orthogonal to `CHAT2API_UPSTREAM_TOKEN_OPTIMIZER` mode. The existing `off | dry-run | safe | balanced` axis is unchanged, and `dry-run` still runs the selected backend to measure the candidate without changing the request.

## Configuration Surface

```bash
# Existing, unchanged
CHAT2API_UPSTREAM_TOKEN_OPTIMIZER=off|dry-run|safe|balanced
CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_MIN_TOKENS=20000
CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_RECENT_MESSAGES=8
CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_MIN_SAVINGS=64
CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_MAX_TOOL_TEXT_CHARS=16000

# Added by Phase 1
CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_FROZEN_PREFIX_MESSAGES=0   # live-zone floor; 0 = derive from cache_control

# New
CHAT2API_COMPRESS_BACKEND=ts                      # ts | wasm | python | auto
CHAT2API_COMPRESS_RETRIEVAL=off                   # off | on  (retrieve_tool_output injection)
CHAT2API_COMPRESS_MAX_RETRIEVALS_PER_REQUEST=4
CHAT2API_COMPRESS_ARCHIVE_PATH=                   # default <dataDir>/compression-archive.json
CHAT2API_COMPRESS_ARCHIVE_TTL_MS=86400000
CHAT2API_COMPRESS_ARCHIVE_MAX_CHARS=67108864
CHAT2API_COMPRESS_PYTHON_PATH=                    # trusted outright when set
CHAT2API_COMPRESS_PYTHON_SCRIPT=                  # default /app/scripts/compress/compress.py
CHAT2API_COMPRESS_WASM_PATH=                      # default: getResourcePath('chat2api_compress.wasm')
```

Parsing follows `getUpstreamTokenOptimizerSettings` (`upstreamTokenOptimizer.ts:91-113`): every parser is total, unknown values fall back to the safe default, and an empty string is distinguished from a valid zero. Unknown backend names resolve to `ts`.

## Distribution Support Matrix

| Backend | Electron desktop | Docker server | Artifact | Failure mode |
| --- | --- | --- | --- | --- |
| `ts` | Supported | Supported | none | n/a |
| `wasm` | Supported | Supported | `chat2api_compress.wasm` via `extraResources` + `Dockerfile` `COPY` | falls back to `ts` |
| `python` | Best-effort, requires an interpreter with the dependencies | Supported, `Dockerfile` installs them | `scripts/compress/compress.py` | falls back to `ts` |

Target platforms for the Electron build are `win x64`, `mac arm64`, `linux x64/arm64` (`package.json` `build.win/mac/linux`). A single WASM artifact covers all four; this is the reason the WASM target was chosen over napi.

Honest statement of the Python backend's Electron status: the desktop build does not bundle a Python runtime and this design does not add one. `CHAT2API_COMPRESS_BACKEND=python` on desktop is an operator-provided capability, detected the same way `ZAI_PYTHON_PATH` is today. It is a shipped, supported backend, but an unavailable interpreter degrades to `ts` and is never allowed to fail a request. The Docker image guarantees the interpreter, so the Docker target has full backend coverage out of the box.

## Build and Packaging Changes

| File | Change |
| --- | --- |
| `package.json` `build.extraResources` | Add the WASM artifact, mirroring the `sha3_wasm_bg.7b9ca65ddd.wasm` entry. |
| `Dockerfile` | `COPY --from=build /app/chat2api_compress.wasm ./`, mirroring line 220. |
| `Dockerfile` | `COPY scripts/compress /app/scripts/compress`. |
| `Dockerfile` | `ENV HEADROOM_BINARIES_OFFLINE=1` if the Python backend is ever wired to headroom itself; prevents startup downloads. |
| `docker-compose.yml` | Pass through `CHAT2API_COMPRESS_BACKEND` and the retrieval settings, defaulting to the same values as the Dockerfile. |
| `scripts/check-source-artifacts.js` | `npm run build` runs `check:source-artifacts` first. The compiled `.wasm` is a build output; confirm the gate either ignores it or is configured to skip it. |
| `crates/chat2api-compress/` | New Rust crate, `wasm32-unknown-unknown`, no network, no tokenizer, no ONNX. |

## Measurement

The existing `[Forwarder] upstream-token-optimizer` log at `forwarder.ts:1447-1463` gains fields; the format is additive so existing log consumers keep working.

```
liveZoneFloor, liveZoneCeiling, liveZoneSource      // 'cache-control' | 'frozen-prefix' | 'recent-window'
backend, backendFallbackReason
omittedHashes                                        // count, never the hashes themselves
retrievalToolInjected, retrievalsServed, retrievalsFailed
```

The archive hashes and archived text are never logged. A hash is a content identifier for a tool output that may contain credentials, file contents, or source code.

`routes/responses.ts:430` already records `estimatedInputTokens`; it stays a local estimate and must continue to be labeled as one. Provider-reported usage, where a provider actually returns it, is the only billing truth.

## Testing

Unit:

- `computeLiveZone` — floor from `cache_control`, floor from config, fallback to recent-window, ceiling resolution, and the `safe`-mode-is-unchanged regression case.
- `computeToolPairs` — OpenAI and Anthropic shapes, orphan results, multi-call assistant messages, unresolved continuations.
- `CompressionArchive` — record/resolve, TTL expiry, char-bound eviction, scope isolation between accounts.
- `TsBackend` — the current `safe` and `balanced` fixtures, plus the guarantee that protected line indices survive.
- `retrieve_tool_output` — local resolution, unknown hash, retrieval budget exhaustion.

Integration:

- The server test harness (`npm run test:server-compat`, `tests/server/run-server-tests.mjs`) runs the same proxy tests headless, so backend selection is verified on the Docker build without Electron.
- A test that asserts every backend produces a parseable, byte-stable result for the same input, and that `wasm` and `python` results are byte-identical to `ts` on the fixture corpus. Divergence is a bug, not a tuning difference.

Acceptance gates, taken from `docs/token-optimization-research.md:228-236` and unchanged:

- Task success rate drop ≤ 1 percentage point, with a 95% confidence interval reported.
- Tool-call schema success 100%; all tool names, ids, and key arguments identical between raw and optimized runs.
- Protected regions byte-identical.
- Input token reduction ≥ 15% on long tool-heavy requests.
- Added compression p95 latency ≤ 10% of upstream time-to-first-token, with timeout fallbacks counted.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Archive grows without bound and leaks tool output to disk | TTL + char bound + oldest-first eviction; scope keys prevent cross-account reads; the file lives in the existing data dir with the same permissions as `accounts.json`. |
| A retrieval loop burns context | Per-request retrieval budget, default 4, with a normal protocol error result on exhaustion. |
| Backend divergence makes results environment-dependent | Byte-identical fixture tests across `ts` / `wasm` / `python`; `ts` is always available as the reference. Two implementations of the same rules is a known cost of shipping the Python backend, and the parity suite is the control, not a comment in review. |
| A live-zone floor set too high silently breaks quality | Default `0`; the optimizer log reports the floor source so an operator can see which rule is in effect. |
| `check:source-artifacts` rejects the WASM artifact | Verified before implementation begins; if it does, the artifact is gitignored and produced in the build stage. |
| Someone reads CCR as "lossless" and promotes `balanced` to default | This document and the release note both state that CCR adds recoverability, not fidelity. A lossy span that the model chooses not to retrieve is still lossy. |

## Upstream Sync Policy

New files should be additive and isolated, following the policy in `docs/superpowers/plans/2026-06-11-docker-server.md`:

```text
crates/chat2api-compress/
scripts/compress/
src/main/proxy/services/liveZone.ts
src/main/proxy/services/compressionArchive.ts
src/main/proxy/services/backends/
```

Expected edits to existing upstream-owned files, all of them small:

- `src/main/proxy/services/upstreamTokenOptimizer.ts` — replace the `cutoff` computation, delegate the block rewrite, add settings fields.
- `src/main/proxy/forwarder.ts` — no shape change; only the settings source gains a backend field.
- `src/main/runtime/types.ts` — add process spawning only if the decision is made to route subprocess management through the runtime adapter rather than using `node:child_process` directly. `node:child_process` already works under both targets, so the default is to use it directly and leave `RuntimeAdapter` unchanged.
- `src/main/store/types.ts` — no change; the archive is not part of persisted application config.

## Resolved Decisions

Closed during review on 2026-09-26. Recorded here so the plan document does not re-open them.

| Question | Decision | Consequence accepted |
| --- | --- | --- |
| Ship the Python backend now, or defer it until `ts` and `wasm` are measured in production? | **Ship all three.** | Two implementations of the same compression rules must be kept in parity. The fixture corpus and the byte-identical cross-backend test become a release gate, not a nice-to-have. An extra platform in the test matrix (Python interpreter availability). |
| Should the archive be a single JSON file or per-hash files? | **Single JSON file**, following `nodeJsonStore`. | At the 64 MB default bound, a record write rewrites the file. Revisit only if measured write latency becomes visible in the request path. |
| Should client-supplied `cache_control` breakpoints be honored? | **Honor them.** They only ever make the proxy more conservative, and ignoring them forfeits the cache saving the client explicitly asked for. | Client input steers the live-zone floor. Bounded by the fact that the floor can only move *down* (freeze more), never up. |
| Does CCR's proactive expansion need to exist? | **Deferred.** Only the explicit `retrieve_tool_output` path ships. | Re-open when retrieval telemetry shows the model repeatedly asking for the same span, which is the signal that proactive expansion would pay for itself. |

## Remaining Open Questions

These do not block implementation; each has a stated default.

1. Does the Python backend need the full headroom install, or a minimal subset? A minimal subset containing only `tiktoken` and the `SmartCrusher` / `log_compressor` modules would cut the Docker image growth substantially, but requires maintaining a fork of their package layout. Default: install `headroom-ai` unpatched in Docker, measure image growth, and only then consider a subset.
2. Should `retrieve_tool_output` be exposed as a client-visible tool in the OpenAI-compatible surface, or resolved entirely inside the proxy? Default: resolved entirely inside the proxy, never forwarded upstream, never advertised to the client. Open question is only whether a client that wants explicit control should be able to request it.
3. What is the correct archive scope key when a request has no session id? Default: `providerId:accountId:requestId`, which is correct but produces no cross-turn reuse for clients that do not send a session.
