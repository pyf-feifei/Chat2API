# Network Egress and Local Proxy Configuration

This document is the operator-facing companion to the "Network egress" section
of [README.md](../README.md) / [README_CN.md](../README_CN.md). It covers **how
to configure things**, not just why they matter.

> Incident of record: 2026-09-25. See
> [diag-2026-09-25-qwen-egress.md](diag-2026-09-25-qwen-egress.md) for the full
> diagnosis, and [diag-2026-09-22-codex-bxpunish.md](diag-2026-09-22-codex-bxpunish.md)
> for the earlier, content-based verdict (a different failure mode — do not
> confuse the two).

---

## 1. The three layers, and which one actually wins

Understanding this ordering is the single most useful thing on this page.

```
  ┌─ Layer 3 ─ Clash / system proxy ───────────────────────────┐
  │  Decides the socket path for ANY process that consults the  │
  │  system proxy or has HTTP(S)_PROXY set.                    │
  └───────────────────────────┬───────────────────────────────┘
                              │  (per-connection)
  ┌─ Layer 2 ─ NO_PROXY / no_proxy ───────────────────────────┐
  │  Read by proxy-from-env, which axios uses. If a host       │
  │  matches, Layer 3 is skipped for that request.             │
  └───────────────────────────┬───────────────────────────────┘
                              │  (per-URL)
  ┌─ Layer 1 ─ egressPolicy.ts ───────────────────────────────┐
  │  Chat2API appends the provider domains to NO_PROXY at      │
  │  startup, so it normally makes Layer 2 a no-op.            │
  └───────────────────────────────────────────────────────────┘
```

Practical consequences:

| Situation | Result |
|---|---|
| Electron desktop app, host has `HTTPS_PROXY` | Layer 1 forces direct ✅ |
| `npm run dev` / `dev:win` | Layer 1 forces direct ✅ |
| Docker container, **no** proxy env in container | **Layer 3 still applies** ⚠️ |
| Docker container, Clash rules contain the provider domain | Layer 3 routes direct ✅ |
| Docker container, Clash rules missing it | Layer 3 proxies the container ⚠️ |

The Docker row is the one that bit us, and it surprised everyone involved. See
§4.

---

## 2. Layer 1 — the built-in policy (nothing to configure)

`src/main/proxy/egressPolicy.ts` is imported for its side effect by both entry
points:

- `src/main/index.ts` — Electron main process
- `src/server/index.ts` — headless server / Docker

It merges these domains into `NO_PROXY` and `no_proxy`:

```
.qwen.ai  .qianwen.com  .aliyuncs.com  .alibabacloud.com  .alicdn.com
```

plus `localhost` and `127.0.0.1`.

It works because `proxy-from-env` — the resolver axios uses — re-reads
`process.env` on **every** `getProxyForUrl()` call. Appending at runtime
therefore affects axios instances that were already constructed.

### Verify

```bash
node -e "const p=require('proxy-from-env');console.log(p.getProxyForUrl('https://chat.qwen.ai/api/v1/chat')||'DIRECT')"
```

`DIRECT` means the policy is in effect.

### Control

| Variable | Default | Effect |
| --- | --- | --- |
| `CHAT2API_EGRESS_DIRECT` | *(unset → built-in list)* | Replace the list, e.g. `a.com,b.com` |
| `CHAT2API_EGRESS_DIRECT` | — | `off` / `0` / `false` disables the policy |
| `CHAT2API_EGRESS_DIRECT_EXTRA` | *(unset)* | Append to the built-in list |

Set `CHAT2API_EGRESS_DIRECT=off` **only** when you deliberately want provider
traffic to traverse a proxy. Docker Compose sets `on` by default.

### Adding a provider

If a new provider is IP-rate-limited, add its domain to
`DEFAULT_EGRESS_DIRECT_DOMAINS` in the same change. The comment in that file
explains why.

---

## 3. Layer 2 — host `NO_PROXY` (belt and braces)

