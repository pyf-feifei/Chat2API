# Image Slimming Acceptance Results

> Results for [`plans/2026-09-26-provider-neutral-image-slimming.md`](./2026-09-26-provider-neutral-image-slimming.md) Phase 6.
> Date: 2026-09-26. Environment: local workspace, no production traffic.

## What was measured

| Check | Result | Where |
| --- | --- | --- |
| Non-vision providers are byte-identical under `always` and `off` | PASS | `image-slim-rollout.test.ts` — all 5 non-vision provider ids return no policy at either mode |
| Unknown / custom providers are never slimmed | PASS | same file, 3 ids |
| The default is `off` with a clean environment | PASS | same file |
| The mode does not inherit the Qwen value | PASS | same file; `CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES=always` with no `CHAT2API_REPLAY_SLIM_IMAGES` leaves GLM at `off` |
| A vision provider is measurably slimmed | PASS | 3 of 4 image messages slimmed, `charsSlimmed >= 600,000` for 200 KB payloads |
| `keepFirst` retains the earliest attachments | PASS | survivors are exactly `[0, 1, 4]` for first=2 / last=1 |
| The newest image survives every configuration | PASS | asserted in Phase 3, Phase 4 and here |
| The raw capture measurement is reproducible | PASS | 181 tool outputs, 17 with images, image token share 90.7% |
| The rollout default is still `off` in `docker-compose.yml` | PASS | asserted against the compose file, not a comment |

## Live validation against a real container (2026-09-26)

Two harnesses, both read-only with respect to stored accounts and keys:
`scripts/compress/validate-live.mjs` and `scripts/compress/validate-features.mjs`.
The container ran the image built from this working tree.

