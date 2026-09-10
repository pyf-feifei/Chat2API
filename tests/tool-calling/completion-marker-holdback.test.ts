import assert from 'node:assert/strict'
import test from 'node:test'

import { ToolStreamParser } from '../../src/main/proxy/toolCalling/ToolStreamParser.ts'
import { qwenHermesProtocol } from '../../src/main/proxy/toolCalling/protocols/qwenHermes.ts'
import {
  findStrayManagedWorkflowCompletionMarker,
  stripStrayManagedWorkflowCompletionMarkers,
  trailingPartialManagedWorkflowCompletionMarkerIndex,
} from '../../src/main/proxy/toolCalling/workflowCompletion.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

function managedPlan(overrides: Partial<ToolCallingPlan> = {}): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol: 'qwen_hermes',
    clientAdapterId: 'standard-openai-tools',
    providerId: 'qwen-ai',
    tools: [{ name: 'exec_command', parameters: { type: 'object', properties: {} }, source: 'openai' }],
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['exec_command']),
    workflowContinuation: true,
    failedToolResultPending: false,
    ...overrides,
  }
}

const TOOL_BLOCK = [
  '<tool_call>',
  '<function=exec_command>',
  '<parameter=cmd>',
  'echo verified',
  '</parameter>',
  '</function>',
  '</tool_call>',
].join('\n')

interface StreamOutcome {
  content: string
  toolCalls: Array<{ function?: { name?: string } }>
}

function streamThrough(plan: ToolCallingPlan, deltas: string[]): StreamOutcome {
  const parser = new ToolStreamParser(plan, 'call_stress')
  const contentParts: string[] = []
  const toolCalls: Array<{ function?: { name?: string } }> = []
  const baseChunk = {}
  const collect = (chunks: any[]) => {
    for (const chunk of chunks) {
      const delta = chunk?.choices?.[0]?.delta
      if (typeof delta?.content === 'string') contentParts.push(delta.content)
      if (Array.isArray(delta?.tool_calls)) toolCalls.push(...delta.tool_calls)
    }
  }
  for (const delta of deltas) collect(parser.push(delta, baseChunk, false))
  collect(parser.flush(baseChunk))
  return { content: contentParts.join(''), toolCalls }
}

/** Splits text into deltas whose size varies per iteration so partial-prefix
 * holds are exercised at many offsets, deterministically. */
function chunkByIndex(text: string, iteration: number): string[] {
  const size = 1 + (iteration % 9)
  const deltas: string[] = []
  for (let index = 0; index < text.length; index += size) {
    deltas.push(text.slice(index, index + size))
  }
  if (deltas.length === 0) deltas.push('')
  return deltas
}

test('stress: marker beside a tool call never reaches the client and costs no extra request', () => {
  const ITERATIONS = 200
  for (let i = 0; i < ITERATIONS; i += 1) {
    const prose = `Step ${i}: verified the selector, captured the screenshot, and compared it with the recorded fixture.`
    const response = `${prose}\n\n<chat2api_workflow_complete/>\n\n${TOOL_BLOCK}`
    const outcome = streamThrough(managedPlan(), chunkByIndex(response, i))

    assert.equal(
      outcome.content.includes('chat2api_workflow_complete'),
      false,
      `iteration ${i}: completion marker leaked into visible content`,
    )
    assert.equal(outcome.toolCalls.length, 1, `iteration ${i}: tool call lost`)
    assert.equal(outcome.toolCalls[0]?.function?.name, 'exec_command', `iteration ${i}: wrong tool name`)
    assert.ok(
      outcome.content.includes(`Step ${i}:`),
      `iteration ${i}: pre-marker prose was dropped`,
    )
  }
})

test('stress: marker-only terminal proof delivers clean prose with no tool call', () => {
  const ITERATIONS = 120
  for (let i = 0; i < ITERATIONS; i += 1) {
    const prose = `Final report ${i}: all requested operations completed and verified by tool results.`
    const response = `${prose}\n\n<chat2api_workflow_complete/>`
    const outcome = streamThrough(managedPlan(), chunkByIndex(response, i))

    assert.equal(outcome.content.includes('chat2api_workflow_complete'), false, `iteration ${i}: marker leaked`)
    assert.equal(outcome.toolCalls.length, 0, `iteration ${i}: unexpected tool call`)
    assert.equal(outcome.content.trimEnd(), prose, `iteration ${i}: proof prose corrupted`)
  }
})