Not required for Chat2API, but useful for `curl`, Python SDKs, and other tools
you run against the same endpoint.

### Windows

```cmd
setx NO_PROXY "127.0.0.1,localhost,.qwen.ai,.qianwen.com,.aliyuncs.com,.alibabacloud.com,.alicdn.com"
```

Verify and understand the two traps:

```cmd
reg query HKCU\Environment /v NO_PROXY
```

1. **`setx` only affects *new* processes.** Your current terminal, and any
   already-running Electron/Docker process, keeps the old value. Restart the
   shell and the app, or log out and back in.
2. **Turning off the Windows "Proxy" settings page does not help Node/Electron.**
   Node reads `HTTP_PROXY`/`HTTPS_PROXY` environment variables, not WinINET
   settings. This is the single most common false fix.

### macOS / Linux

```bash
export NO_PROXY="127.0.0.1,localhost,.qwen.ai,.qianwen.com,.aliyuncs.com,.alibabacloud.com,.alicdn.com"
# persist in ~/.zshrc or ~/.bashrc
```

---

## 4. Layer 3 — the part that actually caused the incident

### 4.1 Docker Desktop inherits the system proxy

**This is the key finding.** A container with no proxy environment variables at
all still egressed through the local Clash node:

```bash
$ docker exec chat2api sh -c "env | grep -i proxy"
(nothing)

$ docker exec chat2api node -e "fetch('https://ipinfo.io/ip').then(r=>r.text()).then(console.log)"
195.242.178.82      # the Clash node, not the residential IP
```

Docker Desktop's network layer honours the Windows system proxy
(`HKCU\...\Internet Settings\ProxyEnable`). Setting `NO_PROXY` *inside the
container* cannot help, because the container never has an `HTTP_PROXY` to
bypass — the interception happens below the container's network stack.

Therefore: **for Docker deployments, the Clash/mihomo rules in §4.2 are the only
real fix.** Layer 1 is a no-op there.

### 4.2 Clash Verge / mihomo rules

Provider traffic must be routed `DIRECT` in the proxy too, so the browser and
Chat2API share one egress. Otherwise the upstream sees the same account hopping
between IPs, which reads as a stolen account.

Edit the profile's **rules enhancement**, not the subscription itself. In
Clash Verge the subscription body is regenerated on every update, so edits there
are lost.

```
%APPDATA%/io.github.clash-verge-rev.clash-verge-rev/profiles/<uid>.yaml
```

`<uid>` is the profile's `option.rules` value in
`%APPDATA%/io.github.clash-verge-rev.clash-verge-rev/profiles.yaml`.

```yaml
# Profile Enhancement Rules Template for Clash Verge
prepend:
  - DOMAIN-SUFFIX,qwen.ai,DIRECT
  - DOMAIN-SUFFIX,qianwen.com,DIRECT
  - DOMAIN-SUFFIX,aliyuncs.com,DIRECT
  - DOMAIN-SUFFIX,alibabacloud.com,DIRECT
  - DOMAIN-SUFFIX,alicdn.com,DIRECT
  - DOMAIN-SUFFIX,aliyun.com,DIRECT
  - DOMAIN-SUFFIX,dashscope.aliyuncs.com,DIRECT
append: []
delete: []
```

`prepend` is required — it lands ahead of the base profile's `MATCH,PROXY`
catch-all. Merged result:

```
[0]  DOMAIN-SUFFIX,qwen.ai,DIRECT            <- new
...
[7]  DOMAIN-SUFFIX,supiedt.com,DIRECT       <- existing
...
[13] MATCH,PROXY
```

Alternatively, add a merge enhancement with a `rules` array, or edit the
generated `clash-verge.yaml` (fragile: it is rewritten on every profile apply).

### 4.3 Applying the rules

The mihomo core runs as a Windows **service** under SYSTEM, so
`taskkill /PID <core>` fails with "Access is denied" from a normal shell. Reload
the profile from the Clash Verge UI, or restart Clash Verge.

If the core happens to restart after you saved the file, it picks the rules up on
its own — no UI action needed. Check rather than assume (§5).

