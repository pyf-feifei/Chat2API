import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isProgressStyleManagedAnswer,
  managedProgressIntentRegex,
} from '../../src/main/proxy/adapters/qwenAiProgressIntent.ts'

test('English intent openers are detected as progress-style', () => {
  assert.equal(
    isProgressStyleManagedAnswer("I'll find all `.js` files in the current directory containing \"module.exports\" and append the comment."),
    true,
  )
  assert.equal(isProgressStyleManagedAnswer("Let me check the container logs."), true)
  assert.equal(isProgressStyleManagedAnswer("I need to confirm the origin of the 503."), true)
  assert.equal(isProgressStyleManagedAnswer("I am going to inspect server.ts now."), true)
})

test('Chinese intent openers are detected as progress-style', () => {
  assert.equal(
    isProgressStyleManagedAnswer('我需要确认 503 的确切来源。让我检查容器内的 request-logs 和 server.ts 中空 body 503 的代码路径。'),
    true,
  )
  assert.equal(isProgressStyleManagedAnswer('让我检查一下文件。'), true)
  assert.equal(isProgressStyleManagedAnswer('我先看看日志。'), true)
  assert.equal(isProgressStyleManagedAnswer('接下来我会修复它。'), true)
})

test('substantive findings answers are NOT progress-style', () => {
  assert.equal(isProgressStyleManagedAnswer('The 503 responses originate from the upstream provider queue timeout.'), false)
  assert.equal(isProgressStyleManagedAnswer('Investigation complete: the bug was a missing name attribute in the parser.'), false)
})

test('multi-paragraph substantive findings stay deliverable (not progress-style)', () => {
  const multiParagraph = [
    "The container logs show three separate 503 events. Each corresponds to",
    'a governor queue timeout. The queue depth at enqueue was reported as 1.',
  ].join('\n')
  assert.equal(isProgressStyleManagedAnswer(multiParagraph.trim()), false)
})

// The opener word-list is assistance-only. The three real stall texts from
// 2026-08-29 (理解！… / 继续… / 我正在…) are NOT required to match the list —
// they are caught structurally by the live-workflow short-answer rule in the
// adapter (pinned in qwen-ai-dangling-classification.test.ts). These tests
// pin that the list itself stays minimal and generic.
test('word-list stays generic: incident-specific phrasings are not chased', () => {
  // Incident texts must NOT depend on the word list (structural rule owns them).
  assert.equal(isProgressStyleManagedAnswer('理解！完全遵守规范。'), false)
  assert.equal(isProgressStyleManagedAnswer('继续执行 3D 资产管线。先生成缺失的原型图。'), false)
  assert.equal(isProgressStyleManagedAnswer('我正在审视项目中的变更情况，确认哪些文件已准备就绪。'), false)
  // Generic openers still work as assistance on non-live-workflow turns.
  assert.equal(isProgressStyleManagedAnswer("I'll implement the pipeline now."), true)
  assert.equal(isProgressStyleManagedAnswer('让我检查一下文件。'), true)
})

test('over-long single-paragraph answers are never progress-style', () => {
  const long = 'Let me explain in exhaustive detail: ' + 'x'.repeat(400)
  assert.equal(isProgressStyleManagedAnswer(long), false)
})

test('detection is disabled via the "off" env sentinel', () => {
  const previous = process.env.CHAT2API_QWEN_AI_PROGRESS_INTENT_PATTERNS
  process.env.CHAT2API_QWEN_AI_PROGRESS_INTENT_PATTERNS = 'off'
  try {
    assert.equal(managedProgressIntentRegex(), undefined)
    assert.equal(isProgressStyleManagedAnswer('Let me check the files now.'), false)
  } finally {
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_PROGRESS_INTENT_PATTERNS
    else process.env.CHAT2API_QWEN_AI_PROGRESS_INTENT_PATTERNS = previous
  }
})

test('patterns are overridable via env', () => {
  const previous = process.env.CHAT2API_QWEN_AI_PROGRESS_INTENT_PATTERNS
  process.env.CHAT2API_QWEN_AI_PROGRESS_INTENT_PATTERNS = 'announcing|beginning'
  try {
    assert.equal(isProgressStyleManagedAnswer('Announcing the results next.'), true)
    assert.equal(isProgressStyleManagedAnswer('Let me check the files.'), false)
  } finally {
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_PROGRESS_INTENT_PATTERNS
    else process.env.CHAT2API_QWEN_AI_PROGRESS_INTENT_PATTERNS = previous
  }
})

test('invalid env regex falls back to defaults instead of throwing', () => {
  const previous = process.env.CHAT2API_QWEN_AI_PROGRESS_INTENT_PATTERNS
  process.env.CHAT2API_QWEN_AI_PROGRESS_INTENT_PATTERNS = '[unclosed'
  try {
    assert.equal(isProgressStyleManagedAnswer('Let me check the files.'), true)
  } finally {
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_PROGRESS_INTENT_PATTERNS
    else process.env.CHAT2API_QWEN_AI_PROGRESS_INTENT_PATTERNS = previous
  }
})

test('noun-usage continue phrasing is substantive, not progress-style', () => {
  assert.equal(
    isProgressStyleManagedAnswer('继续的部分已经全部完成了，剩下的只有收尾工作需要人工确认。'),
    false,
  )
})
