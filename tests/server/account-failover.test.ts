import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  forwardWithAccountFailover,
  isNextAccountFailoverEligible,
  resolveAccountFailoverLimit,
} from '../../src/main/proxy/accountFailover.ts'
import { estimateQwenAiRequestInputTokens } from '../../src/main/proxy/qwenAiCompactionBoundary.ts'
import type {
  AccountSelection,
  ChatCompletionRequest,
  ForwardResult,
} from '../../src/main/proxy/types.ts'

function selection(accountId: string): AccountSelection {
  return {
    account: { id: accountId } as AccountSelection['account'],
    provider: { id: 'qwen-ai' } as AccountSelection['provider'],
    actualModel: 'qwen3.8-max-preview',
  }
}

const nextAccountFailure: ForwardResult = {
  success: false,
  status: 503,
  error: 'account credentials need replacement',
  errorCode: 'qwen_ai_token_refresh_failed',
  retryable: false,
  accountFault: true,
  retryScope: 'next-account',
}

test('Qwen failover limit covers the current active account pool by default', () => {
  const baseInput = {
    configuredMaxFailovers: 3,
    qwenAiProvider: true,
    activeAccountCount: 99,
  }

  assert.equal(resolveAccountFailoverLimit(baseInput), 98)
  assert.equal(resolveAccountFailoverLimit({
    ...baseInput,
    qwenAiMaxAccountFailovers: '0',
  }), 98)
  assert.equal(resolveAccountFailoverLimit({
    ...baseInput,
    qwenAiMaxAccountFailovers: '20',
  }), 20)
})

test('non-Qwen failover limit preserves the configured retry count', () => {
  assert.equal(resolveAccountFailoverLimit({
    configuredMaxFailovers: 3,
    qwenAiProvider: false,
    activeAccountCount: 99,
    qwenAiMaxAccountFailovers: '80',
  }), 3)
})

test('preflight account failures switch accounts inside the same request', async () => {
  const first = selection('account-1')
  const second = selection('account-2')
  const attempted: string[] = []
  const failed: string[] = []
  const exclusions: string[][] = []

  const outcome = await forwardWithAccountFailover({
    initialSelection: first,
    maxFailovers: 3,
    forward: async ({ selection: current }) => {
      attempted.push(current.account.id)
      return current.account.id === first.account.id
        ? nextAccountFailure
        : { success: true, status: 200, body: { choices: [] } }
    },
    selectNext: excluded => {
      exclusions.push([...excluded])
      return excluded.has(first.account.id) ? second : null
    },
    onFailedAttempt: ({ selection: current }) => {
      failed.push(current.account.id)
    },
  })

  assert.deepEqual(attempted, ['account-1', 'account-2'])
  assert.deepEqual(failed, ['account-1'])
  assert.deepEqual(exclusions, [['account-1']])
  assert.equal(outcome.selection.account.id, 'account-2')
  assert.equal(outcome.result.success, true)
  assert.equal(outcome.failoverCount, 1)
})

test('Qwen capacity limits switch accounts inside the same client request', async () => {
  const first = selection('account-1')
  const second = selection('account-2')
  const attempted: string[] = []
  const capacityLimited: ForwardResult = {
    success: false,
    status: 429,
    error: 'Qwen AI upstream capacity is temporarily unavailable',
    errorCode: 'qwen_ai_capacity_limit',
    retryable: false,
    accountFault: true,
    retryScope: 'next-account',
  }

  const outcome = await forwardWithAccountFailover({
    initialSelection: first,
    maxFailovers: 1,
    forward: async ({ selection: current }) => {
      attempted.push(current.account.id)
      return current.account.id === first.account.id
        ? capacityLimited
        : { success: true, status: 200, body: { choices: [] } }
    },
    selectNext: excluded => excluded.has(first.account.id) ? second : null,
  })

  assert.deepEqual(attempted, ['account-1', 'account-2'])
  assert.equal(outcome.result.success, true)
  assert.equal(outcome.selection.account.id, 'account-2')
  assert.equal(outcome.failoverCount, 1)
})

