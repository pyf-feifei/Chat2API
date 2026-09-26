/**
 * Image slim policy — Phase 2 Task 2.1 and 2.2.
 *
 * This is the compatibility layer. Phase 0 froze Qwen's behavior and Phase 1
 * added the capability signal; Phase 2 has to answer "may this request be
 * slimmed, and how aggressively" WITHOUT changing anything for Qwen and without
 * letting a new variable family leak across providers.
 *
 * The precedence rules, in order:
 *   1. Qwen AI -> CHAT2API_QWEN_AI_REPLAY_* wins outright
 *   2. other providers -> CHAT2API_REPLAY_*
 *   3. an unset CHAT2API_REPLAY_* falls back to its Qwen-named counterpart
 *   4. CHAT2API_REPLAY_SLIM_IMAGES itself defaults to off with NO fallback
 *
 * Rule 4 is the one that is easy to get wrong and is called out by name below.
 * A deployment running Qwen at `on-busy` must not silently turn on proactive
 * slimming for its other providers just because a new variable appeared.
 *
 * Design: docs/superpowers/specs/2026-09-26-provider-neutral-image-slimming-design.md
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveImageSlimPolicy,
  imageSlimModeFromEnv,
  parseKeepCount,
  DEFAULT_IMAGE_SLIM_PLACEHOLDER,
} from '../../src/main/proxy/imageSlimPolicy.ts'
import type { Provider } from '../../src/shared/types.ts'

const SAVED_ENV = { ...process.env }

const SLIM_ENV_KEY = /SLIM|KEEP_FIRST|KEEP_LAST|PLACEHOLDER/

/**
 * `Object.assign(process.env, { KEY: undefined })` writes the STRING
 * "undefined", because process.env coerces every value. That made an unset
 * variable look set to the literal text "undefined" and turned a fallback test
 * into a false failure. Assign only defined values and delete the rest.
 */