test('stress: marker followed by prose is suppressed from the stream', () => {
  const ITERATIONS = 120
  for (let i = 0; i < ITERATIONS; i += 1) {
    const prose = `Progress ${i}: reading the recorded fixture.`
    const response = `${prose}\n\n<chat2api_workflow_complete/> still running, next I will integrate the component.`
    const outcome = streamThrough(managedPlan(), chunkByIndex(response, i))

    assert.equal(outcome.content.includes('chat2api_workflow_complete'), false, `iteration ${i}: marker leaked`)
    assert.equal(outcome.toolCalls.length, 0, `iteration ${i}: unexpected tool call`)
  }
})

test('stress: duplicate and non-self-closing marker variants are all suppressed', () => {
  const ITERATIONS = 80
  for (let i = 0; i < ITERATIONS; i += 1) {
    const prose = `Report ${i}: the module is complete.`
    const shapes = [
      `${prose}\n<chat2api_workflow_complete/><chat2api_workflow_complete/>\n\n${TOOL_BLOCK}`,
      `${prose}\n<chat2api_workflow_complete>\n\n${TOOL_BLOCK}`,
      `${prose}\n<chat2api_workflow_complete/> mid text\n\n${TOOL_BLOCK}`,
    ]
    for (const [shapeIndex, response] of shapes.entries()) {
      const outcome = streamThrough(managedPlan(), chunkByIndex(response, i + shapeIndex))
      assert.equal(
        outcome.content.includes('chat2api_workflow_complete'),
        false,
        `iteration ${i} shape ${shapeIndex}: marker leaked`,
      )
      assert.equal(outcome.toolCalls.length, 1, `iteration ${i} shape ${shapeIndex}: tool call lost`)
    }
  }
})

test('literal markers in fenced, quoted, and indented lines are preserved', () => {
  const cases = [
    '```xml\n<chat2api_workflow_complete/>\n```',
    '> <chat2api_workflow_complete/>',
    'Example:\n\n    <chat2api_workflow_complete/>',
  ]
  for (const [index, response] of cases.entries()) {
    const outcome = streamThrough(managedPlan(), chunkByIndex(response, index))
    assert.ok(
      outcome.content.includes('<chat2api_workflow_complete'),
      `case ${index}: documented literal marker was stripped`,
    )
  }
})

test('partial marker prefix held across deltas never leaks or loses prose', () => {
  // Exercise every split point of the marker prefix.
  const marker = '<chat2api_workflow_complete/>'
  for (let split = 1; split < marker.length; split += 1) {
    const prose = 'Analysis complete for the requested inspection.'
    const response = `${prose}\n\n${marker}`
    const deltas = [`${prose}\n\n${marker.slice(0, split)}`, marker.slice(split)]
    const outcome = streamThrough(managedPlan(), deltas)
    assert.equal(outcome.content.includes('chat2api_workflow_complete'), false, `split ${split}: marker leaked`)
    assert.equal(outcome.content.trimEnd(), prose, `split ${split}: prose corrupted`)
  }
})

test('false-positive partial prefix (never completes to a marker) is released as prose', () => {
  const response = 'Read <chat2api_workflow configuration from the docs and applied it.'
  const split = response.indexOf('<chat2api_workflow') + '<chat2api_workflow'.length
  const outcome = streamThrough(managedPlan(), [response.slice(0, split), response.slice(split)])
  assert.equal(outcome.content, response)
  assert.equal(outcome.toolCalls.length, 0)
})

test('workflowCompletion helper unit coverage', () => {
  const stray = findStrayManagedWorkflowCompletionMarker('prose\n\n<chat2api_workflow_complete/>')
  assert.equal(stray?.start, 7)
  assert.equal(stray?.end, 7 + '<chat2api_workflow_complete/>'.length)

  assert.equal(
    findStrayManagedWorkflowCompletionMarker('```xml\n<chat2api_workflow_complete/>')?.start,
    undefined,
  )
  assert.equal(
    findStrayManagedWorkflowCompletionMarker('> <chat2api_workflow_complete/>')?.start,
    undefined,
  )
  assert.equal(
    findStrayManagedWorkflowCompletionMarker('text <chat2api_workflow_completeX more'),
    undefined,
  )

  const partial = trailingPartialManagedWorkflowCompletionMarkerIndex('answer text <chat2api_workfl')
  assert.equal(partial, 'answer text '.length)
  assert.equal(trailingPartialManagedWorkflowCompletionMarkerIndex('plain text without markers'), undefined)

  assert.equal(
    stripStrayManagedWorkflowCompletionMarkers('a\n<chat2api_workflow_complete/>\nb'),
    'a\n\nb',
  )
  assert.equal(
    stripStrayManagedWorkflowCompletionMarkers('keep\n```\n<chat2api_workflow_complete/>\n```\nas-is'),
    'keep\n```\n<chat2api_workflow_complete/>\n```\nas-is',
  )
})