test('Qwen failover reaches a later healthy account after multiple 403 and 429 responses', async () => {
  const accounts = Array.from({ length: 6 }, (_, index) => selection(`account-${index + 1}`))
  const maxFailovers = resolveAccountFailoverLimit({
    configuredMaxFailovers: 3,
    qwenAiProvider: true,
    activeAccountCount: accounts.length,
  })
  const attempted: string[] = []

  const outcome = await forwardWithAccountFailover({
    initialSelection: accounts[0],
    maxFailovers,
    forward: async ({ selection: current }) => {
      attempted.push(current.account.id)
      if (current.account.id === accounts.at(-1)?.account.id) {
        return { success: true, status: 200, body: { choices: [] } }
      }

      const accountNumber = Number(current.account.id.split('-').at(-1))
      return {
        success: false,
        status: accountNumber % 2 === 0 ? 429 : 403,
        error: accountNumber % 2 === 0
          ? 'Qwen AI upstream capacity is temporarily unavailable'
          : 'Qwen AI risk-control challenge',
        errorCode: accountNumber % 2 === 0
          ? 'qwen_ai_capacity_limit'
          : 'qwen_ai_risk_control',
        retryable: false,
        accountFault: true,
        retryScope: 'next-account',
      }
    },
    selectNext: excluded => accounts.find(item => !excluded.has(item.account.id)) ?? null,
  })

  assert.equal(maxFailovers, 5)
  assert.deepEqual(attempted, accounts.map(item => item.account.id))
  assert.equal(outcome.result.success, true)
  assert.equal(outcome.selection.account.id, 'account-6')
  assert.equal(outcome.failoverCount, 5)
})

test('only explicit preflight replay scopes are replayed', async () => {
  const controller = new AbortController()
  const ineligible: ForwardResult[] = [
    { ...nextAccountFailure, retryScope: undefined },
    { ...nextAccountFailure, status: 499 },
  ]

  for (const result of ineligible) {
    let selections = 0
    const outcome = await forwardWithAccountFailover({
      initialSelection: selection('account-1'),
      maxFailovers: 3,
      forward: async () => result,
      selectNext: () => {
        selections += 1
        return selection('account-2')
      },
    })
    assert.equal(outcome.failoverCount, 0)
    assert.equal(selections, 0)
  }

  controller.abort()
  assert.equal(isNextAccountFailoverEligible(nextAccountFailure, controller.signal), false)
})

test('account-neutral preflight failures replay independently of account fault', async () => {
  const first = selection('account-1')
  const second = selection('account-2')
  const replayableUpstreamFailure: ForwardResult = {
    success: false,
    status: 502,
    error: 'upstream service rejected the request',
    retryable: false,
    accountFault: false,
    retryScope: 'next-account',
  }
  const attempted: string[] = []
  const reportedFailures: string[] = []

  const outcome = await forwardWithAccountFailover({
    initialSelection: first,
    maxFailovers: 1,
    forward: async ({ selection: current }) => {
      attempted.push(current.account.id)
      return current.account.id === first.account.id
        ? replayableUpstreamFailure
        : { success: true, status: 200, body: { choices: [] } }
    },
    selectNext: excluded => excluded.has(first.account.id) ? second : null,
    onFailedAttempt: ({ selection: current }) => {
      reportedFailures.push(current.account.id)
    },
  })

  assert.equal(isNextAccountFailoverEligible(replayableUpstreamFailure), true)
  assert.equal(isNextAccountFailoverEligible({
    ...replayableUpstreamFailure,
    accountFault: undefined,
  }), true)
  assert.deepEqual(attempted, ['account-1', 'account-2'])
  assert.deepEqual(reportedFailures, ['account-1'])
  assert.equal(outcome.result.success, true)
  assert.equal(outcome.failoverCount, 1)
})