### 4.4 Reverting

Keep a copy before editing:

```bash
cp profiles/<uid>.yaml profiles/<uid>.yaml.bak-chat2api-egress
```

Restore the backup to undo.

---

## 5. Verifying all three layers

### Layer 1

```bash
node -e "const p=require('proxy-from-env');console.log(p.getProxyForUrl('https://chat.qwen.ai/api/v1/chat')||'DIRECT')"
```

### Layer 2 / 3 — what the host actually uses

```bash
curl -s https://ipinfo.io/ip
```

Judge by the AS number:

| AS / org | Meaning |
| --- | --- |
| `AS4837 CHINA UNICOM` | residential carrier — good |
| `AS7488 CNServer LLC` | datacenter — bad |
| `AS14061`, `AS63949`, `AWS`, `DigitalOcean` | datacenter — bad |

### Layer 3 — the running core's rule table

The most conclusive check, because it reads the **running** core rather than a
file. The controller is a named pipe on Windows, not HTTP:

```powershell
[System.IO.Directory]::GetFiles('\\.\pipe\') |
  Where-Object { $_ -match 'verge|mihomo|clash' }
```

```
\\.\pipe\clash-verge-service
\\.\pipe\verge-mihomo-production-<hash>
```

Query it (the pipe name is **not** the one in `clash-verge.yaml`; that file can
be stale):

```js
// GET /rules over the named pipe, with Bearer <secret from clash-verge.yaml>
[0] DomainSuffix qwen.ai => DIRECT   hitCount=30
```

`hitCount` rising proves live traffic is matching the rule. This is how the
2026-09-25 fix was confirmed: a request issued from inside the container moved
`qwen.ai` `hitCount` from 29 to 30, which simultaneously proved the container's
traffic traverses Clash **and** that it is now routed direct.

### End-to-end

```bash
# One request = one account. Do not loop this.
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"Qwen3.8-Max","messages":[{"role":"user","content":"Reply with exactly: PONG"}]}' \
  | head -c 300
```

Expect `"content":"PONG"` and HTTP 200 in ~3–4 s.

---

## 6. Risk-control circuits

Two independent circuits live in `src/main/proxy/qwenAiRiskCircuit.ts`.

### Per-fingerprint

Blocks a repeat of the exact payload already judged. Configured with:

```
CHAT2API_QWEN_AI_RISK_CIRCUIT_THRESHOLD      (default 2)
CHAT2API_QWEN_AI_RISK_CIRCUIT_COOLDOWN_MS   (default 600000)
```

### Egress-level (process-wide)

A `bxpunish` / `RGV587` verdict is decided by the egress path, **not** by one
payload. The per-fingerprint circuit therefore cannot protect the rest of the
pool: every other in-flight request has a different transcript, a different
fingerprint, and walks a different account. That is how one flagged egress turns
into a pool-wide storm.

Added 2026-09-25. After `THRESHOLD` **distinct** payloads are rejected inside
`WINDOW_MS`, all new Qwen AI traffic is refused with HTTP 503
`qwen_ai_risk_circuit_open` and a `Retry-After` header, *before* another account
is consumed. One accepted upstream response closes it, so a repaired route
recovers immediately instead of waiting out the cooldown.

| Variable | Default | Effect |
| --- | --- | --- |
| `CHAT2API_QWEN_AI_EGRESS_CIRCUIT_THRESHOLD` | `3` | Distinct payloads rejected before the egress is parked; `0` parks on the first verdict |
| `CHAT2API_QWEN_AI_EGRESS_CIRCUIT_COOLDOWN_MS` | `600000` | How long the egress stays parked |
| `CHAT2API_QWEN_AI_EGRESS_CIRCUIT_WINDOW_MS` | `300000` | Window in which verdicts are counted |

Counting *distinct fingerprints* rather than raw verdicts is deliberate: one
request replayed across a dozen accounts is a single signal, while a dozen
different payloads all failing is exactly the pattern worth stopping for.

