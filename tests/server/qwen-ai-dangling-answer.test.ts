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

test('multi-paragraph answers are never progress-style regardless of opener', () => {
  const multiParagraph = [
    "I'll summarize the investigation so far.",
    '',
    'The container logs show three separate 503 events. Each corresponds to',
    'a governor queue timeout. The queue depth at enqueue was reported as 1.',
  ].join('\n')
  assert.equal(isProgressStyleManagedAnswer(multiParagraph.trim()), false)
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
