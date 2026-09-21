import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ManagedToolResultGuard as RealManagedToolResultGuard,
} from '../../src/main/proxy/toolCalling/managedToolResultGuard.ts'

// Single deterministic contract: the wrapper-leak VERDICT (the only signal
// that fails a client stream) must be identical whether the upstream stream
// delivers a marker whole or split at every possible byte boundary. Visible
// bytes after a leak verdict are irrelevant — the stream is failed either way.

const samples = [
  ['hermes tool_result', '<tool_response>\nstatus: error\nbuild failed\n</tool_response>', true],
  ['prose + hermes tool_result', `Before.\n<tool_result>ok</tool_result>\nAfter.`, true],
  ['hermes tool_call', '<tool_call>exec_command\nbuild</tool_call>', false],
  ['function_results', '<function_results>{"ok":true}</function_results>', true],
  ['xml tool_result', '<tool_result>ok</tool_result>', true],
  ['fence + tool_result', '```\nx\n```\n<tool_result>x</tool_result>', true],
  ['malformed qwen opener', '<tool_call=bad>', true],
  ['plain summary text', 'The build for module-1 completed with warnings; pending review.', false],
]

// Null protocol: protectedToolCallProtocol=null rejects every tool-result
// wrapper (its documented contract). qwen_hermes protects well-formed call
// envelopes but still flags result wrappers and malformed openers.
const expectLeak = {
  null: name => !name.startsWith('plain'),
  qwen_hermes: name => name.includes('tool_result') || name.includes('function_results') || name.includes('malformed'),
}

function leakVerdict(protocol, chunks) {
  const guard = new RealManagedToolResultGuard(protocol)
  for (const chunk of chunks) guard.push(chunk)
  guard.flush()
  return guard.hasDetectedWrapperLeak()
}

for (const protocol of [null, 'qwen_hermes']) {
  for (const [name, text] of samples) {
    test(`[${protocol}] leak verdict is split-stable: ${name}`, () => {
      const whole = leakVerdict(protocol, [text])
      assert.equal(whole, expectLeak[protocol](name), `single-shot classification for "${name}"`)
      for (let splitAt = 1; splitAt <= text.length; splitAt += 1) {
        const chunks = []
        for (let i = 0; i < text.length; i += splitAt) chunks.push(text.slice(i, i + splitAt))
        assert.equal(leakVerdict(protocol, chunks), whole, `splitAt=${splitAt} for "${name}"`)
      }
    })
  }
}
