# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

Chat2API Manager is an Electron desktop application that provides an OpenAI-compatible API proxy for multiple AI service providers (DeepSeek, GLM, Kimi, MiniMax, Qwen, Z.ai, Perplexity). It enables using any OpenAI-compatible client with these providers across macOS, Windows, and Linux.

## Build Commands

```bash
# Development
npm run dev              # Start dev server (macOS/Linux)
npm run dev:win          # Start dev server (Windows)

# Build
npm run build            # Build the application
npm run build:mac        # Build for macOS (dmg, zip)
npm run build:win        # Build for Windows (nsis)
npm run build:linux      # Build for Linux (AppImage, deb)
npm run build:all        # Build for all platforms

# Preview production build
npm run preview
```

## Architecture

```
src/
├── main/                    # Electron main process
│   ├── index.ts            # App entry point
│   ├── ipc/                # IPC handlers (main ↔ renderer communication)
│   ├── proxy/              # Proxy server (Koa)
│   │   ├── server.ts       # HTTP server with middleware
│   │   ├── forwarder.ts    # Request forwarding logic & auth
│   │   ├── adapters/       # Provider-specific adapters
│   │   ├── routes.ts       # Proxy routes registration
│   │   ├── sessionManager.ts # Multi-turn conversation management
│   │   └── services/       # Prompt injection & prompt generation
│   ├── oauth/              # OAuth authentication
│   │   ├── manager.ts      # OAuth flow orchestration
│   │   ├── inAppLogin.ts   # In-app browser login with token auto-extraction
│   │   └── adapters/       # Provider-specific OAuth adapters
│   ├── providers/          # Provider configurations
│   │   ├── builtin/        # Built-in provider configs (one file per provider)
│   │   └── custom.ts       # Custom provider support
│   ├── store/              # Persistent storage (electron-store)
│   │   ├── store.ts        # Main store manager with IPC bridge
│   │   ├── types.ts        # Type definitions and default values
│   │   └── config.ts       # Configuration management
│   └── tray/               # System tray integration
├── preload/                # Context bridge (IPC API exposure)
├── renderer/               # React frontend
│   ├── components/         # UI components
│   ├── pages/              # Page components
│   ├── stores/             # Zustand state management
│   └── i18n/               # Internationalization (en-US, zh-CN)
└── shared/                 # Shared types between main and renderer
```

## Key Concepts

### Provider Adapters
Each AI provider has a dedicated adapter in `src/main/proxy/adapters/` that handles:
- Message format conversion (OpenAI format → provider-specific format)
- Authentication header construction
- Stream response parsing
- Multi-turn conversation context

To add a new provider:
1. Create config in `src/main/providers/builtin/<provider>.ts`
2. Create OAuth adapter in `src/main/oauth/adapters/<provider>.ts`
3. Create proxy adapter in `src/main/proxy/adapters/<provider>.ts`
4. Create stream handler in `src/main/proxy/adapters/<provider>-stream.ts`
5. Register in `src/main/providers/builtin/index.ts` and `src/main/proxy/adapters/index.ts`

### IPC Communication
All main-renderer communication uses IPC channels defined in `src/main/ipc/channels.ts`. The naming convention is `domain:action` (e.g., `proxy:start`, `accounts:add`).

### Session Management
Multi-turn conversations are managed by `sessionManager.ts`:
- `single` mode: Session deleted after each chat
- `multi` mode: Session persists with parent message IDs for context

### Tool Prompt Injection
For models without native function calling, prompts are injected via `promptInjectionService.ts`. This enables function calling compatibility with clients like Cherry Studio and Kilo Code.

### Session Management Flow
1. Client sends request with `sessionId`
2. `sessionManager.ts` retrieves session or creates new one
3. For `multi` mode: parentMessageId is used to fetch conversation history
4. Adapter creates/uses provider-specific session
5. Response is returned with new parentMessageId for context continuation

## Data Storage

Application data is stored in `~/.chat2api/`:
- `config.json` - Application configuration
- `providers.json` - Provider settings
- `accounts.json` - Account credentials (encrypted)
- `logs/` - Request logs

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | Electron 33+ |
| Frontend | React 18 + TypeScript |
| Styling | Tailwind CSS |
| State | Zustand |
| Build | Vite + electron-vite |
| Server | Koa |

