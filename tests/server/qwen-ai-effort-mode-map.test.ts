import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveQwenAiModelMode,
  applyQwenAiEffortToModelMode,
  qwenAiEffortModeMapFromEnv,
} from '../../src/main/providers/qwen-ai-model-mode.ts'

test('bare qwen3.8-max floats and defaults to Auto', () => {
  const m = resolveQwenAiModelMode('qwen3.8-max')
  assert.equal(m.precedence, 'floating')
  assert.equal(m.thinkingMode, 'Auto')
  assert.equal(m.thinkingEnabled, true)
  assert.equal(m.autoThinking, true)
})

test('explicit _Fast and _Thinking suffixes pin their mode against any effort', () => {
  const fast = resolveQwenAiModelMode('Qwen3.8-Max_Fast')
  assert.equal(fast.precedence, 'pinned')
  assert.equal(fast.thinkingMode, 'Fast')
  assert.equal(applyQwenAiEffortToModelMode(fast, 'xhigh').thinkingMode, 'Fast')

  const thinking = resolveQwenAiModelMode('Qwen3.8-Max_Thinking')
  assert.equal(thinking.precedence, 'pinned')
  assert.equal(thinking.thinkingMode, 'Thinking')
  assert.equal(applyQwenAiEffortToModelMode(thinking, 'low').thinkingMode, 'Thinking')
})

test('_Auto floats so an explicit effort can take over', () => {
  const auto = resolveQwenAiModelMode('Qwen3.8-Max_Auto')
  assert.equal(auto.precedence, 'floating')

  const lowApplied = applyQwenAiEffortToModelMode(auto, 'low')
  assert.equal(lowApplied.thinkingMode, 'Fast')
  assert.equal(lowApplied.thinkingEnabled, false)
  assert.equal(lowApplied.autoThinking, false)

  const xhighApplied = applyQwenAiEffortToModelMode(auto, 'xhigh')
  assert.equal(xhighApplied.thinkingMode, 'Thinking')
  assert.equal(xhighApplied.thinkingEnabled, true)
  assert.equal(xhighApplied.autoThinking, false)

  // No effort keeps Auto rendering unchanged.
  const untouched = applyQwenAiEffortToModelMode(auto, undefined)
  assert.equal(untouched.thinkingMode, 'Auto')

  // The default effort (codex high) maps to Auto — no behavior change.
  const highApplied = applyQwenAiEffortToModelMode(auto, 'high')
  assert.equal(highApplied.thinkingMode, 'Auto')
  assert.equal(highApplied.thinkingEnabled, true)
  assert.equal(highApplied.autoThinking, true)
})

test('minimal maps like low; raw flag aliases pin their derived mode', () => {
  const auto = resolveQwenAiModelMode('Qwen3.8-Max_Auto')
  assert.equal(applyQwenAiEffortToModelMode(auto, 'minimal').thinkingMode, 'Fast')
  assert.equal(applyQwenAiEffortToModelMode(auto, 'medium').thinkingMode, 'Fast')

  const rawFast = resolveQwenAiModelMode('Qwen3.8-Max_TeF_AtF')
  assert.equal(rawFast.precedence, 'pinned')
  assert.equal(rawFast.thinkingMode, 'Fast')

  const rawAuto = resolveQwenAiModelMode('Qwen3.8-Max_TeT_AtT')
  assert.equal(rawAuto.thinkingMode, 'Auto')
})

test('default effort table matches the agreed mapping', () => {
  const table = qwenAiEffortModeMapFromEnv()
  assert.equal(table.minimal, 'Fast')
  assert.equal(table.low, 'Fast')
  assert.equal(table.medium, 'Fast')
  assert.equal(table.high, 'Auto')
  assert.equal(table.xhigh, 'Thinking')
  assert.equal(table.ultracode, 'Thinking')
  assert.equal(table.max, 'Thinking')
  assert.equal(table.default, 'Auto')
})

test('effort map is overridable via env and invalid values fall back', () => {
  const previous = process.env.CHAT2API_QWEN_AI_EFFORT_MODE_MAP
  try {
    process.env.CHAT2API_QWEN_AI_EFFORT_MODE_MAP = 'low:auto,xhigh:fast'
    const table = qwenAiEffortModeMapFromEnv()
    assert.equal(table.low, 'Auto')
    assert.equal(table.xhigh, 'Fast')

    process.env.CHAT2API_QWEN_AI_EFFORT_MODE_MAP = 'garbage!!'
    const fallback = qwenAiEffortModeMapFromEnv()
    assert.equal(fallback.high, 'Auto')
    assert.equal(fallback.xhigh, 'Thinking')
  } finally {
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_EFFORT_MODE_MAP
    else process.env.CHAT2API_QWEN_AI_EFFORT_MODE_MAP = previous
  }
})

test('unrelated model names are untouched and floating without modes', () => {
  const m = resolveQwenAiModelMode('qwen3.7-plus')
  assert.equal(m.isExplicit, false)
  assert.equal(m.precedence, 'floating')
  assert.equal(m.thinkingMode, undefined)
  assert.equal(m.thinkingEnabled, undefined)
})
