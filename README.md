# Chat2API

<p align="center">
  <img src="build/icons.png" alt="Chat2API logo" width="128" height="128">
</p>

<p align="center">
  <a href="https://github.com/pyf-feifei/Chat2API/releases"><img src="https://img.shields.io/badge/version-1.4.0-2563eb?style=flat-square" alt="Version 1.4.0"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-2563eb?style=flat-square" alt="GPL-3.0 license"></a>
  <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/Electron-33%2B-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron 33+"></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React 18"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 5"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat-square" alt="macOS, Windows and Linux">
</p>

<p align="center">
  <strong><a href="README_CN.md">中文</a> | <a href="https://chat2api-doc.vercel.app/">Website</a> | <a href="https://chat2api-doc.vercel.app/docs">Documentation</a></strong>
</p>

Chat2API is a cross-platform desktop app and headless server that turns web-based AI provider accounts into one local, OpenAI-compatible gateway. Configure providers and accounts once, then connect the same endpoint to OpenAI SDKs, coding agents, desktop clients, or internal tools.

![Chat2API dashboard](docs/screenshots/preview.png)

## Highlights

- **OpenAI-compatible gateway**: Chat Completions at `/v1/chat/completions`, Responses at `/v1/responses`, legacy Completions at `/v1/completions`, model listing, streaming SSE, API-key authentication, and multimodal message handling. Gemini-compatible generation and file routes are also available under `/v1beta`.
- **Provider and account management**: Add multiple accounts per provider, validate credentials, map client model names, pin a model to a provider or account, and choose round-robin, fill-first, or failover routing.
- **Tool and reasoning compatibility**: Function/custom tool calls, tool-result continuations, reasoning content, web search, deep research, and provider-specific thinking modes are normalized where the upstream service supports them.
- **Long-running request controls**: Context compaction, request and stream deadlines, queue admission, keep-alives, bounded retries, and Qwen session/response recovery.
- **Desktop and server deployments**: Use the Electron UI on macOS, Windows, or Linux, or run the Koa proxy and browser admin UI in Docker without Electron.
- **Operations UI**: Dashboard metrics, request logs, model synchronization, API keys, proxy settings, themes, system tray access, and English/Simplified Chinese localization.
- **Client bridges**: [Codex CLI Responses compatibility](docs/codex.md).

## Supported providers

The built-in catalogue currently includes:

| Provider | Authentication | Built-in models |
| --- | --- | --- |
| DeepSeek | User token | `deepseek-v4-flash`, `deepseek-v4-pro` |
| GLM | Refresh token | `GLM-5.1` |
| Kimi | JWT / web token | `Kimi-K2.6`, `Kimi-K3` |
| MiniMax | JWT | `MiniMax-M2.7` |
| Mimo | Browser cookies | `MiMo-V2.5-Pro`, `MiMo-V2.5`, `MiMo-V2-Flash` |
| Microsoft 365 Copilot | OAuth refresh token (in-app browser login) | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` |
| Perplexity | Session cookie | `Auto` |
| Qwen (China) | SSO ticket | `Qwen3.6`, `Qwen3.7-Max`, `Qwen3.5-Flash`, `Qwen3-Max`, `Qwen3-Max-Thinking-Preview`, `Qwen3-Coder` |
| Qwen AI (International) | JWT, optional cookies and login credentials | `Qwen3.8-Max`, `Qwen3.8-Max_Fast`, `Qwen3.8-Max_Auto`, `Qwen3.8-Max_Thinking`, `Qwen3.7-Plus`, `Qwen3.7-Max` |
| Z.ai | JWT | `GLM-5.1`, `GLM-5-Turbo`, `GLM-5V-Turbo`, `GLM-5`, `GLM-4.7` |

Provider availability and model names follow the upstream web applications and may change. See the [provider notes](docs/providers/README.md) for credential and model-mapping details.

## Install

### Desktop release

Download a platform package from [GitHub Releases](https://github.com/xiaoY233/Chat2API/releases) when a release is available. The source mirror is [pyf-feifei/Chat2API](https://github.com/pyf-feifei/Chat2API).

| Platform | Package |
| --- | --- |
| macOS Apple Silicon | `Chat2API-<version>-mac-arm64.dmg` |
| macOS Intel | `Chat2API-<version>-mac-x64.dmg` |
| Windows | `Chat2API-<version>-x64-setup.exe` or portable build |
| Linux | `Chat2API-<version>-x64.AppImage`, `.deb`, or `.tar.gz` |

### Build from source

Requirements: Node.js 18+, npm, and Git. The Docker image uses Node.js 22.

```bash
git clone https://github.com/pyf-feifei/Chat2API.git
cd Chat2API
npm install
npm run dev:win       # Windows
npm run dev           # macOS/Linux
```

Production packages can be built with:

```bash
npm run build
npm run build:mac
npm run build:win
npm run build:linux
npm run build:all
```

### Docker server

The server image runs the Koa proxy and browser admin UI, stores state in `/data`, and listens on port `8080` by default:

```bash
docker build -t chat2api:server .
docker run -d --name chat2api \
  -p 8080:8080 \
  -v chat2api-data:/data \
  -e CHAT2API_HOST=0.0.0.0 \
  -e CHAT2API_PORT=8080 \
  -e CHAT2API_ENABLE_MANAGEMENT_API=true \
  -e CHAT2API_MANAGEMENT_SECRET=change-me \
  chat2api:server