function withEnv(overrides: Record<string, string | undefined>, run: () => void): void {
  for (const key of Object.keys(process.env)) {
    if (SLIM_ENV_KEY.test(key)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue
    process.env[key] = value
  }
  try {
    run()
  } finally {
    for (const key of Object.keys(process.env)) {
      if (SLIM_ENV_KEY.test(key)) delete process.env[key]
    }
    Object.assign(process.env, SAVED_ENV)
  }
}

function provider(id: string, overrides: Partial<Provider> = {}): Provider {
  return { id, name: id, modelCapabilities: {}, ...overrides } as unknown as Provider
}

const QWEN = provider('qwen-ai')
const GLM = provider('glm')
const DEEPSEEK = provider('deepseek')

// ---------------------------------------------------------------------------
// Mode parsing
// ---------------------------------------------------------------------------

test('the provider-neutral mode parses off / on-busy / always and defaults to off', () => {
  withEnv({ CHAT2API_REPLAY_SLIM_IMAGES: undefined }, () => {
    assert.equal(imageSlimModeFromEnv(GLM), 'off', 'the default must be off, not on-busy')
    assert.equal(imageSlimModeFromEnv(QWEN), 'off')
  })
  for (const [value, expected] of [
    ['off', 'off'],
    ['on-busy', 'on-busy'],
    ['always', 'always'],
    ['ALWAYS', 'always'],
    ['  on-busy  ', 'on-busy'],
  ] as const) {
    withEnv({ CHAT2API_REPLAY_SLIM_IMAGES: value }, () => {
      assert.equal(imageSlimModeFromEnv(GLM), expected, `value=${value}`)
    })
  }
})

test('an unknown provider-neutral mode falls back to off', () => {
  for (const value of ['yes', 'true', '1', 'sometimes', '']) {
    withEnv({ CHAT2API_REPLAY_SLIM_IMAGES: value }, () => {
      assert.equal(imageSlimModeFromEnv(GLM), 'off', `value=${JSON.stringify(value)}`)
    })
  }
})

test('keep counts parse to a non-negative integer and reject junk', () => {
  withEnv({ CHAT2API_REPLAY_KEEP_FIRST_IMAGE_MESSAGES: '3' }, () => {
    assert.equal(parseKeepCount('CHAT2API_REPLAY_KEEP_FIRST_IMAGE_MESSAGES', 0), 3)
  })
  withEnv({ CHAT2API_REPLAY_KEEP_FIRST_IMAGE_MESSAGES: 'many' }, () => {
    assert.equal(parseKeepCount('CHAT2API_REPLAY_KEEP_FIRST_IMAGE_MESSAGES', 7), 7)
  })
  withEnv({ CHAT2API_REPLAY_KEEP_FIRST_IMAGE_MESSAGES: '' }, () => {
    assert.equal(parseKeepCount('CHAT2API_REPLAY_KEEP_FIRST_IMAGE_MESSAGES', 4), 4,
      'an empty string means unset, not zero')
  })
})

// ---------------------------------------------------------------------------
// Precedence — the compatibility guarantee
// ---------------------------------------------------------------------------

test('RULE 4: the provider-neutral mode does not inherit the Qwen value', () => {
  withEnv({
    CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES: 'always',
    CHAT2API_REPLAY_SLIM_IMAGES: undefined,
  }, () => {
    assert.equal(resolveImageSlimPolicy({
      provider: GLM, actualModel: 'glm-4', mode: imageSlimModeFromEnv(GLM), afterBusyRejection: false,
    }), undefined, 'a Qwen deployment at always must not enable proactive slimming elsewhere')
  })
})

test('RULE 1: the Qwen variables win outright for a Qwen provider', () => {
  withEnv({
    CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES: 'always',
    CHAT2API_QWEN_AI_REPLAY_KEEP_LAST_IMAGE_MESSAGES: '4',
    CHAT2API_QWEN_AI_REPLAY_KEEP_FIRST_IMAGE_MESSAGES: '2',
    CHAT2API_REPLAY_SLIM_IMAGES: 'off',
    CHAT2API_REPLAY_KEEP_LAST_IMAGE_MESSAGES: '9',
    CHAT2API_REPLAY_KEEP_FIRST_IMAGE_MESSAGES: '9',
  }, () => {
    const policy = resolveImageSlimPolicy({
      provider: QWEN, actualModel: 'qwen-max', mode: imageSlimModeFromEnv(QWEN), afterBusyRejection: false,
    })
    assert.ok(policy, 'Qwen should still be slimmed')
    assert.equal(policy!.keepFirstImageMessages, 2)
    assert.equal(policy!.keepLastImageMessages, 4)
    assert.equal(policy!.reason, 'proactive')
  })
})

test('RULE 1: setting only the provider-neutral variables must not change Qwen', () => {
  withEnv({
    CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES: 'off',
    CHAT2API_REPLAY_SLIM_IMAGES: 'always',
    CHAT2API_REPLAY_KEEP_LAST_IMAGE_MESSAGES: '7',
  }, () => {
    const policy = resolveImageSlimPolicy({
      provider: QWEN, actualModel: 'qwen-max', mode: imageSlimModeFromEnv(QWEN), afterBusyRejection: false,
    })
    assert.equal(policy, undefined, 'Qwen reads only its own variables')
  })
})

test('RULE 3: unset provider-neutral keep counts fall back to the Qwen-named values', () => {
  withEnv({
    CHAT2API_REPLAY_SLIM_IMAGES: 'always',
    CHAT2API_REPLAY_KEEP_LAST_IMAGE_MESSAGES: undefined,
    CHAT2API_REPLAY_KEEP_FIRST_IMAGE_MESSAGES: undefined,
    CHAT2API_QWEN_AI_REPLAY_KEEP_LAST_IMAGE_MESSAGES: '3',
    CHAT2API_QWEN_AI_REPLAY_KEEP_FIRST_IMAGE_MESSAGES: '1',
  }, () => {
    const policy = resolveImageSlimPolicy({
      provider: GLM, actualModel: 'glm-4', mode: imageSlimModeFromEnv(GLM), afterBusyRejection: false,
    })
    assert.equal(policy!.keepLastImageMessages, 3, 'a tuned keep count should carry across providers')
    assert.equal(policy!.keepFirstImageMessages, 1)
  })
})

// ---------------------------------------------------------------------------
// Disqualifiers
// ---------------------------------------------------------------------------

test('mode off yields no policy for anyone', () => {
  withEnv({ CHAT2API_REPLAY_SLIM_IMAGES: 'off' }, () => {
    for (const p of [QWEN, GLM]) {
      assert.equal(resolveImageSlimPolicy({
        provider: p, actualModel: 'x', mode: imageSlimModeFromEnv(GLM), afterBusyRejection: true,
      }), undefined)
    }
  })
})

test('a provider without vision never gets a policy, even at mode always', () => {
  withEnv({ CHAT2API_REPLAY_SLIM_IMAGES: 'always' }, () => {
    assert.equal(resolveImageSlimPolicy({
      provider: DEEPSEEK, actualModel: 'deepseek-chat', mode: imageSlimModeFromEnv(GLM), afterBusyRejection: false,
    }), undefined)
  })
})

test('on-busy does not slim a non-Qwen provider even after a busy rejection', () => {
  // The reactive trigger is a Qwen STS-quota defense. Another provider reporting
  // busy is not that, so the flag must not be honored for it.
  withEnv({ CHAT2API_REPLAY_SLIM_IMAGES: 'on-busy' }, () => {
    assert.equal(resolveImageSlimPolicy({
      provider: GLM, actualModel: 'glm-4', mode: imageSlimModeFromEnv(GLM), afterBusyRejection: true,
    }), undefined)
  })
})

test('on-busy DOES slim Qwen after a busy rejection', () => {
  withEnv({ CHAT2API_QWEN_AI_REPLAY_SLIM_IMAGES: 'on-busy' }, () => {
    assert.equal(resolveImageSlimPolicy({
      provider: QWEN, actualModel: 'qwen-max', mode: imageSlimModeFromEnv(QWEN), afterBusyRejection: true,
    })?.reason, 'qwen-busy')
    assert.equal(resolveImageSlimPolicy({
      provider: QWEN, actualModel: 'qwen-max', mode: imageSlimModeFromEnv(QWEN), afterBusyRejection: false,
    }), undefined)
  })
})

test('an unknown provider is never slimmed', () => {
  withEnv({ CHAT2API_REPLAY_SLIM_IMAGES: 'always' }, () => {
    assert.equal(resolveImageSlimPolicy({
      provider: provider('my-custom'), actualModel: 'm', mode: imageSlimModeFromEnv(GLM), afterBusyRejection: false,
    }), undefined)
  })
})

// ---------------------------------------------------------------------------
// Clamp and placeholder
// ---------------------------------------------------------------------------

test('keepLast is clamped to at least 1 and the clamp is reported', () => {
  // The newest image-bearing message is the current turn's reference. A
  // `keepLast: 0` configuration would slim it away.
  withEnv({
    CHAT2API_REPLAY_SLIM_IMAGES: 'always',
    CHAT2API_REPLAY_KEEP_LAST_IMAGE_MESSAGES: '0',
  }, () => {
    const policy = resolveImageSlimPolicy({
      provider: GLM, actualModel: 'glm-4', mode: imageSlimModeFromEnv(GLM), afterBusyRejection: false,
    })
    assert.equal(policy!.keepLastImageMessages, 1, 'keepLast must never be allowed below 1')
  })
})

test('the placeholder falls back from the provider-neutral variable to the Qwen one', () => {
  withEnv({
    CHAT2API_REPLAY_SLIM_IMAGES: 'always',
    CHAT2API_REPLAY_IMAGE_PLACEHOLDER: undefined,
    CHAT2API_QWEN_AI_REPLAY_IMAGE_PLACEHOLDER: 'Qwen-specific placeholder',
  }, () => {
    const policy = resolveImageSlimPolicy({
      provider: GLM, actualModel: 'glm-4', mode: imageSlimModeFromEnv(GLM), afterBusyRejection: false,
    })
    assert.equal(policy!.placeholder, 'Qwen-specific placeholder')
  })
  withEnv({
    CHAT2API_REPLAY_SLIM_IMAGES: 'always',
    CHAT2API_REPLAY_IMAGE_PLACEHOLDER: undefined,
    CHAT2API_QWEN_AI_REPLAY_IMAGE_PLACEHOLDER: undefined,
  }, () => {
    const policy = resolveImageSlimPolicy({
      provider: GLM, actualModel: 'glm-4', mode: imageSlimModeFromEnv(GLM), afterBusyRejection: false,
    })
    assert.equal(policy!.placeholder, DEFAULT_IMAGE_SLIM_PLACEHOLDER)
  })
})

test('the policy carries no image content, only counts and a placeholder', () => {
  withEnv({ CHAT2API_REPLAY_SLIM_IMAGES: 'always' }, () => {
    const policy = resolveImageSlimPolicy({
      provider: GLM, actualModel: 'glm-4', mode: imageSlimModeFromEnv(GLM), afterBusyRejection: false,
    })
    assert.deepEqual(Object.keys(policy!).sort(),
      ['enabled', 'keepFirstImageMessages', 'keepLastImageMessages', 'placeholder', 'reason'])
  })
})