test('account-neutral file parse timeout continues on the next account', async () => {
  const first = selection('account-1')
  const second = selection('account-2')
  const parseTimeout: ForwardResult = {
    success: false,
    status: 504,
    error: 'Qwen AI file parse timed out',
    errorCode: 'qwen_ai_file_parse_timeout',
    retryable: false,
    accountFault: false,
    retryScope: 'next-account',
  }
  const attempted: string[] = []

  const outcome = await forwardWithAccountFailover({
    initialSelection: first,
    maxFailovers: 1,
    forward: async ({ selection: current }) => {
      attempted.push(current.account.id)
      return current.account.id === first.account.id
        ? parseTimeout
        : { success: true, status: 200, body: { choices: [] } }
    },
    selectNext: excluded => excluded.has(first.account.id) ? second : null,
  })

  assert.deepEqual(attempted, ['account-1', 'account-2'])
  assert.equal(outcome.result.success, true)
  assert.equal(outcome.failoverCount, 1)
})

test('exhausted malformed-tool recovery replays the complete request on the next account', async () => {
  const accounts = [selection('account-1'), selection('account-2')]
  const attempted: string[] = []
  const malformedToolFailure: ForwardResult = {
    success: false,
    status: 502,
    error: 'Provider returned declared native tool call with incomplete JSON arguments: Bash',
    errorCode: 'malformed_tool_call',
    retryable: false,
    accountFault: false,
    retryScope: 'next-account',
  }

  const outcome = await forwardWithAccountFailover({
    initialSelection: accounts[0],
    maxFailovers: 1,
    forward: async ({ selection: current }) => {
      attempted.push(current.account.id)
      return current.account.id === accounts[0].account.id
        ? malformedToolFailure
        : { success: true, status: 200, body: { choices: [] } }
    },
    selectNext: excluded => accounts.find(item => !excluded.has(item.account.id)) ?? null,
  })

  assert.deepEqual(attempted, ['account-1', 'account-2'])
  assert.equal(outcome.result.success, true)
  assert.equal(outcome.selection.account.id, 'account-2')
  assert.equal(outcome.failoverCount, 1)
})

test('account-neutral busy and semantic failures reach a healthy later account', async () => {
  const accounts = [selection('account-1'), selection('account-2'), selection('account-3')]
  const attempted: string[] = []
  const accountFaults: Array<boolean | undefined> = []
  const failures: ForwardResult[] = [
    {
      success: false,
      status: 503,
      error: 'Qwen AI upstream is busy',
      errorCode: 'qwen_ai_upstream_busy',
      retryable: true,
      accountFault: false,
      retryScope: 'next-account',
    },
    {
      success: false,
      status: 422,
      error: 'Qwen AI completed without finishing the managed workflow',
      errorCode: 'qwen_ai_semantic_incomplete',
      retryable: false,
      accountFault: false,
      retryScope: 'next-account',
    },
  ]

  const outcome = await forwardWithAccountFailover({
    initialSelection: accounts[0],
    maxFailovers: 2,
    forward: async ({ selection: current, attempt }) => {
      attempted.push(current.account.id)
      return failures[attempt - 1] ?? {
        success: true,
        status: 200,
        body: { choices: [{ message: { content: 'healthy-account-only' } }] },
      }
    },
    selectNext: excluded => accounts.find(item => !excluded.has(item.account.id)) ?? null,
    onFailedAttempt: (_attempt, result) => {
      accountFaults.push(result.accountFault)
    },
  })

  assert.deepEqual(attempted, ['account-1', 'account-2', 'account-3'])
  assert.deepEqual(accountFaults, [false, false])
  assert.equal(outcome.result.success, true)
  assert.equal(outcome.selection.account.id, 'account-3')
  assert.equal(outcome.failoverCount, 2)
  assert.equal(outcome.result.body.choices[0].message.content, 'healthy-account-only')
})