## Coding Guidelines

### Immutability (CRITICAL)
ALWAYS create new objects, NEVER mutate existing ones. Use `update` functions that return new copies.

### Error Handling
Handle errors comprehensively:
- Validate all user input before processing
- Provide user-friendly error messages in UI-facing code
- Log detailed error context on the server side
- Never silently swallow errors

### Input Validation
Validate at system boundaries (user input, external APIs). Use schema-based validation where available.

### Security
- Validate all API keys before use
- Sanitize all user inputs
- Never trust external data (API responses, user input, file content)
- Rotate any exposed secrets immediately

## macOS Development Note

A workaround is applied for V8 JIT compiler crash on macOS ARM64 (Electron 33 bug):
```typescript
app.commandLine.appendSwitch('js-flags', '--jitless --no-opt')
```
This trades some performance for stability.

## Adding a New Provider

### Overview

Adding a new provider requires modifications across 4 layers: Provider Config, OAuth Authentication, Proxy Adapter, and UI. The following guide covers all necessary steps.

### Core File Modification Checklist

#### 1. Provider Config Layer (Required)

| File | Purpose |
|------|---------|
| `src/main/providers/builtin/<provider>.ts` | Provider configuration definition |
| `src/main/providers/builtin/index.ts` | Register provider in `builtinProviders` array |
| `src/main/store/types.ts` | Sync to `BUILTIN_PROVIDERS` array |

#### 2. OAuth Authentication Layer (Required)

| File | Purpose |
|------|---------|
| `src/main/oauth/adapters/<provider>.ts` | OAuth adapter implementation |
| `src/main/oauth/adapters/index.ts` | Register in `createAdapter()` and `getSupportedAuthMethods()` |
| `src/main/oauth/types.ts` | Add to `MANUAL_TOKEN_CONFIGS` (optional) |

#### 3. Proxy Adapter Layer (Required)

| File | Purpose |
|------|---------|
| `src/main/proxy/adapters/<provider>.ts` | Proxy adapter implementation |
| `src/main/proxy/adapters/<provider>-stream.ts` | Stream handler implementation |
| `src/main/proxy/adapters/index.ts` | Export adapter |
| `src/main/proxy/forwarder.ts` | Add `forward<Provider>()` method |

#### 4. UI Layer (Required)

| File | Purpose |
|------|---------|
| `src/renderer/src/i18n/locales/zh-CN.json` | Chinese translations |
| `src/renderer/src/i18n/locales/en-US.json` | English translations |
| `src/renderer/src/components/providers/ProviderCard.tsx` | Add icon mapping |
| `src/assets/providers/<provider>.svg` | Provider icon file |

### Step-by-Step Implementation

#### Step 1: Provider Configuration

```typescript
// src/main/providers/builtin/<provider>.ts
import type { BuiltinProviderConfig } from '../../store/types'

export const providerConfig: BuiltinProviderConfig = {
  id: 'provider-id',
  name: 'Provider Name',
  type: 'builtin',
  authType: 'userToken',  // See AuthType section below
  apiEndpoint: 'https://api.example.com',
  chatPath: '/chat/completions',
  headers: {
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'Origin': 'https://example.com',
    'Referer': 'https://example.com/',
  },
  enabled: true,
  description: 'Provider description',
  supportedModels: ['Model-1', 'Model-2'],
  modelMappings: {
    'Model-1': 'model-1-id',
    'Model-2': 'model-2-id',
  },
  credentialFields: [
    {
      name: 'token',
      label: 'Token',
      type: 'password',
      required: true,
      placeholder: 'Enter token',
      helpText: 'How to get token',
    },
  ],
  tokenCheckEndpoint: '/api/user',    // Optional
  tokenCheckMethod: 'GET',            // Optional
}

export default providerConfig
```

#### Step 2: Register Provider