```

Open `http://localhost:8080/admin/` and use the management secret to sign in. The complete [Docker guide](docs/docker.md) covers Compose, browser-assisted account import, storage encryption, Qwen session repair, and deployment tuning.

## Quick start

1. Launch Chat2API, or start the Docker server.
2. Open **Providers**, add a built-in provider, and enter its web credential. Credentials are stored locally; never commit them to source control.
3. Open **Proxy Settings**, choose a port and routing strategy, then start the proxy.
4. Point an OpenAI-compatible client at `http://127.0.0.1:8080/v1`.

Example with the OpenAI Python SDK:

```python
from openai import OpenAI

client = OpenAI(
    api_key="your-chat2api-key",
    base_url="http://127.0.0.1:8080/v1",
)

response = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "Hello from Chat2API"}],
)

print(response.choices[0].message.content)
```

For Codex CLI, use the Responses endpoint and the configuration in [docs/codex.md](docs/codex.md).

## Network egress: keep provider traffic off your local proxy

Chat2API must reach provider APIs over your **real** network path, not through a
local HTTP/SOCKS proxy. If it does not, an entire class of upstream failures
appears that looks like an account or content problem but is really an egress
problem.

This is not hypothetical. On 2026-09-25 a Windows host with Clash Verge and
`HTTP_PROXY`/`HTTPS_PROXY=http://127.0.0.1:7897` sent **every** provider request
through a `hysteria2` node hosted on `195.242.178.82` — the same machine running
the production deployment. Qwen therefore saw a shared US-datacenter egress
instead of the residential IP, and Aliyun WAF answered with `bxpunish` /
`RGV587` risk verdicts (`qwen_ai_content_verdict`, "egress-IP flag"). The home
IP was never banned; it was simply never used.

### Automatic protection

`src/main/proxy/egressPolicy.ts` runs before any network module in both the
Electron main process and the headless server, and appends the provider domains
to `NO_PROXY`/`no_proxy`. It works because `proxy-from-env` — the resolver axios
uses — reads `process.env` on every request, so the change takes effect
immediately for axios instances that already exist. You do **not** need to
configure anything.

Domains kept direct by default: `.qwen.ai`, `.qianwen.com`, `.aliyuncs.com`,
`.alibabacloud.com`, `.alicdn.com`, plus `localhost` and `127.0.0.1`.

| Variable | Effect |
| --- | --- |
| `CHAT2API_EGRESS_DIRECT=off` | Disable the policy (route provider traffic through the proxy again) |
| `CHAT2API_EGRESS_DIRECT=a.com,b.com` | Replace the built-in list |
| `CHAT2API_EGRESS_DIRECT_EXTRA=c.com` | Append to the built-in list |

### Verify your own egress

```bash
# What your app will use after the policy runs
node -e "const p=require('proxy-from-env');console.log(p.getProxyForUrl('https://chat.qwen.ai/api/v1/chat')||'DIRECT')"

# What the network really is
curl -s https://ipinfo.io/ip
```

`DIRECT` on the first command is expected. If the second command returns a
datacenter AS (`AS7488`, `AS4837` is fine — that is a residential carrier),
something upstream of Chat2API is still proxying.