test('concurrent 180K multi-tool requests remain intact across account-neutral failover', async () => {
  const tools = Array.from({ length: 12 }, (_, index) => ({
    type: 'function' as const,
    function: {
      name: `fixture_tool_${index}`,
      description: `Stress fixture tool ${index}`,
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    },
  }))
  const messages: ChatCompletionRequest['messages'] = [{
    role: 'system',
    content: 'LONG_CONTEXT_START::LONG_CONTEXT_END',
  }]
  for (let index = 0; index < 62; index += 1) {
    const callId = `stress_call_${index}`
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: callId,
        type: 'function',
        function: {
          name: `fixture_tool_${index % tools.length}`,
          arguments: JSON.stringify({ value: `input-${index}` }),
        },
      }],
    })
    messages.push({
      role: 'tool',
      tool_call_id: callId,
      content: JSON.stringify({ ok: true, index, result: `tool-result-${index}` }),
    })
  }
  while (messages.length < 182) {
    const index = messages.length
    messages.push({
      role: index % 2 === 0 ? 'assistant' : 'user',
      content: `preserved-history-${index}`,
    })
  }
  messages.push({ role: 'user', content: 'Finish the active task using the declared tools.' })

  let request: ChatCompletionRequest = {
    model: 'qwen3.8-max-preview',
    messages,
    tools,
    stream: true,
  }
  const initialTokens = estimateQwenAiRequestInputTokens(request)
  const padding = Math.max(0, (180_000 - initialTokens) * 3)
  request = {
    ...request,
    messages: request.messages.map((message, index) => index === 0
      ? { ...message, content: `LONG_CONTEXT_START:${'x'.repeat(padding)}:LONG_CONTEXT_END` }
      : { ...message }),
  }

  const estimatedTokens = estimateQwenAiRequestInputTokens(request)
  const serializedRequest = JSON.stringify(request)
  const concurrentRequests = 16
  let activeAttempts = 0
  let peakAttempts = 0

  assert.equal(request.messages.length, 183)
  assert.equal(request.tools?.length, 12)
  assert.equal(request.messages.filter(message => message.role === 'tool').length, 62)
  assert.ok(estimatedTokens >= 180_000, `expected at least 180K tokens, got ${estimatedTokens}`)
  assert.ok(estimatedTokens < 181_000, `expected a bounded 180K fixture, got ${estimatedTokens}`)

  const outcomes = await Promise.all(Array.from({ length: concurrentRequests }, async (_, index) => {
    const accounts = [0, 1, 2].map(accountIndex => selection(`stress-${index}-${accountIndex}`))
    const accountFaults: Array<boolean | undefined> = []
    const outcome = await forwardWithAccountFailover({
      initialSelection: accounts[0],
      maxFailovers: 2,
      forward: async ({ attempt }) => {
        activeAttempts += 1
        peakAttempts = Math.max(peakAttempts, activeAttempts)
        await new Promise(resolve => setImmediate(resolve))
        activeAttempts -= 1
        assert.equal(JSON.stringify(request), serializedRequest, 'account replay mutated the 180K request')
        if (attempt === 1) {
          return {
            success: false,
            status: 503,
            error: 'Qwen AI upstream is busy',
            errorCode: 'qwen_ai_upstream_busy',
            retryable: true,
            accountFault: false,
            retryScope: 'next-account',
          }
        }
        if (attempt === 2) {
          return {
            success: false,
            status: 422,
            error: 'managed workflow incomplete',
            errorCode: 'qwen_ai_semantic_incomplete',
            retryable: false,
            accountFault: false,
            retryScope: 'next-account',
          }
        }
        return {
          success: true,
          status: 200,
          body: { choices: [{ message: { content: `healthy-only-${index}` } }] },
        }
      },
      selectNext: excluded => accounts.find(item => !excluded.has(item.account.id)) ?? null,
      onFailedAttempt: (_attempt, result) => accountFaults.push(result.accountFault),
    })
    return { outcome, accountFaults, expectedContent: `healthy-only-${index}` }
  }))

  assert.equal(peakAttempts, concurrentRequests)
  for (const { outcome, accountFaults, expectedContent } of outcomes) {
    assert.equal(outcome.result.success, true)
    assert.equal(outcome.failoverCount, 2)
    assert.deepEqual(accountFaults, [false, false])
    assert.equal(outcome.result.body.choices[0].message.content, expectedContent)
  }
})

