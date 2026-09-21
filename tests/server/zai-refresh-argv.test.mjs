import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSolverSigninArgv,
  isContainerRuntime,
  pythonCandidates,
  resolveAllowHuman,
  resolveCaptchaVisionEnv,
} from '../../src/main/proxy/adapters/zai-token-refresh.ts'

// ---------------------------------------------------------------------------
// buildSolverSigninArgv - the handoff between Node and scripts/zai-captcha/solve.py
// ---------------------------------------------------------------------------

const BASE_OPTS = {
  scriptPath: '/app/scripts/zai-captcha/solve.py',
  token: '',
  accountId: 'acc-1',
  email: 'someone@example.com',
  password: 'secret',
  waitSeconds: 60,
  human: false,
  humanTimeout: 180,
}

test('buildSolverSigninArgv: automated mode runs headless and never asks for a human', () => {
  const argv = buildSolverSigninArgv({ ...BASE_OPTS, human: false })

  assert.equal(argv[0], BASE_OPTS.scriptPath, 'script path comes first')
  assert.ok(argv.includes('--mode'))
  assert.equal(argv[argv.indexOf('--mode') + 1], 'signin')
  assert.ok(argv.includes('--headless'))
  assert.ok(!argv.includes('--allow-human'))
  assert.ok(!argv.includes('--human-timeout'))
})

test('buildSolverSigninArgv: human mode drops --headless and opens the human window', () => {
  const argv = buildSolverSigninArgv({ ...BASE_OPTS, human: true, humanTimeout: 240 })

  assert.ok(!argv.includes('--headless'), 'a headless browser cannot be operated by hand')
  assert.ok(argv.includes('--allow-human'))
  assert.equal(argv[argv.indexOf('--human-timeout') + 1], '240')
})

test('buildSolverSigninArgv: passes credentials and wait budget through', () => {
  const argv = buildSolverSigninArgv({
    ...BASE_OPTS,
    email: 'a@b.com',
    password: 'pw',
    waitSeconds: 45,
    accountId: 'acc-9',
  })

  assert.equal(argv[argv.indexOf('--email') + 1], 'a@b.com')
  assert.equal(argv[argv.indexOf('--password') + 1], 'pw')
  assert.equal(argv[argv.indexOf('--wait-seconds') + 1], '45')
  assert.equal(argv[argv.indexOf('--account-id') + 1], 'acc-9')
})

test('buildSolverSigninArgv: every flag has a value (no dangling option)', () => {
  const argv = buildSolverSigninArgv({ ...BASE_OPTS, human: true })
  const valueFlags = new Set([
    '--token', '--account-id', '--mode', '--email', '--password',
    '--wait-seconds', '--human-timeout',
  ])
  for (let i = 0; i < argv.length; i++) {
    if (valueFlags.has(argv[i])) {
      assert.ok(i + 1 < argv.length, `${argv[i]} is missing its value`)
      assert.ok(!argv[i + 1].startsWith('--'), `${argv[i]} value looks like another flag`)
    }
  }
})

// ---------------------------------------------------------------------------
// resolveCaptchaVisionEnv - precedence between the settings page and process env
// ---------------------------------------------------------------------------

const ENV = {
  ZAI_VISION_API_URL: 'https://env.example/v1',
  ZAI_VISION_API_KEY: 'sk-env',
  ZAI_VISION_MODEL: 'env/model',
}

test('resolveCaptchaVisionEnv: env is used when the UI has nothing configured', () => {
  assert.deepEqual(resolveCaptchaVisionEnv(undefined, ENV), {
    ZAI_VISION_API_URL: 'https://env.example/v1',
    ZAI_VISION_API_KEY: 'sk-env',
    ZAI_VISION_MODEL: 'env/model',
  })
})

test('resolveCaptchaVisionEnv: a filled-in UI config wins over env', () => {
  assert.deepEqual(
    resolveCaptchaVisionEnv(
      { enabled: true, baseUrl: 'https://ui.example/v1', apiKey: 'sk-ui', model: 'ui/model' },
      ENV
    ),
    {
      ZAI_VISION_API_URL: 'https://ui.example/v1',
      ZAI_VISION_API_KEY: 'sk-ui',
      ZAI_VISION_MODEL: 'ui/model',
    }
  )
})

test('resolveCaptchaVisionEnv: a disabled UI config falls back to env', () => {
  assert.deepEqual(
    resolveCaptchaVisionEnv(
      { enabled: false, baseUrl: 'https://ui.example/v1', apiKey: 'sk-ui', model: 'ui/model' },
      ENV
    ),
    ENV
  )
})

test('resolveCaptchaVisionEnv: an incomplete UI config falls back to env', () => {
  const noKey = resolveCaptchaVisionEnv(
    { enabled: true, baseUrl: 'https://ui.example/v1', apiKey: '', model: 'ui/model' },
    ENV
  )
  assert.equal(noKey.ZAI_VISION_API_KEY, 'sk-env')

  const noUrl = resolveCaptchaVisionEnv(
    { enabled: true, baseUrl: '  ', apiKey: 'sk-ui', model: 'ui/model' },
    ENV
  )
  assert.equal(noUrl.ZAI_VISION_API_URL, 'https://env.example/v1')
})

