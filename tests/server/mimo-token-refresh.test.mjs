import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildMimoBrowserLoginArgv,
  classifyMimoPassportAuth,
  md5Upper,
  mergeCookieJar,
  mimoPythonCandidates,
  parseMimoBrowserLoginOutput,
  parsePassportPayload,
  resetMimoRefreshStateForTests,
  resolveMimoCredentials,
  resolveMimoLoginScriptPath,
  resolveMimoRefreshMode,
  shouldFallbackToBrowser,
  MimoTokenRefresher,
} from '../../src/main/proxy/adapters/mimo-token-refresh.ts'

function makeAccount(credentials = {}, extra = {}) {
  return {
    id: 'acc-mimo-1',
    providerId: 'mimo',
    name: 'mimo-account',
    status: 'active',
    credentials,
    ...extra,
  }
}

test('parsePassportPayload: strips Xiaomi &&&START&&& wrapper', () => {
  const payload = parsePassportPayload(
    '&&&START&&&{"code":0,"location":"https://example.com","_sign":"abc"}',
  )
  assert.equal(payload.code, 0)
  assert.equal(payload.location, 'https://example.com')
  assert.equal(payload._sign, 'abc')
})

test('parsePassportPayload: accepts already-parsed objects and junk', () => {
  assert.equal(parsePassportPayload({ code: 7 }).code, 7)
  assert.deepEqual(parsePassportPayload('not-json'), {})
  assert.deepEqual(parsePassportPayload(''), {})
})

test('md5Upper: uppercase hex of password (Xiaomi hash convention)', () => {
  // md5("password") = 5f4dcc3b5aa765d61d8327deb882cf99
  assert.equal(md5Upper('password'), '5F4DCC3B5AA765D61D8327DEB882CF99')
})

test('mergeCookieJar: later Set-Cookie values overwrite earlier pairs', () => {
  const jar = mergeCookieJar('serviceToken=old; userId=1', [
    'serviceToken=new; Path=/; HttpOnly',
    'xiaomichatbot_ph=ph1; Path=/',
  ])
  assert.match(jar, /serviceToken=new/)
  assert.match(jar, /userId=1/)
  assert.match(jar, /xiaomichatbot_ph=ph1/)
  assert.doesNotMatch(jar, /serviceToken=old/)
})

test('classifyMimoPassportAuth: captchaUrl is retryable non-account-fault', () => {
  const error = classifyMimoPassportAuth({
    status: 200,
    code: 0,
    description: '需要验证',
    location: '',
    userId: '',
    captchaUrl: 'https://account.xiaomi.com/captcha',
  })
  assert.equal(error.retryable, true)
  assert.equal(error.accountFault, false)
  assert.equal(error.code, 'mimo_token_refresh_failed')
})

test('classifyMimoPassportAuth: 70016 login challenge stays retryable', () => {
  const error = classifyMimoPassportAuth({
    status: 200,
    code: 70016,
    description: '登录验证失败',
    location: '',
    userId: '',
    captchaUrl: '',
  })
  assert.equal(error.retryable, true)
  assert.equal(error.accountFault, false)
})

test('classifyMimoPassportAuth: unregistered / wrong password marks account fault', () => {
  const error = classifyMimoPassportAuth({
    status: 200,
    code: 2,
    description: '用户名或密码不正确',
    location: '',
    userId: '',
    captchaUrl: '',
  })
  assert.equal(error.accountFault, true)
  assert.equal(error.retryable, false)
  assert.equal(error.accountStatus, 'inactive')
})

test('classifyMimoPassportAuth: rate limit is not an account fault', () => {
  const error = classifyMimoPassportAuth({
    status: 429,
    code: 429,
    description: '',
    location: '',
    userId: '',
    captchaUrl: '',
  })
  assert.equal(error.accountFault, false)
  assert.equal(error.status, 429)
})

test('resolveMimoCredentials: prefers credentials.email over account.email', () => {
  const account = makeAccount(
    { email: 'creds@mi.com', password: 'p1' },
    { email: 'display@mi.com' },
  )
  const resolved = resolveMimoCredentials(account)
  assert.equal(resolved.email, 'creds@mi.com')
  assert.equal(resolved.password, 'p1')
})

test('resolveMimoCredentials: empty without stored password', () => {
  const resolved = resolveMimoCredentials(makeAccount({ email: 'a@b.com' }))
  assert.equal(resolved.password, '')
})