function managedXmlPlan(overrides: Partial<ToolCallingPlan> = {}): ToolCallingPlan {
  return managedPlan({
    protocol: 'managed_xml',
    ...overrides,
  })
}

const MANAGED_XML_TOOL_BLOCK = '<|CHAT2API|tool_calls><|CHAT2API|invoke name="exec_command"><|CHAT2API|parameter name="cmd"><![CDATA[echo verified]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>'

test('stress: widened gate covers managed_xml plans (zai/m365/deepseek/glm family)', () => {
  const ITERATIONS = 60
  for (let i = 0; i < ITERATIONS; i += 1) {
    const prose = `Report ${i}: verified the selector against the recorded fixture.`
    const response = `${prose}\n\n<chat2api_workflow_complete/>\n\n${MANAGED_XML_TOOL_BLOCK}`
    const outcome = streamThrough(managedXmlPlan(), chunkByIndex(response, i))
    assert.equal(outcome.content.includes('chat2api_workflow_complete'), false, `iteration ${i}: marker leaked on managed_xml`)
    assert.equal(outcome.toolCalls.length, 1, `iteration ${i}: managed_xml tool call lost`)
  }
})

test('stress: denial-claim prose is suppressed while the tool call is delivered (2026-09-10 incident verbatim)', () => {
  const ITERATIONS = 120
  const analysis = 'The screenshot shows a jigsaw puzzle captcha requiring gap detection before the drag.'
  const denial = 'Since the `exec_command` tool is currently unavailable in this environment (returning "does not exists"), I cannot directly modify the `run.mjs` file or run the test. However, I can provide the exact code logic needed:'
  const codeDump = '\n\n```js\nasync function solveAliyunCaptcha(page) {\n  const bgImg = page.locator("#aliyunCaptcha-img");\n  const puzzleImg = page.locator("#aliyunCaptcha-puzzle");\n  // drag logic here\n}\n```\n'
  for (let i = 0; i < ITERATIONS; i += 1) {
    const response = `${analysis}\n\n${denial}${codeDump}\n<chat2api_workflow_complete/>\n\n${TOOL_BLOCK}`
    const outcome = streamThrough(managedPlan(), chunkByIndex(response, i))
    assert.equal(outcome.toolCalls.length, 1, `iteration ${i}: tool call lost`)
    assert.equal(outcome.content.includes('currently unavailable'), false, `iteration ${i}: denial claim leaked`)
    assert.equal(outcome.content.includes('solveAliyunCaptcha'), false, `iteration ${i}: dumped code leaked`)
    assert.equal(outcome.content.includes('chat2api_workflow_complete'), false, `iteration ${i}: marker leaked`)
    assert.ok(outcome.content.includes('jigsaw puzzle captcha'), `iteration ${i}: pre-denial analysis lost`)
  }
})

test('denial claim with no tool call is suppressed from the stream', () => {
  const analysis = 'Analysis of the requested inspection is complete.'
  const denial = 'The tools are currently unavailable in this session — all calls return errors.'
  const response = `${analysis}\n\n${denial}\n\nOnce exec_command becomes available again, I will patch run.mjs.\n\n<chat2api_workflow_complete/>`
  const outcome = streamThrough(managedPlan(), [response])
  assert.equal(outcome.content.includes('currently unavailable'), false)
  assert.equal(outcome.content.includes('becomes available'), false)
  assert.equal(outcome.content.includes('chat2api_workflow_complete'), false)
  assert.equal(outcome.toolCalls.length, 0)
})

