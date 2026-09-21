import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyZaiSigninFailure,
  deriveZaiPassword,
  parseSolverOutput,
  resetZaiRefreshStateForTests,
  resolveZaiCredentials,
  solverFailureDetail,
  ZaiTokenRefresher,
} from '../../src/main/proxy/adapters/zai-token-refresh.ts'

function makeAccount(credentials = {}, extra = {}) {
  return {
    id: 'acc-1',
    providerId: 'zai',
    name: 'test-account',
    status: 'active',
    credentials,
    ...extra,
  }
}

test('deriveZaiPassword: local-part + "@" for disposable mailbox accounts', () => {
  assert.equal(deriveZaiPassword('twerp-rut-grinning@duck.com'), 'twerp-rut-grinning@')
  assert.equal(deriveZaiPassword('gory-unmixed-rally@525203.xyz'), 'gory-unmixed-rally@')
})

test('deriveZaiPassword: empty when there is no usable local part', () => {
  assert.equal(deriveZaiPassword(''), '')
  assert.equal(deriveZaiPassword('no-at-symbol'), '')
  assert.equal(deriveZaiPassword('@duck.com'), '')
})

test('resolveZaiCredentials: an explicitly stored password always wins', () => {
  const account = makeAccount({ email: 'a@b.com', password: 'explicit-secret' })
  const resolved = resolveZaiCredentials(account)

  assert.equal(resolved.password, 'explicit-secret')
  assert.equal(resolved.derived, false)
})

test('resolveZaiCredentials: falls back to the derived convention and flags it', () => {
  const account = makeAccount({ email: 'vision-shack-icy@duck.com' })
  const resolved = resolveZaiCredentials(account)

  assert.equal(resolved.password, 'vision-shack-icy@')
  assert.equal(resolved.derived, true)
})

test('resolveZaiCredentials: prefers credentials.email over the account display name', () => {
  const account = makeAccount({ email: 'real@duck.com' }, { email: 'display@duck.com' })
  assert.equal(resolveZaiCredentials(account).email, 'real@duck.com')
})

test('resolveZaiCredentials: falls back to an email-shaped display name', () => {
  // Un-backfilled instances (e.g. local dev data) keep the login in `name`.
  const account = makeAccount({}, { name: 'twerp-rut-grinning@duck.com' })
  const resolved = resolveZaiCredentials(account)

  assert.equal(resolved.email, 'twerp-rut-grinning@duck.com')
  assert.equal(resolved.password, 'twerp-rut-grinning@')
})

test('resolveZaiCredentials: ignores a display name that is not an email', () => {
  const account = makeAccount({}, { name: 'Z.ai 账户' })
  assert.equal(resolveZaiCredentials(account).email, '')
})

test('canRefresh: true when an email is present (password may be derived)', () => {
  const refresher = new ZaiTokenRefresher()

  assert.equal(refresher.canRefresh(makeAccount({ email: 'x@duck.com' })), true)
  assert.equal(refresher.canRefresh(makeAccount({ email: 'x@duck.com', password: 'p' })), true)
})

test('canRefresh: false without an email', () => {
  const refresher = new ZaiTokenRefresher()

  assert.equal(refresher.canRefresh(makeAccount({})), false)
  assert.equal(refresher.canRefresh(makeAccount({ token: 'eyJ...' })), false)
})

test('refresh: no-ops instead of launching the solver when credentials are absent', async () => {
  const refresher = new ZaiTokenRefresher()
  const result = await refresher.refresh(makeAccount({ token: 'eyJ...' }))

  assert.equal(result, null)
})

test('classify: a captcha rejection is retryable and not an account fault', () => {
  const error = classifyZaiSigninFailure({
    status: 400,
    token: '',
    cookies: '',
    detail: 'The captcha verification failed.',
  })

  // A stale/expired captcha param is routine; the next harvest can succeed, so
  // this must not burn the account.
  assert.equal(error.status, 403)
  assert.equal(error.retryable, true)
  assert.equal(error.accountFault, false)
})

test('classify: HTTP 401 marks the credential as the fault', () => {
  const error = classifyZaiSigninFailure({
    status: 401,
    token: '',
    cookies: '',
    detail: '',
  })

  assert.equal(error.accountFault, true)
  assert.equal(error.retryScope, 'next-account')
  assert.equal(error.retryable, false)
})

test('classify: an unregistered account is persisted as inactive', () => {
  const error = classifyZaiSigninFailure({
    status: 401,
    token: '',
    cookies: '',
    detail: 'user not found',
  })

  assert.equal(error.accountStatus, 'inactive')
  assert.equal(error.retryScope, 'next-account')
})

test('classify: rate limiting is not treated as an invalid credential', () => {
  const error = classifyZaiSigninFailure({
    status: 429,
    token: '',
    cookies: '',
    detail: '',
  })

  assert.equal(error.status, 429)
  assert.equal(error.accountFault, false)
})