test('canRefresh: true only with email and password', () => {
  resetMimoRefreshStateForTests()
  const refresher = new MimoTokenRefresher()
  assert.equal(refresher.canRefresh(makeAccount({ email: 'a@b.com', password: 'x' })), true)
  assert.equal(refresher.canRefresh(makeAccount({ email: 'a@b.com' })), false)
  assert.equal(refresher.canRefresh(makeAccount({ password: 'x' })), false)
  assert.equal(refresher.canRefresh(makeAccount({})), false)
})

const BASE_BROWSER_OPTS = {
  scriptPath: 'C:/repo/scripts/mimo-login/login.py',
  email: 'user@example.com',
  password: 'secret',
  waitSeconds: 90,
  headless: true,
  human: false,
  humanTimeout: 180,
  gmailCode: true,
  noImport: true,
}

test('buildMimoBrowserLoginArgv: automated mode is headless, Gmail OTP on, no management import', () => {
  const argv = buildMimoBrowserLoginArgv({
    ...BASE_BROWSER_OPTS,
    accountId: 'acc-mimo-1',
    managementUrl: '',
    managementSecret: '',
  })

  assert.equal(argv[0], BASE_BROWSER_OPTS.scriptPath)
  assert.ok(argv.includes('--headless'))
  assert.ok(!argv.includes('--allow-human'))
  assert.ok(argv.includes('--gmail-code'))
  assert.ok(argv.includes('--no-import'))
  assert.equal(argv[argv.indexOf('--email') + 1], 'user@example.com')
  assert.equal(argv[argv.indexOf('--password') + 1], 'secret')
  assert.equal(argv[argv.indexOf('--wait-seconds') + 1], '90')
  assert.equal(argv[argv.indexOf('--account-id') + 1], 'acc-mimo-1')
  assert.ok(!argv.includes('--management-url'), 'import path is storeManager, not PUT')
})

test('buildMimoBrowserLoginArgv: human mode drops --headless and opens the human window', () => {
  const argv = buildMimoBrowserLoginArgv({
    ...BASE_BROWSER_OPTS,
    headless: false,
    human: true,
    humanTimeout: 240,
  })

  assert.ok(!argv.includes('--headless'))
  assert.ok(argv.includes('--allow-human'))
  assert.equal(argv[argv.indexOf('--human-timeout') + 1], '240')
})

test('buildMimoBrowserLoginArgv: optional management flags only when provided', () => {
  const argv = buildMimoBrowserLoginArgv({
    ...BASE_BROWSER_OPTS,
    accountId: '',
    managementUrl: 'http://127.0.0.1:8080',
    managementSecret: 's3cret',
    gmailCode: false,
  })

  assert.ok(!argv.includes('--account-id'))
  assert.equal(argv[argv.indexOf('--management-url') + 1], 'http://127.0.0.1:8080')
  assert.equal(argv[argv.indexOf('--management-secret') + 1], 's3cret')
  assert.ok(argv.includes('--no-gmail-code'))
  assert.ok(!argv.includes('--gmail-code'))
})

test('buildMimoBrowserLoginArgv: every value flag has a value (no dangling option)', () => {
  const argv = buildMimoBrowserLoginArgv({
    ...BASE_BROWSER_OPTS,
    human: true,
    accountId: 'acc-1',
    managementUrl: 'http://x',
    managementSecret: 'y',
  })
  const valueFlags = new Set([
    '--email', '--password', '--wait-seconds', '--account-id',
    '--management-url', '--management-secret', '--human-timeout',
  ])
  for (let i = 0; i < argv.length; i += 1) {
    if (valueFlags.has(argv[i])) {
      assert.ok(i + 1 < argv.length, `${argv[i]} missing value`)
      assert.ok(!argv[i + 1].startsWith('--'), `${argv[i]} value looks like a flag`)
    }
  }
})

test('parseMimoBrowserLoginOutput: finds kind=ok after log noise and strips quotes', () => {
  const stdout = [
    '[mimo-login] geetest fetch bg 1234B',
    '[mimo-login] otp filled',
    JSON.stringify({
      kind: 'ok',
      service_token: '"svc-abc"',
      user_id: '"u-1"',
      ph_token: 'ph-xyz',
      imported: false,
    }),
  ].join('\n')

  const parsed = parseMimoBrowserLoginOutput(stdout)
  assert.equal(parsed.kind, 'ok')
  assert.deepEqual(parsed.credentials, {
    service_token: 'svc-abc',
    user_id: 'u-1',
    ph_token: 'ph-xyz',
  })
})