> **The first runs of every check here were invalid, for reasons worth keeping.**
> The container was started without `CHAT2API_STORAGE_ENCRYPTION_KEY`, so all
> 339 credentials were unreadable and every request was refused at the token
> refresh. Those refusals were misread as an IP or WAF problem. See
> [Credential Encryption](#credential-encryption-a-missing-key-looks-exactly-like-risk-control)
> in AGENTS.md; the one-second tell is the `[Session Repair] started ready=0
> pending=339` line. With the key supplied it reads `ready=339 pending=0` and
> requests succeed.

### Token saving, measured — 32.4%

The proxy computes and logs the saving **before** the upstream call, so this is
the number of tokens that would actually be sent, and it does not need the
upstream to answer. Corpus: five slices of a real Codex capture, 880 messages,
57 image-bearing, up to 9.9 MB per request.

| request | before | after | saved | |
| --- | ---: | ---: | ---: | ---: |
| 1 (21 msg) | 524,905 | 524,905 | 0 | `insufficient_savings` |
| 2 (61 msg) | 560,781 | 545,603 | 15,178 | 2.7% |
| 3 (121 msg) | 932,358 | 670,891 | 261,467 | 28.0% |
| 4 (241 msg) | 1,359,577 | 720,812 | 638,765 | 47.0% |
| 5 (436 msg) | 1,412,182 | 773,417 | 638,765 | 45.2% |

Image slimming replaced 2 messages carrying 11,383,132 characters. 4,666,454
characters were archived for retrieval. No hash appears in any log line.

**Baseline 4,789,803 → sent 3,235,628 → saved 1,554,175 (32.4%).**

Image slimming runs in the route, ahead of the forwarder, so the optimizer's
`before` already includes it. The two figures are **not additive**; the only
sound total is baseline minus after. A first run added them and reported
**252%**, which is impossible, and the sanity check is what caught it.

### Default off — proven

With no feature variables set, the proxy logged **zero** lines from the
optimizer, the image slimming, or the retrieval loop. That is the guarantee a
default deployment is unaffected, measured rather than asserted.

### Quality, arm A — passed

Arm A holds tasks answerable from the current turn alone, where nothing the
features remove is load bearing. Each task carries a checkable expected value,
so no judge is involved.

```
off 8/10    on 8/10    delta +0.0 pp    regressions 0
```

Two tasks are answered wrongly in both states (`reverse`: the model transposes
`chat2api` into `ipa2tahc`; `count`: it miscounts). Those are model capability
limits, stable across the switch, and they are the reason the task set has
discriminating power.

A first pass reported a `json` regression that was a **scoring defect**: the
model pretty-printed its answer, and a whitespace-sensitive substring check
called identical data wrong. The result files keep the raw replies precisely so
the scoring could be corrected offline without spending another request.

At n=10 one flipped answer moves the rate by 10 pp. This bounds the effect; it
does not establish it at the 1 pp level the gate asks for.

### Quality, arm B — NOT measured

Arm B asks whether tasks whose answer lives only in old context survive. This
is where the features are lossy by design, and the number is the price of the
saving rather than a pass condition. It could not be obtained.

Three attempts, three failures, all environmental:

1. **Sequential arms are confounded.** Running all tasks off, then starting a
   second container and running them on, means the second arm always runs later
   on a pool the first arm already spent. Time order and treatment are aligned.
   The measured `-87.5 pp` was entirely `qwen_ai_content_verdict` and
   `qwen_ai_risk_circuit_open`.
2. **Interleaving fixes the design but not the pool.** `quality-interleaved.mjs`
   alternates the container state per task. It got as far as the first task
   before Docker Desktop stopped, and by then even `137 + 486` returned a
   content verdict.
3. **The pool was being consumed by another run.** Two further containers were
   active against the same 339-account volume while this ran, so a clean window
   did not exist. At the end a bare `Reply with exactly: PONG` returned
   `bxpunish/RGV587` and the risk circuit opened for 580 s.

339 accounts behind one egress is itself the anomaly shape AGENTS.md warns
about, and a verification run stays under it or it measures the rate limiter
instead of the feature. **The workable shape is a small dedicated pool on a copy
of the data, with wide gaps, during a quiet window.** That needs an explicit
decision because it means writing account state.

### Summary of what the live run established

| Claim | Status | Evidence |
| --- | --- | --- |
| A real request still works through the proxy | **measured** | 3/3 `200` with `content: "OK"`, streaming normal |
| Token saving on a real corpus | **measured** | 32.4%, proxy's own before/after |
| A default deployment is unaffected | **measured** | zero feature log lines |
| Compression does not harm current-turn tasks | **measured, n=10** | +0.0 pp, zero regressions |
| Tool calls stay well formed | **observed** | `toolCallCount=0` in every reply, both states |
| Compression harms old-context tasks | **not measured** | the pool rate limit, not a result |
| Success rate drop <= 1 pp | **not established** | n=10 bounds the effect at ~10 pp granularity |


Two harnesses, both read-only with respect to stored accounts and keys:
`scripts/compress/validate-live.mjs` and `scripts/compress/validate-features.mjs`.
The container ran the image built from this working tree, on a **copy** of the
real 439-account data volume (`chat2api-validate`), never the live one.

### The three defects a real run found that unit tests could not

None was caught by a unit test, because every harness stubs the forwarder's own
modules and a missing import or an out-of-scope reference never reaches the
failing line.

1. **The CCR archive was never written.** `optimizeUpstreamRequest` was called
   with no `CompressionContext`, so `archiveOmission` declined every span and
   balanced mode produced an unaddressable marker. The log said
   `archivedCount: 0` on a request that dropped 18,399 characters.
2. **A temporal-dead-zone read of `modifiedRequest`**, which is declared further
   down the function. The fail-open catch turned it into a warning, so the
   request degraded silently instead of failing loudly.
3. **`runWithLocalToolContext` was used but never imported**, and
   `createRetrievalToolContext` referenced a `context` it did not receive. Both
   surfaced as `X is not defined` returned to the client as a 500.

`tests/server/forwarder-import-integrity.test.ts` now checks the forwarder's
imports and parameter references statically. It was verified by reverting the
missing import and confirming the guard fails.

### One thing that looked broken and was not

`[ChatSlim]` did not appear on the first armed run. That was the precedence rule
working: `imageSlimModeFromEnv` reads the Qwen variable family for `qwen-ai`, and
the run had set only the provider-neutral one. The harness was wrong, not the
code, and the same applied to the keep counts and to
`CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_RECENT_MESSAGES`, which left the live-zone
ceiling at index 1 and made every message ineligible.

## Outstanding after live validation

These gates need traffic this repository does not have. They are **outstanding**,
not passed, and no default should be flipped on the strength of the live run
above.

| Gate | Source | Status |
| --- | --- | --- |
| Task **success rate** delta at the 1 pp level with a 95% confidence interval | design doc, acceptance | **outstanding** — arm A was measured at n=10, where one flipped answer is 10 pp. It bounds the effect; it does not establish it. Arm B was not obtained at all. |
| Whether compression harms tasks that **depend on old context** | this document, arm B | **outstanding** — the shared 339-account pool rate-limited every attempt. This is the number an operator needs before enabling `balanced`, and it is the one thing still missing. |
| **Tool-call schema** success stays at 100% with slimming on | design doc, acceptance | **partially observed** — `toolCallCount=0` in every reply on both arms, so nothing was corrupted. No task in the set actually exercised a tool call, so this is an absence of damage rather than a pass. |
| Added p95 latency against upstream time-to-first-token | design doc, acceptance | **outstanding** — no run completed enough requests to form a distribution |
| The **production** image share after rollout | Phase 0 Task 0.2 | **outstanding** — the 90.7% figure is a single local capture. `npm run corpus:stats` reproduces it; it does not generalize |
| Behaviour on a provider not in the capability table | Phase 1 | **by construction** — unlisted providers resolve to not-eligible and log once. Not verified against a real custom provider |

## The one assertion that is expected to go red

`image-slim-rollout.test.ts` asserts the raw capture's image share is still above
0.8, and `image-slim-capability.test.ts` asserts the same against the raw
capture rather than the redacted corpus. Neither number moves on its own: the raw
capture is a fixed local fixture.

What moves is the **live** share a deployment experiences. The honest claim
available today is:

> With `CHAT2API_REPLAY_SLIM_IMAGES=always` and `KEEP_LAST=1`, a replay of N
> image-bearing messages drops `N-1` of them. On the captured replay that is 16
> of 17, which bounds the reduction at roughly 90% of the image payload and
> therefore roughly 82% of the total estimated input tokens for that request.

That is a bound derived from the keep-set arithmetic. The live run above measured
32.4% end to end on a real corpus, which is the observation that replaces it.

## Default

Unchanged. `CHAT2API_REPLAY_SLIM_IMAGES=off`.

Promoting it is a separate decision that needs the outstanding rows above. The
reason is specific rather than general caution: the feature is a **downgrade of
information the model previously had**. A model that loses visual access to a
screenshot from ten turns ago may produce a confidently wrong answer, and no
local test can detect that. Only a task-quality measurement can.