test('denial-claim hold does not fire for failed-tool-result turns (relaxed contract)', () => {
  const analysis = 'Analysis of the requested inspection is complete.'
  const denial = 'The exec_command tool is currently unavailable in this environment.'
  const response = `${analysis}\n\n${denial}\n\n${TOOL_BLOCK}`
  const outcome = streamThrough(managedPlan({ failedToolResultPending: true }), [response])
  assert.ok(outcome.content.includes('currently unavailable'), 'failed-result turns keep their relaxed contract')
  assert.equal(outcome.toolCalls.length, 1)
})

test('file-does-not-exist reports are not mistaken for tool-denial claims', () => {
  const prose = 'The file artifacts/debug-signup.html does not exist in the workspace. Let me list the directory first.'
  const response = `${prose}\n\n${TOOL_BLOCK}`
  const outcome = streamThrough(managedPlan(), [response])
  assert.ok(outcome.content.includes('does not exist in the workspace'), 'legitimate file report was suppressed')
  assert.equal(outcome.toolCalls.length, 1)
})

test('denial claim spanning a push boundary is still held', () => {
  const analysis = 'Analysis complete for the requested inspection.'
  const response = `${analysis}\n\nSince the exec_command tool is currently unavailable in this environment, here is the plan.\n\n${TOOL_BLOCK}`
  const cut = response.indexOf('currently') + 4
  const outcome = streamThrough(managedPlan(), [response.slice(0, cut), response.slice(cut)])
  assert.equal(outcome.content.includes('unavailable'), false, 'boundary-spanning denial leaked')
  assert.equal(outcome.toolCalls.length, 1)
})

test('2026-09-10 continued-session denial verbatims are held (Chinese gap phrasing + returns-does-not-exists)', () => {
  const verbatims = [
    // 11:17:03 shape: Chinese inserts modifiers between 工具 and 不可用
    '由于 `exec_command` 和 `view_image` 工具在当前环境中不可用（返回 "does not exists"），我无法直接查看截图或重新运行脚本来诊断问题。',
    // 11:20:14 shape: "<tool> is returning \"does not exists\" in this environment"
    'Since `exec_command` is returning "does not exists" in this environment, I cannot execute commands to fix and re-run the test.',
    // tail-of-message shape: 由于工具限制，我无法在此环境中完成端到端验证
    '由于工具限制，我无法在此环境中完成端到端验证。请在本地执行上述命令以测试完整流程。',
  ]
  for (const [index, denial] of verbatims.entries()) {
    const analysis = `Run ${index}: account.json shows activated false and the captcha solver needs a re-run.`
    const response = `${analysis}\n\n${denial}\n\n${TOOL_BLOCK}`
    const outcome = streamThrough(managedPlan(), chunkByIndex(response, index))
    assert.equal(outcome.toolCalls.length, 1, `verbatim ${index}: tool call lost`)
    assert.equal(
      outcome.content.includes('does not exists'),
      false,
      `verbatim ${index}: denial claim leaked`,
    )
    assert.ok(outcome.content.includes(`Run ${index}:`), `verbatim ${index}: pre-denial analysis lost`)
  }
})

test('2026-09-10 11:34 verbatim: "is currently returning does not exists" is held beside a tool call', () => {
  const analysis = 'The "点击开始验证" element is a custom NoCaptcha SDK element, not a standard button.'
  const denial = 'Since the `exec_command` tool is currently returning "does not exists" for every invocation in this environment, I cannot directly modify the script.'
  const response = `${analysis}\n\n${denial}\n\n${TOOL_BLOCK}`
  for (let i = 0; i < 40; i += 1) {
    const outcome = streamThrough(managedPlan(), chunkByIndex(response, i))
    assert.equal(outcome.toolCalls.length, 1, `iteration ${i}: tool call lost`)
    assert.equal(outcome.content.includes('does not exists'), false, `iteration ${i}: denial leaked`)
    assert.ok(outcome.content.includes('NoCaptcha SDK'), `iteration ${i}: pre-denial analysis lost`)
  }
})

test('weak-only "does not exists" quotation: dropped with a tool call, released without one', () => {
  const prose = 'The upstream log line reads: Tool exec_command does not exists. That confirms the diagnosis.'
  const withCall = streamThrough(managedPlan(), [`${prose}\n\n${TOOL_BLOCK}`])
  assert.equal(withCall.toolCalls.length, 1)
  assert.equal(withCall.content.includes('does not exists'), false, 'proven-hallucinated quotation must drop')

  const withoutCall = streamThrough(managedPlan(), [prose])
  assert.equal(withoutCall.toolCalls.length, 0)
  assert.ok(withoutCall.content.includes('does not exists'), 'legitimate debugging quotation must survive')
  assert.ok(withoutCall.content.includes('confirms the diagnosis'), 'post-quotation prose must survive')
})