**Watch the logs:**

```
[Egress] Provider traffic forced direct. proxy=... no_proxy=...
[QwenAI] egress risk circuit opened; pausing Qwen traffic {"distinctFingerprints":3,...}
[QwenAI] egress risk circuit open; request refused before pool dispatch {"retryAfter":600}
```

The second line means the egress is parked. Do not "retry harder" — that is what
opens the circuit in the first place. Fix the route, or wait.

---

## 7. Account pool sizing

Upstream rate limiting is keyed on **egress IP**, not on account. A pool of ~340
accounts behind one IP — above all a shared datacenter one — is an anomaly shape
regardless of how the accounts were obtained.

| | Desktop / workstation | Docker (production) |
| --- | --- | --- |
| Pool size | 1–3 accounts, functional checks | Full pool |
| Egress | Residential IP, no proxy | Fixed server IP, no proxy |
| Never | Drive the production pool, or load-test from here | — |

- Do **not** point a local instance and the production container at the same
  `accounts.json` / `/data` volume while both run. They overwrite each other's
  `status` / `errorMessage`, and each one's repair queue fights the other's
  verdicts.
- Do **not** run load or soak tests from a workstation. Per-IP limiting means a
  local load test degrades the production pool instead of measuring the code.
- Running the *same* account IDs on both sides is not a filesystem problem but a
  signal problem: the upstream sees one account alternating between a residential
  IP and a datacenter IP.

### Storage isolation, for reference

```
local:  type=volume  /var/lib/docker/volumes/chat2api_chat2api-data/_data -> /data
```

A named volume, no host bind mount — so `~/.chat2api/` and the container are
independent. Confirm with:

```bash
docker inspect chat2api --format '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
```

`type=bind` pointing at a host directory that also backs production is the thing
to catch.

---

## 8. Local development checklist

```bash
# 1. confirm the policy is compiled in
node -e "const p=require('proxy-from-env');console.log(p.getProxyForUrl('https://chat.qwen.ai/api/v1/chat')||'DIRECT')"
#    -> DIRECT

# 2. confirm the real egress is residential
curl -s https://ipinfo.io/ip
#    -> an AS4837-style carrier, not AS7488

# 3. start the app
npm run dev:win          # Windows
npm run dev              # macOS / Linux

# 4. one request, one account — never a loop
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"Qwen3.8-Max","messages":[{"role":"user","content":"Reply with exactly: PONG"}]}'
```

For Docker, rebuild first — the code is baked into the image:

```bash
docker build -t chat2api-local:latest -f Dockerfile .
docker compose up -d --force-recreate
docker logs chat2api 2>&1 | grep -i egress
```

---

## 8.5 Containers: Docker Desktop Forces a VM-Level Proxy

The single most misdiagnosed failure in this project. It produced a long run of
wrong conclusions on 2026-09-25/26 - IP reputation, user-agent persona, cookie
freshness, token type and "the slider" were each blamed, and each was wrong.

### Symptom

Every container request comes back as an aliyun WAF challenge, while the same
account in the host browser works fine:

```
<meta name="aliyun_waf_aa" content="ff926c7f07e45e2e487a29a6197d3460">
```

### Diagnosis: two commands

```bash
$ docker info | grep -A2 "^ *Proxy"
 HTTP Proxy:  http.docker.internal:3128
 HTTPS Proxy: http.docker.internal:3128

$ curl -s --noproxy '*' https://ipinfo.io/ip
221.213.36.92                                            # host, real egress
$ docker exec chat2api node -e "fetch('https://ipinfo.io/ip').then(r=>r.text()).then(console.log)"
195.242.178.82                                            # NOT the same
```

Different addresses mean Docker Desktop routes all container traffic through its
VM proxy. The WAF verdict is about that egress, not about the request.

### Fix

1. Windows system proxy off (`ProxyEnable=0`) - otherwise Docker re-applies it
   on every start.
