import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyQwenAiDepthDirective,
  placeQwenAiDepthDirective,
  qwenAiDepthPromptChannelFromEnv,
  qwenAiDepthDirectiveText,
  qwenAiDepthPromptEnabled,
  qwenAiEffortDepthMapFromEnv,
  resolveQwenAiDepthDirective,
} from '../../src/main/proxy/adapters/qwen-ai-depth-prompt.ts'

const ENV_KEYS = [
  'CHAT2API_QWEN_AI_EFFORT_PROMPT',
  'CHAT2API_QWEN_AI_EFFORT_DEPTH_MAP',
  'CHAT2API_QWEN_AI_DEPTH_PROMPT_CHANNEL',
  'CHAT2API_QWEN_AI_DEPTH_PROMPT_LIGHT',
  'CHAT2API_QWEN_AI_DEPTH_PROMPT_MEDIUM',
  'CHAT2API_QWEN_AI_DEPTH_PROMPT_DEEP',
]

function withEnv(values: Record<string, string | undefined>, fn: () => void) {
  const previous: Record<string, string | undefined> = {}
  for (const key of ENV_KEYS) {
    previous[key] = process.env[key]
    if (values[key] === undefined) delete process.env[key]
    else process.env[key] = values[key]
  }
  try {
    fn()
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

test('a directive is resolved for each graded effort', () => {
  withEnv({}, () => {
    const light = resolveQwenAiDepthDirective({
      reasoningEffort: 'medium', thinkingEnabled: true, modePinned: false,
    })
    const medium = resolveQwenAiDepthDirective({
      reasoningEffort: 'high', thinkingEnabled: true, modePinned: false,
    })
    const deep = resolveQwenAiDepthDirective({
      reasoningEffort: 'xhigh', thinkingEnabled: true, modePinned: false,
    })
    assert.equal(light, qwenAiDepthDirectiveText('light'))
    assert.equal(medium, qwenAiDepthDirectiveText('medium'))
    assert.equal(deep, qwenAiDepthDirectiveText('deep'))
    // The three tiers must be distinct, otherwise effort would not be graded.
    assert.equal(new Set([light, medium, deep]).size, 3)
  })
})

test('camelCase and padded effort values resolve the same tier', () => {
  withEnv({}, () => {
    const expected = qwenAiDepthDirectiveText('deep')
    assert.equal(
      resolveQwenAiDepthDirective({ reasoningEffort: ' XHIGH ', thinkingEnabled: true, modePinned: false }),
      expected,
    )
  })
})

test('a disabled reasoning phase gets no directive: the prompt cannot turn thinking on', () => {
  withEnv({}, () => {
    assert.equal(resolveQwenAiDepthDirective({
      reasoningEffort: 'xhigh', thinkingEnabled: false, modePinned: false,
    }), undefined)
  })
})

test('a pinned mode and managed tool calling are left untouched', () => {
  withEnv({}, () => {
    assert.equal(resolveQwenAiDepthDirective({
      reasoningEffort: 'xhigh', thinkingEnabled: true, modePinned: true,
    }), undefined)
    assert.equal(resolveQwenAiDepthDirective({
      reasoningEffort: 'xhigh', thinkingEnabled: true, modePinned: false, managedToolCalling: true,
    }), undefined)
  })
})

test('an unmapped effort and a missing effort produce no directive', () => {
  withEnv({}, () => {
    assert.equal(resolveQwenAiDepthDirective({
      reasoningEffort: 'low', thinkingEnabled: true, modePinned: false,
    }), undefined)
    assert.equal(resolveQwenAiDepthDirective({
      reasoningEffort: undefined, thinkingEnabled: true, modePinned: false,
    }), undefined)
  })
})

test('the master switch disables every directive', () => {
  withEnv({ CHAT2API_QWEN_AI_EFFORT_PROMPT: 'false' }, () => {
    assert.equal(qwenAiDepthPromptEnabled(), false)
    assert.equal(resolveQwenAiDepthDirective({
      reasoningEffort: 'xhigh', thinkingEnabled: true, modePinned: false,
    }), undefined)
  })
})

test('the channel default is user and an unknown value fails over to it', () => {
  withEnv({}, () => assert.equal(qwenAiDepthPromptChannelFromEnv(), 'user'))
  withEnv({ CHAT2API_QWEN_AI_DEPTH_PROMPT_CHANNEL: 'native' }, () =>
    assert.equal(qwenAiDepthPromptChannelFromEnv(), 'native'))
  withEnv({ CHAT2API_QWEN_AI_DEPTH_PROMPT_CHANNEL: 'system' }, () =>
    assert.equal(qwenAiDepthPromptChannelFromEnv(), 'user'))
})

test('the native channel writes into system_message and leaves the user turn alone', () => {
  withEnv({ CHAT2API_QWEN_AI_DEPTH_PROMPT_CHANNEL: 'native' }, () => {
    const directive = qwenAiDepthDirectiveText('deep')
    const placed = placeQwenAiDepthDirective({
      directive,
      channel: qwenAiDepthPromptChannelFromEnv(),
      userContent: 'what is 2+2?',
      systemPrompt: 'You are a helpful assistant.',
      systemPromptMaxBytes: 4096,
      nativeSystemAvailable: true,
    })
    assert.equal(placed.usedChannel, 'native')
    assert.equal(placed.userContent, 'what is 2+2?')
    assert.ok(placed.systemPrompt.startsWith('You are a helpful assistant.'))
    assert.ok(placed.systemPrompt.includes('[reasoning-depth]'))
  })
})

test('the native channel can be the only system content when the client sent none', () => {
  withEnv({}, () => {
    const placed = placeQwenAiDepthDirective({
      directive: 'directive', channel: 'native', userContent: 'hi', systemPrompt: '',
      systemPromptMaxBytes: 4096, nativeSystemAvailable: true,
    })
    assert.equal(placed.usedChannel, 'native')
    assert.ok(placed.systemPrompt.startsWith('[reasoning-depth]'))
    assert.equal(placed.userContent, 'hi')
  })
})

test('a deployment without the native field falls back to the user turn', () => {
  withEnv({}, () => {
    const placed = placeQwenAiDepthDirective({
      directive: 'directive', channel: 'native', userContent: 'hi', systemPrompt: '',
      systemPromptMaxBytes: 4096, nativeSystemAvailable: false,
    })
    assert.equal(placed.usedChannel, 'user')
    assert.equal(placed.systemPrompt, '')
    assert.ok(placed.userContent.startsWith('[reasoning-depth]'))
  })
})

test('exceeding the native byte cap falls back to the user turn instead of dropping the client prompt', () => {
  withEnv({}, () => {
    const clientPrompt = 'A'.repeat(200)
    const placed = placeQwenAiDepthDirective({
      directive: 'directive', channel: 'native', userContent: 'hi',
      systemPrompt: clientPrompt, systemPromptMaxBytes: 220, nativeSystemAvailable: true,
    })
    assert.equal(placed.usedChannel, 'user')
    // The client prompt must survive untouched: over-cap native text would
    // make the extraction path fall back to the flattened transcript.
    assert.equal(placed.systemPrompt, clientPrompt)
    assert.ok(placed.userContent.startsWith('[reasoning-depth]'))
  })
})

test('placement is idempotent for both channels', () => {
  withEnv({}, () => {
    const first = placeQwenAiDepthDirective({
      directive: 'directive', channel: 'user', userContent: 'hi', systemPrompt: '',
      systemPromptMaxBytes: 4096, nativeSystemAvailable: true,
    })
    const again = placeQwenAiDepthDirective({
      directive: 'directive', channel: 'user', userContent: first.userContent,
      systemPrompt: first.systemPrompt, systemPromptMaxBytes: 4096, nativeSystemAvailable: true,
    })
    assert.equal(again.userContent, first.userContent)
    assert.equal(again.usedChannel, null)

    // A continuation that re-sends a native directive must not double it.
    const nativeFirst = placeQwenAiDepthDirective({
      directive: 'directive', channel: 'native', userContent: 'hi', systemPrompt: '',
      systemPromptMaxBytes: 4096, nativeSystemAvailable: true,
    })
    const nativeAgain = placeQwenAiDepthDirective({
      directive: 'directive', channel: 'native', userContent: 'hi',
      systemPrompt: nativeFirst.systemPrompt, systemPromptMaxBytes: 4096, nativeSystemAvailable: true,
    })
    assert.equal(nativeAgain.systemPrompt, nativeFirst.systemPrompt)
    assert.equal(nativeAgain.usedChannel, null)
  })
})

test('no directive leaves both fields byte-identical', () => {
  withEnv({}, () => {
    const placed = placeQwenAiDepthDirective({
      directive: undefined, channel: 'native', userContent: 'hi',
      systemPrompt: 'sys', systemPromptMaxBytes: 4096, nativeSystemAvailable: true,
    })
    assert.deepEqual(placed, { userContent: 'hi', systemPrompt: 'sys', usedChannel: null })
  })
})

test('the depth map and each directive text are deployment-tunable', () => {
  withEnv({ CHAT2API_QWEN_AI_EFFORT_DEPTH_MAP: 'high:deep,low:light' }, () => {
    const table = qwenAiEffortDepthMapFromEnv()
    assert.equal(table.high, 'deep')
    assert.equal(table.low, 'light')
    assert.equal(table.medium, undefined)
  })

  withEnv({ CHAT2API_QWEN_AI_EFFORT_DEPTH_MAP: 'garbage!!' }, () => {
    const table = qwenAiEffortDepthMapFromEnv()
    assert.equal(table.medium, 'light')
    assert.equal(table.high, 'medium')
    assert.equal(table.xhigh, 'deep')
  })

  withEnv({ CHAT2API_QWEN_AI_DEPTH_PROMPT_DEEP: 'custom deep directive' }, () => {
    assert.equal(qwenAiDepthDirectiveText('deep'), 'custom deep directive')
  })
})

test('the directive is applied once, ahead of the user turn', () => {
  const directive = qwenAiDepthDirectiveText('light')
  const applied = applyQwenAiDepthDirective('what is 2+2?', directive)
  assert.ok(applied.startsWith('[reasoning-depth]'))
  assert.ok(applied.endsWith('what is 2+2?'))
  assert.equal(applyQwenAiDepthDirective(applied, directive), applied)
  assert.equal(applyQwenAiDepthDirective('what is 2+2?', undefined), 'what is 2+2?')
  assert.equal(applyQwenAiDepthDirective('what is 2+2?', '  '), 'what is 2+2?')
})