test('account-neutral CHAT_IN_PROGRESS continues on the next account', async () => {
  const first = selection('account-1')
  const second = selection('account-2')
  const chatInProgress: ForwardResult = {
    success: false,
    status: 429,
    error: 'Qwen AI chat is still in progress; switching to another account',
    errorCode: 'CHAT_IN_PROGRESS',
    retryable: false,
    accountFault: false,
    retryScope: 'next-account',
  }
  const attempted: string[] = []

  const outcome = await forwardWithAccountFailover({
    initialSelection: first,
    maxFailovers: 1,
    forward: async ({ selection: current }) => {
      attempted.push(current.account.id)
      return current.account.id === first.account.id
        ? chatInProgress
        : { success: true, status: 200, body: { choices: [] } }
    },
    selectNext: excluded => excluded.has(first.account.id) ? second : null,
  })

  assert.deepEqual(attempted, ['account-1', 'account-2'])
  assert.equal(outcome.result.success, true)
  assert.equal(outcome.selection.account.id, 'account-2')
  assert.equal(outcome.failoverCount, 1)
})

test('account failover is bounded and never reselects an excluded account', async () => {
  const accounts = [selection('account-1'), selection('account-2'), selection('account-3')]
  const attempted: string[] = []

  const outcome = await forwardWithAccountFailover({
    initialSelection: accounts[0],
    maxFailovers: 1,
    forward: async ({ selection: current }) => {
      attempted.push(current.account.id)
      return nextAccountFailure
    },
    selectNext: excluded => accounts.find(item => !excluded.has(item.account.id)) ?? null,
  })

  assert.deepEqual(attempted, ['account-1', 'account-2'])
  assert.equal(outcome.failoverCount, 1)
  assert.equal(outcome.result.success, false)

  const loadBalancerSource = fs.readFileSync('src/main/proxy/loadbalancer.ts', 'utf8')
  assert.match(loadBalancerSource, /excludedAccountIds: ReadonlySet<string>/)
  assert.match(loadBalancerSource, /!excludedAccountIds\.has\(account\.id\)/)
})

test('both OpenAI-compatible generation routes use the shared account failover policy', () => {
  for (const routePath of [
    'src/main/proxy/routes/chat.ts',
    'src/main/proxy/routes/responses.ts',
  ]) {
    const source = fs.readFileSync(routePath, 'utf8')
    assert.match(source, /forwardWithAccountFailover\(\{/)
    assert.match(source, /excludedAccountIds\s*=>\s*loadBalancer\.selectAccount\(/)
    assert.match(source, /reportAccountFailover\(selection\.account\.id/)
    assert.match(source, /accountFault !== false|isQwenAiAccountFault/)
    assert.match(source, /data:\s*\{\s*attempt,\s*status:\s*result\.status,\s*accountFault:\s*result\.accountFault/)
  }

  const chatSource = fs.readFileSync('src/main/proxy/routes/chat.ts', 'utf8')
  const responsesSource = fs.readFileSync('src/main/proxy/routes/responses.ts', 'utf8')
  assert.match(chatSource, /maxFailovers,/)
  assert.match(chatSource, /resolveAccountFailoverLimit\(\{/)
  assert.match(responsesSource, /maxFailovers,/)
  assert.match(responsesSource, /resolveAccountFailoverLimit\(\{/)
})