```typescript
// src/main/providers/builtin/index.ts
import providerConfig from './provider'

export const builtinProviders: BuiltinProviderConfig[] = [
  // ...existing
  providerConfig,
]

export const builtinProviderMap: Record<string, BuiltinProviderConfig> = {
  // ...existing
  'provider-id': providerConfig,
}

export { providerConfig }
```

**CRITICAL**: Must also update `src/main/store/types.ts` `BUILTIN_PROVIDERS` array with identical configuration.

#### Step 3: OAuth Adapter

```typescript
// src/main/oauth/adapters/<provider>.ts
import axios from 'axios'
import { BaseOAuthAdapter } from './base'
import { OAuthResult, OAuthOptions, TokenValidationResult, AdapterConfig } from '../types'

const API_BASE = 'https://api.example.com'

export class ProviderAdapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'provider-id',
      authMethods: ['manual'],
      loginUrl: API_BASE,
      apiUrl: API_BASE,
    })
  }

  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    await shell.openExternal(API_BASE)
    return {
      success: false,
      providerId: options.providerId,
      error: 'Please log in via browser and enter Token manually',
    }
  }

  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const token = credentials.token
    if (!token) return { valid: false, error: 'Token cannot be empty' }

    try {
      const response = await axios.get(`${API_BASE}/api/user`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15000,
        validateStatus: () => true,
      })

      if (response.status !== 200) {
        return { valid: false, error: 'Token is invalid or expired' }
      }

      return {
        valid: true,
        tokenType: 'access',
        accountInfo: {
          userId: response.data.id,
          email: response.data.email,
          name: response.data.name,
        },
      }
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Validation failed' }
    }
  }

  async refreshToken(credentials: Record<string, string>) {
    return null  // Optional
  }
}

export default ProviderAdapter
```

#### Step 4: Register OAuth Adapter

```typescript
// src/main/oauth/adapters/index.ts
export { ProviderAdapter } from './provider'

export function createAdapter(providerType: ProviderType, config: AdapterConfig): BaseOAuthAdapter {
  switch (providerType) {
    // ...existing
    case 'provider-id':
      return new ProviderAdapter(config)
    default:
      throw new Error(`Unsupported provider type: ${providerType}`)
  }
}

export function getSupportedAuthMethods(providerType: ProviderType): string[] {
  switch (providerType) {
    // ...existing
    case 'provider-id':
      return ['manual']
    default:
      return ['manual']
  }
}
```

#### Step 5: Proxy Adapter

```typescript
// src/main/proxy/adapters/<provider>.ts
import axios, { AxiosResponse } from 'axios'
import { Account, Provider } from '../../store/types'

const API_BASE = 'https://api.example.com'

export class ProviderAdapter {
  private provider: Provider
  private account: Account
  private token: string

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
    this.token = account.credentials.token || ''
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{
    response: AxiosResponse
    sessionId: string
  }> {
    // 1. Get/refresh token
    // 2. Build request
    // 3. Send request
    // 4. Return response
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return true
  }

  static isProviderProvider(provider: Provider): boolean {
    return provider.id === 'provider-id' || provider.apiEndpoint.includes('example.com')
  }
}

export const providerAdapter = { ProviderAdapter }
```

#### Step 6: Stream Handler

```typescript
// src/main/proxy/adapters/<provider>-stream.ts
import { PassThrough } from 'stream'

export class ProviderStreamHandler {
  private model: string
  private sessionId: string
  private isFirstChunk: boolean = true
  private created: number

  constructor(model: string, sessionId: string, onEnd?: () => void) {
    this.model = model
    this.sessionId = sessionId
    this.created = Math.floor(Date.now() / 1000)
  }

  async handleStream(stream: NodeJS.ReadableStream): Promise<NodeJS.ReadableStream> {
    const transStream = new PassThrough()
    
    stream.on('data', (chunk: Buffer) => {
      // Parse SSE data
      // Convert to OpenAI format
      // Write to transStream
    })

    stream.on('end', () => {
      transStream.write('data: [DONE]\n\n')
      transStream.end()
    })

    return transStream
  }

  async handleNonStream(stream: NodeJS.ReadableStream): Promise<any> {
    // Collect all data
    // Return OpenAI format response
  }

  private createChunk(delta: any, finishReason?: string): string {
    return `data: ${JSON.stringify({
      id: this.sessionId,
      model: this.model,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason: finishReason || null }],
      created: this.created,
    })}\n\n`
  }
}
```