### Clash Verge / Mihomo

The app-level policy does not cover your browser. If the same account is used in
the browser and through Chat2API on different egresses, the upstream sees the
account "hop" between IPs, which looks like a stolen account. Add the same
domains as `DIRECT` rules in the profile enhancement **before** `MATCH,PROXY`:

```yaml
prepend:
  - DOMAIN-SUFFIX,qwen.ai,DIRECT
  - DOMAIN-SUFFIX,qianwen.com,DIRECT
  - DOMAIN-SUFFIX,aliyuncs.com,DIRECT
  - DOMAIN-SUFFIX,alibabacloud.com,DIRECT
  - DOMAIN-SUFFIX,alicdn.com,DIRECT
```

Edit the profile's **rules enhancement** (`profiles/<uid>.yaml`), not the
subscription body — the subscription is regenerated on every update and your
edits are lost. The mihomo core runs as a Windows service and cannot be killed
from an unprivileged shell, so reload the profile in the UI.

> **Docker note:** Docker Desktop's network layer honours the Windows system
> proxy, so a container with **no** `HTTP_PROXY` in it still egresses through
> the local proxy. Setting `NO_PROXY` inside the container cannot help. For
> Docker deployments these Clash rules are the real fix, not the app policy.

**Full setup, verification and troubleshooting:
[docs/network-egress.md](docs/network-egress.md).**

### Do not run the full account pool from your workstation

Providers rate-limit by **egress IP**, not by account. A pool of ~340 accounts
driven from one IP — especially a shared datacenter one — is an anomaly shape
regardless of how the accounts were obtained. Keep the full pool on the
production server, and use a single account locally for functional checks.

Chat2API enforces this automatically once a verdict appears. A `bxpunish` /
`RGV587` verdict is decided by the egress path, not by one payload, so the
per-request risk circuit is joined by a **process-wide egress circuit**: after
`CHAT2API_QWEN_AI_EGRESS_CIRCUIT_THRESHOLD` distinct payloads (default 3) are
rejected inside `CHAT2API_QWEN_AI_EGRESS_CIRCUIT_WINDOW_MS` (default 5 min), all
new Qwen AI traffic is refused with `503 qwen_ai_risk_circuit_open` and a
`Retry-After` header *before* another account is consumed. One accepted upstream
response closes it again, so a fixed route recovers immediately instead of
waiting out the cooldown.

| Variable | Default | Effect |
| --- | --- | --- |
| `CHAT2API_QWEN_AI_EGRESS_CIRCUIT_THRESHOLD` | `3` | Distinct payloads that must be rejected before the egress is parked; `0` parks on the first verdict |
| `CHAT2API_QWEN_AI_EGRESS_CIRCUIT_COOLDOWN_MS` | `600000` | How long the egress stays parked |
| `CHAT2API_QWEN_AI_EGRESS_CIRCUIT_WINDOW_MS` | `300000` | Window in which verdicts are counted |

## Set the storage encryption key (required)

Account credentials are encrypted at rest. **The key must be identical across
every instance that shares the same data file**, and it must actually reach the
process.

```bash
CHAT2API_STORAGE_ENCRYPTION_KEY=change-this-to-a-long-random-secret
```

Pick a value once, keep it in `.env`, and use the same value for the desktop app
and every Docker deployment of the same store.

```bash
# confirm the key reached the process
docker exec chat2api printenv CHAT2API_STORAGE_ENCRYPTION_KEY
```

> **Start containers with `docker compose up -d`, never `docker run`.** A
> container created with `docker run` has no compose label, so `docker compose up`
> refuses to manage it and `.env` is never injected — the process silently runs
> without the key.

### If the key is missing or does not match

Nothing throws. The runtime returns the `c2a:v1:…` ciphertext unchanged, so every
account is treated as having no session, the repair queue signs in 339 accounts
every 25 s, the upstream answers `401 email not found`, a rejection storm opens
the refresh risk gate (300 s → 600 s → 1200 s → 2400 s), and **every request,
including plain chat, fails `403 qwen_ai_token_refresh_gated`**. It presents as a
risk-control outage; it is a configuration error.

A startup self-check now catches it:

