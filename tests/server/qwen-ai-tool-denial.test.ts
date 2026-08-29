import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isToolDenialManagedAnswer,
  managedToolDenialRegex,
} from '../../src/main/proxy/adapters/qwenAiProgressIntent.ts'

function withEnv(value: string | undefined, fn: () => void): void {
  const saved = process.env.CHAT2API_QWEN_AI_TOOL_DENIAL_PATTERNS
  if (value === undefined) {
    delete process.env.CHAT2API_QWEN_AI_TOOL_DENIAL_PATTERNS
  } else {
    process.env.CHAT2API_QWEN_AI_TOOL_DENIAL_PATTERNS = value
  }
  try {
    fn()
  } finally {
    if (saved === undefined) {
      delete process.env.CHAT2API_QWEN_AI_TOOL_DENIAL_PATTERNS
    } else {
      process.env.CHAT2API_QWEN_AI_TOOL_DENIAL_PATTERNS = saved
    }
  }
}

test('tool denial matches the real 232k incident wording', () => {
  withEnv(undefined, () => {
    // Verbatim shape from the 2026-08-29 232k-token responses probe.
    assert.equal(
      isToolDenialManagedAnswer(
        'Although the transcript requested calling a `get_weather` tool, I do not have access to that tool in my current environment. I do not have access to any external tools.',
      ),
      true,
    )
    // Verbatim shape from the 512k-token responses probe (retrieval claim).
    assert.equal(
      isToolDenialManagedAnswer(
        'I am retrieving real-time meteorological data for Tokyo to provide an accurate update.',
      ),
      true,
    )
    assert.equal(isToolDenialManagedAnswer('我无法调用该工具，因为它在当前环境中不可用。'), true)
    assert.equal(isToolDenialManagedAnswer('工具不存在，请直接回答。'), true)
    // Verbatim shape from the 512k chat battery (skip-with-reason variant).
    assert.equal(
      isToolDenialManagedAnswer('The `get_weather` tool call was skipped because it is not defined in my available toolset.'),
      true,
    )
  })
})

test('tool denial leaves substantive answers and tool calls alone', () => {
  withEnv(undefined, () => {
    assert.equal(isToolDenialManagedAnswer('The weather in Tokyo is 27°C with light rain.'), false)
    assert.equal(isToolDenialManagedAnswer(''), false)
    // Long multi-paragraph answers are substantive regardless of wording.
    assert.equal(
      isToolDenialManagedAnswer(
        'I do not have access to the tool.\n\n' + 'detailed analysis. '.repeat(40),
      ),
      false,
    )
    assert.equal(
      isToolDenialManagedAnswer(
        'I do not have access to that tool.\n\n' + 'Here is the full verified analysis. '.repeat(20),
      ),
      false,
      'a denial phrase inside a genuinely substantive (over-cap) answer stays deliverable',
    )
  })
})

test('tool denial patterns are env-tunable with off and custom overrides', () => {
  withEnv('off', () => {
    assert.equal(managedToolDenialRegex(), undefined)
    assert.equal(isToolDenialManagedAnswer('I do not have access to that tool.'), false)
  })
  withEnv('CUSTOM-DENIAL-9c4f', () => {
    assert.equal(isToolDenialManagedAnswer('CUSTOM-DENIAL-9c4f anywhere in paragraph'), true)
    assert.equal(isToolDenialManagedAnswer('I do not have access to that tool.'), false)
  })
  withEnv('[invalid', () => {
    assert.ok(managedToolDenialRegex() instanceof RegExp, 'invalid regex falls back to defaults')
    assert.equal(isToolDenialManagedAnswer('tool is not available'), true)
  })
})