#### Step 7: Register Proxy Adapter

```typescript
// src/main/proxy/adapters/index.ts
export { ProviderAdapter, ProviderStreamHandler, providerAdapter } from './provider'
```

#### Step 8: Add Forwarder Method

```typescript
// src/main/proxy/forwarder.ts
import { ProviderAdapter } from './adapters/provider'
import { ProviderStreamHandler } from './adapters/provider-stream'

// In doForward method, add check:
if (ProviderAdapter.isProviderProvider(provider)) {
  return this.forwardProvider(request, account, provider, actualModel, startTime, sessionContext)
}

// Add forward method:
private async forwardProvider(
  request: ChatCompletionRequest,
  account: Account,
  provider: Provider,
  actualModel: string,
  startTime: number,
  sessionContext: SessionContext
): Promise<ForwardResult> {
  // Implementation
}
```

#### Step 9: Add UI Translations

```json
// src/renderer/src/i18n/locales/zh-CN.json
{
  "provider-id": {
    "name": "供应商名称",
    "description": "供应商描述",
    "token": "Token",
    "tokenPlaceholder": "请输入 Token",
    "tokenHelp": "从网页版获取 Token",
    "models": {
      "Model-1": "模型 1 描述"
    }
  }
}
```

```json
// src/renderer/src/i18n/locales/en-US.json
{
  "provider-id": {
    "name": "Provider Name",
    "description": "Provider description",
    "token": "Token",
    "tokenPlaceholder": "Enter token",
    "tokenHelp": "Get token from web version",
    "models": {
      "Model-1": "Model 1 description"
    }
  }
}
```

#### Step 10: Add Icon Mapping

```typescript
// src/renderer/src/components/providers/ProviderCard.tsx
import providerIcon from '@/assets/providers/provider.svg'

const providerIcons: Record<string, string> = {
  // ...existing
  'provider-id': providerIcon,
}
```

### AuthType Reference

| Type | Description | Providers | Credential Field |
|------|-------------|-----------|------------------|
| `userToken` | User Token | DeepSeek | `token` |
| `jwt` | JWT Token | Kimi, MiniMax, Qwen AI, Z.ai | `token` |
| `refresh_token` | Refresh Token | GLM | `refresh_token` |
| `cookie` | Cookie Auth | Perplexity | `sessionToken` |
| `tongyi_sso_ticket` | SSO Ticket | Qwen | `ticket` |
| `token` | Generic Token | Z.ai | `token` |

### Web Search Mode Implementation

Three ways to enable web search:

1. **Model Mapping**: Auto-enable via model name
```typescript
const modelLower = request.model.toLowerCase()
if (modelLower.includes('search')) {
  searchEnabled = true
}
```

2. **Custom Parameter**: Via `web_search` parameter
```typescript
if (request.web_search) {
  searchEnabled = true
}
```

3. **Custom Header**: Via request header
```typescript
if (headers['X-Enable-Search']) {
  searchEnabled = true
}
```

### Thinking Mode Implementation

Three ways to enable thinking mode:

1. **Model Mapping**: Auto-enable via model name
```typescript
const modelLower = request.model.toLowerCase()
if (modelLower.includes('r1') || modelLower.includes('think')) {
  thinkingEnabled = true
}
```

2. **Custom Parameter**: Via `reasoning_effort` parameter
```typescript
if (request.reasoning_effort) {
  thinkingEnabled = true
}
```

3. **Custom Header**: Via request header
```typescript
if (headers['X-Enable-Thinking']) {
  thinkingEnabled = true
}
```

### Thinking Content Handling

In stream handler, output thinking content to `reasoning_content` field:

```typescript
if (path === 'thinking') {
  delta.reasoning_content = processedContent
} else {
  delta.content = processedContent
}
```

### Model List Synchronization

**CRITICAL**: Model list must be defined in TWO locations:

