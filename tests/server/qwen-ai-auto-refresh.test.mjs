import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('Qwen AI credentials include optional email and password for automatic token refresh', () => {
  const providerSource = fs.readFileSync('src/main/providers/builtin/qwen-ai.ts', 'utf8')
  const storeTypesSource = fs.readFileSync('src/main/store/types.ts', 'utf8')
  const addAccountSource = fs.readFileSync('src/renderer/src/components/providers/AddAccountDialog.tsx', 'utf8')
  const providersPageSource = fs.readFileSync('src/renderer/src/pages/Providers.tsx', 'utf8')

  assert.match(providerSource, /name:\s*'email'/)
  assert.match(providerSource, /name:\s*'password'/)
  assert.match(providerSource, /required:\s*false/)
  assert.match(storeTypesSource, /export \{ builtinProviders as BUILTIN_PROVIDERS \} from '\.\.\/providers\/builtin\/index\.ts'/)

  assert.match(addAccountSource, /const accountEmail = provider\?\.id === 'qwen-ai'/)
  assert.match(addAccountSource, /email:\s*accountEmail/)
  assert.match(providersPageSource, /email:\s*provider\.id === 'qwen-ai' \? credentials\.email\?\.trim\(\) \|\| undefined : undefined/)
})

test('Qwen AI OAuth import form keeps optional refresh login fields', () => {
  const addAccountSource = fs.readFileSync('src/renderer/src/components/providers/AddAccountDialog.tsx', 'utf8')

  assert.match(addAccountSource, /oauthRefreshCredentialFields/)
  assert.match(addAccountSource, /fields=\{oauthRefreshCredentialFields\}/)
  assert.match(addAccountSource, /setCredentials\(prev => \(\{\s*\.\.\.prev,\s*\.\.\.mappedCredentials,\s*\}\)\)/s)
})

test('Qwen AI adapter refreshes expiring web tokens by signing in with saved email and password', () => {
  const refresherSource = fs.readFileSync('src/main/proxy/adapters/qwen-ai-token-refresh.ts', 'utf8')
  const adapterSource = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')

  assert.match(refresherSource, /class QwenAiTokenRefresher/)
  assert.match(refresherSource, /\/api\/v1\/auths\/signin/)
  assert.match(refresherSource, /createHash\('sha256'\)/)
  assert.match(refresherSource, /isTokenExpiringSoon/)
  assert.match(refresherSource, /storeManager\.updateAccount\(account\.id,\s*\{/)
  assert.match(refresherSource, /mergeCookieHeaders/)
  assert.match(refresherSource, /response\.headers\['set-cookie'\]/)
  assert.match(refresherSource, /const credentials = \{\s*\.\.\.account\.credentials,\s*token,\s*\.\.\.\(cookies \? \{ cookies \} : \{\}\),\s*\}/s)
  assert.match(refresherSource, /hasWebSessionCookie/)
  assert.match(refresherSource, /\(!this\.isTokenExpiringSoon\(account\.credentials\.token \|\| ''\) && this\.hasWebSessionCookie\(account\)\)/)
  assert.match(refresherSource, /source:\s*'web'/)
  assert.match(refresherSource, /Version:\s*'0\.2\.67'/)
  assert.match(refresherSource, /Timezone:\s*currentTimezoneHeader\(\)/)

  assert.match(adapterSource, /QwenAiTokenRefresher/)
  assert.match(adapterSource, /await this\.tokenRefresher\.refreshIfNeeded\(this\.account, signal\)/)
  assert.match(adapterSource, /await this\.tokenRefresher\.refreshAfterUnauthorized\(this\.account, options\.signal\)/)
  assert.match(adapterSource, /createOptions: \(\) => Record<string, any>/)
  assert.match(refresherSource, /async refreshIfNeeded\(account: Account, signal\?: AbortSignal\)/)
  assert.match(refresherSource, /async refreshAfterUnauthorized\(account: Account, signal\?: AbortSignal\)/)
  assert.match(refresherSource, /timeout:\s*15000,\s*signal,/)
  assert.match(adapterSource, /createChat\(modelId, 'OpenAI_API_Chat', request\.signal\)/)
})

test('Qwen AI token refresher persists signin Set-Cookie values for web sessions', () => {
  const refresherSource = fs.readFileSync('src/main/proxy/adapters/qwen-ai-token-refresh.ts', 'utf8')

  assert.match(refresherSource, /export function mergeCookieHeaders/)
  assert.match(refresherSource, /parseCookiePair/)
  assert.match(refresherSource, /cookies\.set\(parsed\[0\], parsed\[1\]\)/)
  assert.match(refresherSource, /Array\.from\(cookies\.entries\(\)\)/)
  assert.match(refresherSource, /account\.credentials\.cookies \|\| account\.credentials\.cookie \|\| ''/)
  assert.match(refresherSource, /\.\.\.\(cookies \? \{ cookies \} : \{\}\)/)
})
