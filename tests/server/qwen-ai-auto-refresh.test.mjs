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
  assert.match(refresherSource, /credentials:\s*\{\s*\.\.\.account\.credentials,\s*token,/s)

  assert.match(adapterSource, /QwenAiTokenRefresher/)
  assert.match(adapterSource, /await this\.tokenRefresher\.refreshIfNeeded\(this\.account\)/)
  assert.match(adapterSource, /await this\.tokenRefresher\.refreshAfterUnauthorized\(this\.account\)/)
  assert.match(adapterSource, /createOptions: \(\) => Record<string, any>/)
})