1. `src/main/providers/builtin/<provider>.ts` - `supportedModels` array
2. `src/main/store/types.ts` - `BUILTIN_PROVIDERS` array

Both must be identical, otherwise configuration won't take effect.

### Testing Checklist

- [ ] Provider displays correctly
- [ ] Account can be added
- [ ] Account validation works
- [ ] Streaming chat works
- [ ] Non-streaming chat works
- [ ] Web search mode works
- [ ] Thinking mode works
- [ ] Model mapping works
- [ ] Multi-turn conversation works
- [ ] Session deletion works

## Updating Provider Configuration

When updating provider configuration (e.g., model list, description, help text), you MUST update **both** locations:

1. **`src/main/providers/builtin/<provider>.ts`** - Provider config module
2. **`src/main/store/types.ts`** - `BUILTIN_PROVIDERS` array

The `initializeDefaultProviders()` method in `store.ts` syncs configuration from `BUILTIN_PROVIDERS` to persistent storage on app startup. If only one location is updated, the changes will not be reflected in the UI.

Example: When updating Z.ai model list:
```typescript
// 1. src/main/providers/builtin/zai.ts
supportedModels: ['GLM-5-Turbo', 'GLM-5', 'GLM-4.7', ...]

// 2. src/main/store/types.ts (BUILTIN_PROVIDERS array)
supportedModels: ['GLM-5-Turbo', 'GLM-5', 'GLM-4.7', ...]
```

**Important**: Users must restart the app after configuration updates to see the changes.

## Network Egress: Never Diagnose "Home IP Banned" Without Checking the Proxy

**Read this before investigating any provider risk-control / ban / `RGV587` /
`bxpunish` / `qwen_ai_content_verdict` issue.**

A recurring and expensive mistake is concluding that the operator's "residential
IP got flagged". On 2026-09-25 this produced a wrong root cause and a wrong fix
for a full Qwen pool outage. The rules:

1. **Measure the app's egress, not the browser's.** `curl https://ipinfo.io` only
   proves the shell's path. Ask what axios will actually do:
   ```bash
   node -e "const p=require('proxy-from-env');console.log(p.getProxyForUrl('https://chat.qwen.ai/api/v1/chat')||'DIRECT')"
   ```
   If `HTTP_PROXY`/`HTTPS_PROXY` is set, that is the egress the app uses — the
   "home IP" is irrelevant to the diagnosis.

2. **Compare the AS number, not the latency.** A datacenter AS
   (`AS7488 CNServer LLC`, `AS14061`, `AS63949`) is a red flag; `AS4837`
   (China Unicom) is a residential carrier and is fine.

3. **Before running a local/production A/B comparison, verify the two sides
   actually differ.** In that incident the "local" instance exited through the
   same node as the "production" server, so the comparison proved nothing while
   appearing conclusive. Print both egress IPs side by side first.

4. **A rate-limit hypothesis is not a root cause.** "Too many requests" is at
   best a trigger. If the egress is a shared datacenter IP, the problem returns
   at the next burst. Fix the path, not just the cooldown.

5. **A WAF challenge page is not proof of an IP ban.** Aliyun's interstitial
   responds identically to unauthenticated requests from any network. Compare
   the response across both paths before concluding anything from it.

### Built-in protection

`src/main/proxy/egressPolicy.ts` is imported for side effects by both entry
points (`src/main/index.ts`, `src/server/index.ts`) and appends the provider
domains to `NO_PROXY`. It works because `proxy-from-env` re-reads
`process.env` on every call, so it affects axios instances that already exist.

- Do not remove the self-applying call at the bottom of that module; the
  side-effect import in `index.ts` is the only reason it lands before any
  network I/O.
- Keep it idempotent — entry points may also call it explicitly.
- Tests: `tests/server/egress-direct-policy.test.mjs`.

When adding a provider whose risk control is IP-sensitive, add its domain to
`DEFAULT_EGRESS_DIRECT_DOMAINS` in the same change.

### Risk-control circuits

Two independent circuits exist in `src/main/proxy/qwenAiRiskCircuit.ts`:

