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

## Environment overrides

| Variable | Purpose |
| --- | --- |
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