test('classify: a 5xx from Z.ai is retryable and not an account fault', () => {
  const error = classifyZaiSigninFailure({
    status: 503,
    token: '',
    cookies: '',
    detail: '',
  })

  assert.equal(error.status, 502)
  assert.equal(error.retryable, true)
  assert.equal(error.accountFault, false)
})

test('parseSolverOutput: reads the trailing signin JSON past the progress logs', () => {
  const stdout = [
    'Z.ai Captcha Solver v2',
    'Loading chat.z.ai...',
    '  Intercepted captcha_verify_param (280 chars)',
    '  signin status=200 token_len=232 detail=',
    JSON.stringify({
      mode: 'signin',
      status: 200,
      token: 'eyJNEW',
      cookies: 'token=eyJNEW',
      captcha_verify_param: 'abc',
      detail: '',
    }),
  ].join('\n')

  const parsed = parseSolverOutput(stdout)

  assert.equal(parsed.kind, 'signin')
  assert.equal(parsed.result.status, 200)
  assert.equal(parsed.result.token, 'eyJNEW')
  assert.equal(parsed.result.cookies, 'token=eyJNEW')
  assert.equal(parsed.result.captcha_verify_param, 'abc')
})

test('parseSolverOutput: a signin that minted no token still yields a classifiable result', () => {
  const stdout = JSON.stringify({
    mode: 'signin',
    status: 400,
    token: '',
    cookies: '',
    detail: 'The captcha verification failed.',
  })

  const parsed = parseSolverOutput(stdout)

  assert.equal(parsed.kind, 'signin')
  assert.equal(parsed.result.token, '')
  assert.equal(classifyZaiSigninFailure(parsed.result).retryable, true)
})

test('parseSolverOutput: surfaces a solver-reported error', () => {
  const stdout = `booting\n${JSON.stringify({ error: 'signin mode requires --email and --password' })}`
  const parsed = parseSolverOutput(stdout)

  assert.equal(parsed.kind, 'error')
  assert.match(parsed.message, /--email/)
})

test('parseSolverOutput: none when stdout carries no JSON payload', () => {
  assert.equal(parseSolverOutput('').kind, 'none')
  assert.equal(parseSolverOutput('Loading chat.z.ai...\nno json here').kind, 'none')
})

test('solverFailureDetail: surfaces the python-level cause when the solver crashes', () => {
  // The execFile error alone only says "Command failed" — the harvest failure
  // (revoked token -> no chat input) lives at the end of the solver output.
  const detail = solverFailureDetail(
    'Z.ai Captcha Solver v2\nLoading chat.z.ai...',
    'RuntimeError: Could not send chat message to trigger captcha',
  )

  assert.match(detail, /Could not send chat message/)
})

test('solverFailureDetail: empty when the solver produced nothing', () => {
  assert.equal(solverFailureDetail('', ''), '')
})

test('solverFailureDetail: redacts credentials that leaked into a traceback', () => {
  const detail = solverFailureDetail('', 'signin failed for password=hunter2')

  assert.ok(!detail.includes('hunter2'))
  assert.match(detail, /\[REDACTED\]/)
})

test('refresh: a failed attempt puts the account in cooldown instead of relaunching the browser', async () => {
  resetZaiRefreshStateForTests()

  const saved = {
    python: process.env.ZAI_PYTHON_PATH,
    script: process.env.ZAI_CAPTCHA_SOLVER_PATH,
    cooldown: process.env.ZAI_REFRESH_COOLDOWN_MS,
  }
  // Point the solver at something that fails immediately, so the test never
  // launches a real browser.
  process.env.ZAI_PYTHON_PATH = process.execPath
  process.env.ZAI_CAPTCHA_SOLVER_PATH = 'tests/server/__does-not-exist__.py'
  process.env.ZAI_REFRESH_COOLDOWN_MS = '60000'

  try {
    const refresher = new ZaiTokenRefresher()
    const account = makeAccount(
      { email: 'cooldown@duck.com', password: 'cooldown@' },
      { id: 'acc-cooldown' },
    )

    await assert.rejects(() => refresher.refresh(account))

    // The next 401 must not spawn another headless Chromium.
    assert.equal(await refresher.refresh(account), null)
  } finally {
    for (const [key, value] of Object.entries({
      ZAI_PYTHON_PATH: saved.python,
      ZAI_CAPTCHA_SOLVER_PATH: saved.script,
      ZAI_REFRESH_COOLDOWN_MS: saved.cooldown,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetZaiRefreshStateForTests()
  }
})

test('classify: redacts secrets embedded in the upstream detail', () => {
  const error = classifyZaiSigninFailure({
    status: 401,
    token: '',
    cookies: '',
    detail: 'rejected Bearer eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.sig for password=hunter2',
  })

  assert.ok(!error.message.includes('hunter2'), 'password must be redacted')
  assert.ok(!error.message.includes('eyJhbGciOiJFUzI1NiJ9'), 'JWT must be redacted')
  assert.ok(error.message.includes('[REDACTED'))
})