- **Per-fingerprint** — blocks a repeat of the exact payload already judged.
- **Egress-level (process-wide)** — a `bxpunish`/`RGV587` verdict is decided by
  the egress path, not by one payload, so N *distinct* payloads rejected inside a
  window parks all new Qwen AI traffic before another account is consumed. One
  accepted response clears it.

When mocking `./qwenAiRiskCircuit` in tests, provide **all** of:
`createQwenAiRiskFingerprint`, `getQwenAiRiskCircuitEntry`,
`qwenAiRiskCircuitThreshold`, `openQwenAiRiskCircuit`, `clearQwenAiRiskCircuit`,
`getQwenAiEgressCircuitEntry`, `recordQwenAiEgressRiskVerdict`,
`clearQwenAiEgressCircuit`. A partial mock makes `forwarder.ts` throw
`is not a function` at runtime, not at type-check time.

### Do not run the full account pool from a workstation

Upstream rate limiting is per egress IP. A ~340-account pool on one IP — above
all a shared datacenter one — is an anomaly shape no matter how the accounts
were obtained. Keep the full pool on the production server; use one account
locally for functional checks. Never point a local instance and the production
container at the same `accounts.json`/`/data` volume while both run: they
overwrite each other's `status`/`errorMessage` and their repair queues fight.

See the "Network egress" and "Local versus production deployment" sections in
`README.md` / `README_CN.md` for operator-facing instructions, and
`docs/network-egress.md` for the full configuration, verification and
troubleshooting guide. The post-mortem is
`docs/diag-2026-09-25-qwen-egress.md`.

## Docker Inherits the Host System Proxy

Measured 2026-09-25 on Docker Desktop for Windows. A container with **no** proxy
environment variables still egresses through the local proxy node:

```bash
$ docker exec chat2api sh -c "env | grep -i proxy"
(nothing)
$ docker exec chat2api node -e "fetch('https://ipinfo.io/ip').then(r=>r.text()).then(console.log)"
195.242.178.82      # the Clash node, not the residential IP
```

Consequences when reasoning about Docker deployments:

- `NO_PROXY` **inside the container is useless**, because the container has no
  `HTTP_PROXY` to bypass. The interception happens below the container's network
  stack, in Docker Desktop.
- `egressPolicy.ts` is therefore a no-op for containers, and a no-op for any
  process that has no proxy env to begin with.
- The only effective fix for a proxied Docker host is `DOMAIN-SUFFIX,...,DIRECT`
  rules in Clash/mihomo, because that operates at the socket layer.

Corollary for desktop apps: turning off the Windows "Proxy" settings page does
**not** stop Node/Electron, which read `HTTP_PROXY`/`HTTPS_PROXY` environment
variables rather than WinINET settings. This is the most common false fix.

## Credential Encryption: A Missing Key Looks Exactly Like Risk Control

**Read this before diagnosing any "all accounts frozen", "401 email not
found", "risk-control verdict", or "intermittent 403" report on a Docker or
server deployment.**

On 2026-09-26 a local instance lost `CHAT2API_STORAGE_ENCRYPTION_KEY`. Nothing
threw. It degraded into what looked like a full Qwen risk-control outage and
cost a long debugging session across several agents, each of whom first blamed
the proxy, then the cookie jar, then the request rate. All three were wrong.

### The chain (all of it silent)

```
container created with `docker run` (never reads .env) → no encryption key
  → isEncryptionAvailable() === false
  → decryptData('c2a:v1:…') returns the CIPHERTEXT unchanged
  → every account's cookies look like the literal string "c2a:v1:E++U+Z4…"
  → hasQwenAiWebSessionCookie() false for all 340 accounts
  → [Session Repair] ready=0 pending=339, signin per account every 25 s
  → those signins carry garbage credentials, upstream answers 401 "email not found"
  → 5 consecutive rejections open the refresh risk gate
  → 300 s → 600 s → 1200 s → 2400 s (capped at 1 h)
  → every request, including plain chat, fails 403 qwen_ai_token_refresh_gated
```