2. Docker Desktop proxy mode -> manual with no address. Persisted in
   `%APPDATA%\Docker\marlin.dat` as
   `"proxyHTTPMode":{"Source":"defaults","Value":"system",...}` -> `"manual"`.
3. Restart Docker Desktop, then confirm `docker info` reports no proxy and the
   container egress matches the host's.

### What not to try

Setting `HTTP_PROXY=` / `NO_PROXY=*` inside the container, `--network host`,
editing `~/.docker/config.json`, or toggling the Windows proxy page alone - all
measured on 2026-09-26, all ineffective. The proxy is applied in the VM network
layer, below the container's own stack and above its filesystem.

### After the fix

Clash rules are no longer what rescues the container, because traffic never
enters mihomo. One clean residential egress is more predictable than rotating a
proxy pool. Webshare stays useful as a fallback - the forwarder engages it only
after a verdict - not as the primary path.

### DNS poisoning masquerades as an invalid key

`proxy.webshare.io` is DNS-poisoned on filtered networks. Every resolver returns
Meta or Dropbox addresses, so the pool sync fails with
`401 Webshare API rejected the key` for **every** key, which reads exactly like
bad credentials:

```
2a03:2880:...:face:b00c::   Meta        108.160.163.117   Dropbox
162.125.80.5 / 157.240.8.36               54.89.135.129
```

`face:b00c` in an IPv6 answer is Meta's signature. A Chinese resolver's own DoH
endpoint can be poisoned as well, so DoH is not automatically a fix.

```bash
# poisoned direct, clean through a tunnel
curl -s --noproxy '*' https://proxy.webshare.io/api/v2/proxy/list/ -o /dev/null -w '%{http_code}\n'
curl -s --proxy http://127.0.0.1:7897 https://proxy.webshare.io/api/v2/proxy/list/ -o /dev/null -w '%{http_code}\n'
```

`000` direct and `200` tunnelled is poisoning, not a bad key. Pin the real
addresses - fetched from a resolver on the clean path - with `extra_hosts` so
they survive a container recreate:

```yaml
extra_hosts:
  - "proxy.webshare.io:54.38.13.175"
```

Validate a candidate before pinning:
`docker run --rm --add-host "proxy.webshare.io:<ip>" <image> ...`

### Storing the pool by hand

`webshareProxyConfig` is stored **in plain text**: `normalizeWebshareApiKey` and
`normalizeWebshareEntry` in `src/main/store/types.ts` do not encrypt
`apiKey` / `proxyUrl`. Encrypting them by hand - natural, since every other
credential in the store is encrypted - makes the runtime transmit the ciphertext
as the key, which surfaces only as a sync `401`. Check the normaliser before
hand-editing `data.json`.

### Report a pool by usable count, not record count

`entries: 180` counts records, not working proxies. Probe before claiming a pool
is usable. On 2026-09-26 the local pool held 180 records: 160 stale ones
returning `402 Bandwidth limit` and 20 live ones from a fresh key. "180 enabled"
was wrong; 20 were usable. State the usable count and which subset was tested.

---

## 9. Symptom → cause