```
[CredentialSelfCheck] Credential data is encrypted (c2a:v1:…) but encryption is
not available. … Set CHAT2API_STORAGE_ENCRYPTION_KEY … and recreate the instance
so the variable actually reaches the process (a container started with `docker run`
never reads .env).
[Store] Initialization aborted: Credential data is encrypted but
CHAT2API_STORAGE_ENCRYPTION_KEY is not usable
```

Fix it and **recreate** the container (environment variables are read once at
process start; `docker restart` is not enough):

```bash
docker compose up -d --force-recreate
```

Fastest way to tell this apart from a real risk-control block — compare the
session-repair line between environments:

```
broken:  [QwenAI Session Repair] started ready=0 pending=339
healthy: [QwenAI Session Repair] started ready=339 pending=0
```

`ready=0 pending=339` means the credentials are unreadable, not that the upstream
is blocking you. Bypass the check with `CHAT2API_CREDENTIAL_SELF_CHECK=off` only
for a genuinely plaintext store.

## Local versus production deployment

Running the desktop app and the Docker server on the same machine against the
same account pool needs a little care.

| Concern | Desktop (workstation) | Docker (production) |
| --- | --- | --- |
| Recommended pool size | 1–3 accounts, functional checks | Full pool |
| Egress | Residential IP, no proxy | Fixed server IP, no proxy |
| Never do | Drive the production pool, or run a load test from here | — |

- **Do not** point a local instance and the production container at the same
  `accounts.json`/`/data` volume while both are running. They will overwrite each
  other's `status`/`errorMessage` fields and each one's repair queue will fight
  the other's verdicts.
- **Do not** run load or soak tests from a workstation. Upstream rate limiting
  is per egress IP, so a local load test degrades the production pool rather
  than measuring the code.
- **Do not** edit a data volume while the container is running. Stop it, edit,
  then start it; otherwise the in-memory state overwrites your change on the next
  save. Back up first:
  ```bash
  docker exec chat2api cat /data/data.json > data.json.backup
  ```
- The desktop app applies the direct-egress policy automatically. If you run the
  Docker image on a host that also has a proxy configured, the headless server
  applies the same policy; set `CHAT2API_EGRESS_DIRECT=off` only if you
  deliberately want the proxy in that path. See
  [docs/network-egress.md](docs/network-egress.md) for the Clash rules a Docker
  host still needs.

Two failure modes that look identical but are unrelated — see
[docs/network-egress.md](docs/network-egress.md#9-symptom--cause):

| Symptom | Root cause |
| --- | --- |
| Egress shows a datacenter AS | Local proxy inherited by Docker Desktop |
| Every request 403, accounts "frozen" | Missing/mismatched storage encryption key |

See also the post-mortem for the 2026-09-25 pool outage:
[docs/diag-2026-09-25-qwen-egress.md](docs/diag-2026-09-25-qwen-egress.md).

## Screenshots

| Dashboard | Providers |
| --- | --- |
| ![Dashboard](docs/screenshots/dashboard.png) | ![Providers](docs/screenshots/providers.png) |

| Proxy settings | API keys |
| --- | --- |
| ![Proxy settings](docs/screenshots/proxy.png) | ![API keys](docs/screenshots/api-keys.png) |

| Models | Sessions |
| --- | --- |
| ![Models](docs/screenshots/models.png) | ![Sessions](docs/screenshots/Session.png) |

## Configuration and data

Desktop data is stored in `~/.chat2api/`; Docker data is stored in the mounted `/data` volume.

| Path | Contents |
| --- | --- |
| `config.json` | Proxy, UI, and application settings |
| `providers.json` | Provider definitions and model mappings |
| `accounts.json` | Account credentials and account state |
| `logs/` | Request logs |

The server supports environment variables for host/port, management API, API keys, storage encryption, load balancing, request deadlines, and provider-specific controls. Start with the examples in [docs/docker.md](docs/docker.md).

## Contributing

Issues, provider updates, tests, and documentation improvements are welcome. Please read the existing provider notes and open an issue before large adapter changes.

```bash
npm install
npm run build
npm run test:server-compat
```

## License

Chat2API is released under the [GNU General Public License v3.0](LICENSE).

## Acknowledgements

[Electron](https://www.electronjs.org/), [React](https://react.dev/), [TypeScript](https://www.typescriptlang.org/), [Tailwind CSS](https://tailwindcss.com/), [Zustand](https://zustand-demo.pmnd.rs/), and [Koa](https://koajs.com/).