The 340 accounts were fine the whole time. Production, which had the key, showed
`ready=339 pending=0` and never issued a single signin. That contrast is the
fastest diagnostic: **compare the `[Session Repair] started ready=N pending=M`
line between the two environments first.**

### Rules

1. **A container must be started with `docker compose up -d`.** A container
   created with `docker run` has no compose project label, so `docker compose up`
   refuses to manage it and `.env` is never injected. Check:
   ```bash
   docker inspect chat2api --format '{{index .Config.Labels "com.docker.compose.project"}}'
   docker exec chat2api printenv CHAT2API_STORAGE_ENCRYPTION_KEY
   ```
2. **After editing `.env`, recreate the container.** Environment variables are
   read once at process start; `docker restart` is not enough.
3. **The key must match the one the data was written with.** The desktop and
   Docker deployments share `accounts.json`; a divergent key produces exactly
   this failure.
4. **Never edit a data volume by hand while the container is running.** Stop it
   first, otherwise the in-memory state overwrites the file on the next save.
5. Back up before touching any store file: `docker exec <c> cat /data/data.json > backup.json`.

### The self-check that now guards this

`src/main/store/credentialSelfCheck.ts`, called from
`StoreManager.initialize()` via `runCredentialSelfCheck()`:

| Check | Condition | Severity |
|---|---|---|
| 1 | A credential value still carries the `c2a:v1:` prefix *after* decryption | **fatal**, refuses to start |
| 2 | Everything decrypts, yet no account has a `token=` session cookie | loud WARNING naming the signin-storm consequence |

- Check 1 raises `CredentialUnreadableError`. `StoreManager.initialize()` has a
  corrupt-store recovery path that would happily back up an *intact but
  unreadable* store and start with garbage credentials, so that error is
  re-thrown without entering recovery. Do not "fix" this by removing the
  `instanceof` guard.
- Bypass with `CHAT2API_CREDENTIAL_SELF_CHECK=off` (plaintext stores only).
- Judge readability by the data, not by `isEncryptionAvailable()`: when a key is
  configured, stored values are *expected* to carry the prefix. Decrypt first,
  then look at what is left. Getting this backwards produces a false "no account
  has a session" warning on a perfectly healthy pool.
- Tests: `tests/server/credential-self-check.test.mjs` (9 cases, includes the
  false-positive guard).

### Diagnosing the two risk-control-shaped failures

They are independent. Do not conflate them.

| Symptom | Root cause | Where to look |
|---|---|---|
| Egress is a datacenter AS | Local proxy (Clash) inherited by Docker Desktop | `curl ipinfo.io` from inside the container |
| Every request 403, accounts "frozen" | Missing/unmatched encryption key | `ready=0 pending=N` + `docker exec ... printenv CHAT2API_STORAGE_ENCRYPTION_KEY` |

## Never Mutate User Data Without Explicit Confirmation

On the same day I deleted 337 accounts from a local store after misreading "add
a few accounts to the pool" as "cut the pool down to a few". The user needed all
340 locally. A pre-change backup made the rollback painless, but the deletion
should never have happened without asking.

- **Ask before deleting, truncating, rewriting, or bulk-updating any store file**
  (`data.json`, `accounts.json`, volumes, `/opt/chat2api/data`).
- When a request is ambiguous, prefer the **non-destructive** reading and say
  which one you chose. "Add a few accounts" most often means "import/keep a few
  extra", not "delete the rest".
- Prefer a reversible state change (deactivate, disable, a separate pool) over
  removal.
- If a bulk edit is genuinely wanted, restate the exact before/after counts and
  wait for confirmation.

## Controlled Comparisons Before Concluding

Two conclusions in this repo were wrong purely because the experiment was not
controlled. Both looked conclusive.

1. **A local-vs-production comparison proved nothing** because both exited
   through the same Clash node (`hysteria2 -> 195.242.178.82`, the production
   host). Print both egress IPs side by side first.
2. **"WAF is rate-triggered" was wrong.** Firing the endpoints back to back from
   one container at one instant showed v2 paths always challenged and v1 paths
   always served JSON — a controlled single-variable experiment. Prefer it over
   reasoning from a log timeline.

State the variable you are holding constant, and say which ones you are not.