test('parseMimoBrowserLoginOutput: incomplete ok payload is rejected', () => {
  const parsed = parseMimoBrowserLoginOutput(
    JSON.stringify({ kind: 'ok', service_token: 'svc', user_id: '', ph_token: 'ph' }),
  )
  assert.equal(parsed.kind, 'none')
})

test('parseMimoBrowserLoginOutput: surfaces kind=error message', () => {
  const parsed = parseMimoBrowserLoginOutput(
    'log line\n' + JSON.stringify({ kind: 'error', message: 'password rejected' }),
  )
  assert.equal(parsed.kind, 'error')
  assert.equal(parsed.message, 'password rejected')
})

test('parseMimoBrowserLoginOutput: non-JSON / empty stdout yields none', () => {
  assert.equal(parseMimoBrowserLoginOutput('').kind, 'none')
  assert.equal(parseMimoBrowserLoginOutput('Traceback...\nno json').kind, 'none')
  assert.equal(parseMimoBrowserLoginOutput('{"kind":"other"}').kind, 'none')
})

test('parseMimoBrowserLoginOutput: last JSON line wins when both error and ok appear', () => {
  const parsed = parseMimoBrowserLoginOutput([
    JSON.stringify({ kind: 'error', message: 'stale' }),
    JSON.stringify({ kind: 'ok', service_token: 's', user_id: 'u', ph_token: 'p' }),
  ].join('\n'))
  assert.equal(parsed.kind, 'ok')
})

test('resolveMimoRefreshMode: defaults to auto and accepts http/browser overrides', () => {
  assert.equal(resolveMimoRefreshMode({}), 'auto')
  assert.equal(resolveMimoRefreshMode({ MIMO_REFRESH_MODE: 'http' }), 'http')
  assert.equal(resolveMimoRefreshMode({ MIMO_REFRESH_MODE: 'browser' }), 'browser')
  assert.equal(resolveMimoRefreshMode({ MIMO_REFRESH_MODE: 'AUTO' }), 'auto')
  assert.equal(resolveMimoRefreshMode({ MIMO_REFRESH_MODE: 'weird' }), 'auto')
})

test('shouldFallbackToBrowser: captcha/risk errors fall back, account faults do not', () => {
  const captcha = classifyMimoPassportAuth({
    status: 403,
    code: 70016,
    description: '验证码输入错误',
    location: '',
    userId: '',
    captchaUrl: '',
  })
  assert.equal(shouldFallbackToBrowser(captcha), true)

  const wrongPassword = classifyMimoPassportAuth({
    status: 200,
    code: 2,
    description: '用户名或密码不正确',
    location: '',
    userId: '',
    captchaUrl: '',
  })
  assert.equal(shouldFallbackToBrowser(wrongPassword), false)
  assert.equal(shouldFallbackToBrowser(null), false)
  assert.equal(shouldFallbackToBrowser(new Error('boom')), true, 'unknown errors may still be risk')
})

test('resolveMimoLoginScriptPath: env override wins over discovered path', () => {
  const path = resolveMimoLoginScriptPath({
    MIMO_LOGIN_SCRIPT_PATH: 'D:/custom/login.py',
  })
  assert.equal(path, 'D:/custom/login.py')
})

test('resolveMimoLoginScriptPath: finds repo scripts/mimo-login/login.py', () => {
  const path = resolveMimoLoginScriptPath({})
  assert.match(path, /scripts[\\/]mimo-login[\\/]login\.py$/)
})

test('mimoPythonCandidates: explicit MIMO_PYTHON_PATH is trusted alone', () => {
  const saved = process.env.MIMO_PYTHON_PATH
  process.env.MIMO_PYTHON_PATH = 'C:\\custom\\python.exe'
  try {
    assert.deepEqual(mimoPythonCandidates('win32'), ['C:\\custom\\python.exe'])
    assert.deepEqual(mimoPythonCandidates('linux'), ['C:\\custom\\python.exe'])
  } finally {
    if (saved === undefined) delete process.env.MIMO_PYTHON_PATH
    else process.env.MIMO_PYTHON_PATH = saved
  }
})

test('mimoPythonCandidates: no dangling entries per platform', () => {
  const saved = process.env.MIMO_PYTHON_PATH
  delete process.env.MIMO_PYTHON_PATH
  try {
    const win = mimoPythonCandidates('win32')
    assert.ok(win.length >= 2)
    assert.equal(win[0], 'python')
    const posix = mimoPythonCandidates('linux')
    assert.equal(posix[0], 'python3')
    assert.ok(!posix.includes('py'))
  } finally {
    if (saved !== undefined) process.env.MIMO_PYTHON_PATH = saved
  }
})