| Symptom | Likely cause | Where to look |
| --- | --- | --- |
| **Container** always returns `aliyun_waf_aa`, browser works | Docker Desktop VM proxy forcing all container traffic through a proxy | `docker info \| grep -A2 "^ *Proxy"`; §8.5 |
| Every Webshare key returns `401` simultaneously | `proxy.webshare.io` is DNS-poisoned, so no request reaches Webshare | `nslookup proxy.webshare.io`; pin real IPs via `extra_hosts` |
| **Every** request `403 qwen_ai_token_refresh_gated`, accounts look frozen, `401 email not found` | **Missing or mismatched `CHAT2API_STORAGE_ENCRYPTION_KEY`** | `[Session Repair] started ready=0 pending=339`; `docker exec <c> printenv CHAT2API_STORAGE_ENCRYPTION_KEY`. See §10 |
| `ready=339 pending=0` on one host but `ready=0 pending=339` on another | Same store, different key (or one host never got the variable) | Compare the two startup lines; compare key length and value |
| `qwen_ai_content_verdict`, `RGV587`, `bxpunish` | Egress IP flagged, **or** genuine content match | `ipinfo.io/ip`; compare against the [2026-09-22 diagnosis](diag-2026-09-22-codex-bxpunish.md) |
| `qwen_ai_risk_circuit_open` | Egress parked after repeated verdicts | Wait, or fix the route; do not retry harder |
| WAF slider / `aliyun_waf_aa` HTML instead of JSON | Request reached an endpoint that needs a session (`/api/v2/*`) without one, or an expired `acw_tc` | Re-login to refresh cookies; **not** necessarily an IP ban |
| Works in the browser, fails in the app | Browser and app on different egresses, or the app's cookie jar is incomplete | §4.2 — align the Clash rules |
| Worked yesterday, fails after a Clash change | Subscription update overwrote the rules | Re-apply the enhancement (§4.2) |
| `docker compose up` reports the name is already in use | The container was created with `docker run` and has no compose label | `docker inspect <c> --format '{{index .Config.Labels "com.docker.compose.project"}}'` — remove it and recreate via compose |
| `no_available_account`, many accounts `inactive` | Repair-queue deadlock | `qwenAiSessionRepair.ts`, `qwen-ai-token-refresh.ts` |
| All accounts fine, one provider 403 at startup | Provider-side credential/region check | `[ProviderChecker]` in container logs |

**The single most useful discriminator** for the first two rows: read the
`[QwenAI Session Repair] started ready=N pending=M` line. `ready=0 pending=N`
means the credentials cannot be read; `ready=N pending=0` means the pool is fine.
Do not chase egress when the number says `ready=0`.

---

## 10. Storage encryption key

Credentials are encrypted at rest with `aes-256-gcm` under
`CHAT2API_STORAGE_ENCRYPTION_KEY` (`sha256` of the value, `iv|tag|ciphertext`).
The key must be identical for every instance sharing a data file.

```bash
CHAT2API_STORAGE_ENCRYPTION_KEY=change-this-to-a-long-random-secret
```

```bash
# does the key reach the process?
docker exec chat2api printenv CHAT2API_STORAGE_ENCRYPTION_KEY
```

### The failure mode (2026-09-26)

A container created with `docker run` never received the key; the key was later
written into `.env` without recreating the container. Nothing threw. The runtime
returned the ciphertext unchanged, so:

```
all 340 accounts look session-less
  → ready=0 pending=339, one signin per account every 25 s
  → signins carry garbage credentials → 401 "email not found"
  → rejection storm → refresh risk gate 300s → 600s → 1200s → 2400s
  → all requests fail 403 qwen_ai_token_refresh_gated
```

The accounts were healthy. Production, which had the key, showed
`ready=339 pending=0` and issued zero signins.

### The self-check

`src/main/store/credentialSelfCheck.ts` runs from `StoreManager.initialize()`:

| Check | Condition | Severity |
| --- | --- | --- |
| 1 | A credential value still carries `c2a:v1:` **after** decryption | fatal — refuses to start |
| 2 | Everything decrypts but no account has a `token=` cookie | loud WARNING |

Readability is judged by the data, not by the runtime flag: with a key
configured, stored values are *expected* to carry the prefix, so decrypt first
and inspect what is left. Bypass with `CHAT2API_CREDENTIAL_SELF_CHECK=off` for a
genuinely plaintext store.

### Operating rules

1. Start containers with `docker compose up -d`. `docker run` bypasses `.env`.
2. After editing `.env`, recreate — variables are read once at process start.
3. Never edit a data volume while the container runs; stop it first.
4. Back up before touching any store file:
   ```bash
   docker exec chat2api cat /data/data.json > data.json.backup
   ```


**Before concluding "my IP is banned", always print the app's egress and the
browser's egress side by side.** In the 2026-09-25 incident they were the same
address, which made a broken A/B comparison look conclusive and sent the
diagnosis in the wrong direction for an entire session.