test('2026-09-10 echo-loop verbatim: platform-diagnostic sentence is held whole, no fragment tail leaks', () => {
  const ITERATIONS = 60
  const analysis = '从调试脚本已确认"点击开始验证"按钮的选择器是 #aliyunCaptcha-captcha-body。之前的正则替换因多行匹配问题未生效，现在直接重写整个 run.mjs 文件确保修复正确应用。'
  for (let i = 0; i < ITERATIONS; i += 1) {
    const response = `${analysis}\n\nTool exec_command does not exists.\n\n${TOOL_BLOCK}`
    const outcome = streamThrough(managedPlan(), chunkByIndex(response, i))
    assert.equal(outcome.toolCalls.length, 1, `iteration ${i}: tool call lost`)
    assert.equal(
      /Tool exec_command\s*$/.test(outcome.content) || outcome.content.includes('does not exists'),
      false,
      `iteration ${i}: diagnostic fragment leaked as message tail`,
    )
    assert.ok(outcome.content.includes('确保修复正确应用'), `iteration ${i}: pre-diagnostic analysis lost`)
  }
})

test('strong-claim hold starts at the sentence boundary, keeping subject fragments out', () => {
  const prose = 'The fix is ready. Since the `exec_command` tool is currently returning "does not exists" in this environment, I cannot proceed.'
  const withCall = streamThrough(managedPlan(), [`${prose}\n\n${TOOL_BLOCK}`])
  assert.equal(withCall.toolCalls.length, 1)
  assert.ok(withCall.content.includes('The fix is ready.'), 'previous sentence preserved')
  assert.equal(withCall.content.includes('is currently returning'), false, 'claim sentence suppressed whole')
  assert.equal(/tool is\s*$/.test(withCall.content), false, 'subject fragment must not end the message')
})

test('2026-09-10 post-guidance verbatim: "当工具恢复可用时" code-dump ending is a denial claim', () => {
  const analysis = '关键变化：移除了 Continue with Email 步骤，Sign up 选择器改为优先匹配注册链接。'
  const denial = '当 `exec_command` 工具恢复可用时，我可以立即应用这个补丁并运行完整流程测试。'
  const response = `${analysis}\n\n${denial}\n\n<chat2api_workflow_complete/>`
  const outcome = streamThrough(managedPlan(), chunkByIndex(response, 3))
  assert.equal(outcome.toolCalls.length, 0)
  assert.equal(outcome.content.includes('恢复可用'), false, 'recovery-availability denial leaked')
  assert.equal(outcome.content.includes('chat2api_workflow_complete'), false, 'marker leaked')
})

test('payload guidance and platform diagnostic are env-tunable (off sentinel)', async () => {
  const tools = [{ name: 'exec_command', parameters: { type: 'object', properties: {} } }] as any[]
  process.env.CHAT2API_TOOL_CALLING_LARGE_PAYLOAD_GUIDANCE = 'off'
  try {
    assert.doesNotMatch(qwenHermesProtocol.renderRecoveryPrompt(tools), /smaller payload split/)
    assert.doesNotMatch(qwenHermesProtocol.renderContinuationReminder(tools), /smaller payload chunks/)
  } finally {
    delete process.env.CHAT2API_TOOL_CALLING_LARGE_PAYLOAD_GUIDANCE
  }
  assert.match(qwenHermesProtocol.renderRecoveryPrompt(tools), /smaller payload split/)

  const { platformToolDiagnosticPattern } = await import('../../src/main/proxy/toolCalling/promptGuidance.ts')
  assert.match('Tool exec_command does not exists.', platformToolDiagnosticPattern()!)
  process.env.CHAT2API_TOOL_CALLING_PLATFORM_TOOL_DIAGNOSTIC = 'off'
  try {
    assert.equal(platformToolDiagnosticPattern(), undefined)
  } finally {
    delete process.env.CHAT2API_TOOL_CALLING_PLATFORM_TOOL_DIAGNOSTIC
  }
})