test('resolveCaptchaVisionEnv: an empty UI model keeps the env model', () => {
  const out = resolveCaptchaVisionEnv(
    { enabled: true, baseUrl: 'https://ui.example/v1', apiKey: 'sk-ui', model: '' },
    ENV
  )
  assert.equal(out.ZAI_VISION_MODEL, 'env/model')
})

test('resolveCaptchaVisionEnv: never emits undefined, only empty strings', () => {
  const out = resolveCaptchaVisionEnv(undefined, {})
  assert.deepEqual(out, {
    ZAI_VISION_API_URL: '',
    ZAI_VISION_API_KEY: '',
    ZAI_VISION_MODEL: '',
  })
  for (const value of Object.values(out)) {
    assert.equal(typeof value, 'string')
  }
})

// ---------------------------------------------------------------------------
// resolveAllowHuman - who gets a manual drag when the automatic solve fails
// ---------------------------------------------------------------------------

test('isContainerRuntime: recognises the explicit runtime marker', () => {
  assert.equal(isContainerRuntime({ C2A_RUNTIME: 'docker' }), true)
  assert.equal(isContainerRuntime({ C2A_RUNTIME: 'Docker' }), true, 'marker is case-insensitive')
  assert.equal(isContainerRuntime({ C2A_RUNTIME: 'container' }), true)
  assert.equal(isContainerRuntime({ C2A_RUNTIME: 'desktop' }), false)
  assert.equal(isContainerRuntime({ C2A_RUNTIME: 'electron' }), false)
})

test('resolveAllowHuman: the desktop app defaults the human fallback on', () => {
  assert.equal(resolveAllowHuman({ C2A_RUNTIME: 'desktop' }), true)
})

test('resolveAllowHuman: a container defaults the human fallback off', () => {
  assert.equal(
    resolveAllowHuman({ C2A_RUNTIME: 'docker' }),
    false,
    'nobody is in front of a container screen - waiting there only burns the budget'
  )
})

test('resolveAllowHuman: an explicit override beats the runtime default', () => {
  assert.equal(resolveAllowHuman({ C2A_RUNTIME: 'docker', ZAI_REFRESH_ALLOW_HUMAN: '1' }), true)
  assert.equal(resolveAllowHuman({ C2A_RUNTIME: 'desktop', ZAI_REFRESH_ALLOW_HUMAN: '0' }), false)
})

test('resolveAllowHuman: accepts the usual truthy/falsy spellings', () => {
  for (const on of ['1', 'true', 'on', 'yes', ' 1 ']) {
    assert.equal(resolveAllowHuman({ C2A_RUNTIME: 'docker', ZAI_REFRESH_ALLOW_HUMAN: on }), true, on)
  }
  for (const off of ['0', 'false', 'off', 'no', ' 0 ']) {
    assert.equal(resolveAllowHuman({ C2A_RUNTIME: 'desktop', ZAI_REFRESH_ALLOW_HUMAN: off }), false, off)
  }
})

test('resolveAllowHuman: an unset or blank override falls through to the runtime default', () => {
  assert.equal(resolveAllowHuman({ C2A_RUNTIME: 'docker', ZAI_REFRESH_ALLOW_HUMAN: '' }), false)
  assert.equal(resolveAllowHuman({ C2A_RUNTIME: 'desktop', ZAI_REFRESH_ALLOW_HUMAN: undefined }), true)
})

// ---------------------------------------------------------------------------
// pythonCandidates - which interpreter gets handed the solver script
// ---------------------------------------------------------------------------

const savedPythonPath = process.env.ZAI_PYTHON_PATH
const restorePythonPath = () => {
  if (savedPythonPath === undefined) delete process.env.ZAI_PYTHON_PATH
  else process.env.ZAI_PYTHON_PATH = savedPythonPath
}

test('pythonCandidates: an explicit ZAI_PYTHON_PATH is used and trusted alone', () => {
  process.env.ZAI_PYTHON_PATH = 'C:\\custom\\python.exe'
  try {
    assert.deepEqual(pythonCandidates('win32'), ['C:\\custom\\python.exe'])
    assert.deepEqual(pythonCandidates('linux'), ['C:\\custom\\python.exe'])
  } finally {
    restorePythonPath()
  }
})

test('pythonCandidates: whitespace-only ZAI_PYTHON_PATH is ignored', () => {
  process.env.ZAI_PYTHON_PATH = '   '
  try {
    const candidates = pythonCandidates('linux')
    assert.ok(candidates.length >= 2, 'falls back to the normal list')
    assert.ok(!candidates.includes('   '))
  } finally {
    restorePythonPath()
  }
})

test('pythonCandidates: no dangling entries and PATH names come first', () => {
  delete process.env.ZAI_PYTHON_PATH
  const win = pythonCandidates('win32')
  assert.ok(win.length >= 3)
  assert.equal(win[0], 'python')
  assert.equal(win[1], 'python3')
  for (const entry of win) {
    assert.ok(entry.length > 0, 'no empty candidate')
    assert.equal(entry.trim(), entry, 'no padded candidate')
  }

  const posix = pythonCandidates('linux')
  assert.equal(posix[0], 'python3')
  assert.equal(posix[1], 'python')
  assert.ok(!posix.includes('py'), 'the Windows launcher is not a posix candidate')
})
