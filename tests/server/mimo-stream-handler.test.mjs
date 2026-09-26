import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { MimoStreamHandler } from '../../src/main/proxy/adapters/mimo.ts'

function makePlan() {
  return {
    mode: 'managed',
    protocol: 'managed_xml',
    providerId: 'mimo',
    tools: [{
      name: 'exec_command',
      description: 'Run a command',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    }],
    toolNameAliases: undefined,
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['exec_command']),
    allowedUpstreamToolNames: new Set(['exec_command']),
    workflowContinuation: false,
    failedToolResultPending: false,
    forcedToolName: undefined,
    diagnostics: {
      requestId: 'mimo-test',
      providerId: 'mimo',
      model: 'MiMo-V2.6-Pro-Ultraspeed',
      actualModel: 'MiMo-V2.6-Pro-Ultraspeed',
      toolCount: 1,
      allowedToolNames: ['exec_command'],
      workflowContinuation: false,
      failedToolResultPending: false,
    },
  }
}

function sseStream(content) {
  const event = `event: message\ndata: ${JSON.stringify({ type: 'message', content })}\n\n`
  return Readable.from([event])
}

const TOOL_CALL = '<|CHAT2API|tool_calls><|CHAT2API|invoke name="exec_command"></|CHAT2API|invoke></|CHAT2API|tool_calls>'
const TOOL_RESULT_WRAPPER = '<|CHAT2API|tool_result>INTERNAL_RESULT</|CHAT2API|tool_result>'

async function collect(handler, stream) {
  let output = ''
  for await (const chunk of handler.handleStream(stream)) output += chunk
  return output
}

test('Mimo suppresses managed tool-result wrappers from separate reasoning output', async () => {
  const handler = new MimoStreamHandler('MiMo-V2.6-Pro-Ultraspeed', 'conversation', 'separate', makePlan(), {
    deferOutput: true,
    tolerateProtocolError: true,
  })
  const output = await collect(handler, sseStream(`<think>reasoning ${TOOL_RESULT_WRAPPER} done</think>`))

  assert.doesNotMatch(output, /CHAT2API\|tool_result/)
  assert.doesNotMatch(output, /INTERNAL_RESULT/)
  assert.match(output, /reasoning  done/)
  assert.equal(handler.hasEmittedToolCall(), false)
  assert.match(handler.getProtocolError()?.message ?? '', /managed tool-result wrapper/)
})

test('Mimo suppresses generic tool-call drift from the reasoning channel', async () => {
  const handler = new MimoStreamHandler('MiMo-V2.6-Pro-Ultraspeed', 'conversation', 'separate', makePlan(), {
    deferOutput: true,
    tolerateProtocolError: true,
  })
  const output = await collect(handler, sseStream('<think><function_calls><invoke name="exec_command"></invoke></function_calls></think>'))

  assert.doesNotMatch(output, /<function_calls>|<invoke name=/)
  assert.match(handler.getProtocolError()?.message ?? '', /managed tool-result wrapper/)
})

test('Mimo converts concatenated pipe-delimited calls into function calls', async () => {
  const plan = makePlan()
  plan.tools = [{
    name: 'view_image',
    description: 'View an image',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  }]
  plan.allowedToolNames = new Set(['view_image'])
  plan.allowedUpstreamToolNames = new Set(['view_image'])
  const handler = new MimoStreamHandler('MiMo-V2.6-Pro-Ultraspeed', 'conversation', 'separate', plan, {
    deferOutput: true,
    tolerateProtocolError: true,
  })
  const text = String.raw`view_image>path>C:\my\village-chef\games-home\output\imagegen\ui-home-feed.pngview_image>path>C:\my\village-chef\games-home\output\imagegen\ui-publish.pngview_image>path>C:\my\village-chef\games-home\output\imagegen\ui-task-order.pngview_image>path>C:\my\village-chef\games-home\output\imagegen\ui-activity-signup.png`
  const output = await collect(handler, sseStream(text))

  assert.equal(handler.hasEmittedToolCall(), true)
  assert.doesNotMatch(output, /view_image>path>/)
  assert.equal(output.match(/"name":"view_image"/g)?.length, 4)
  assert.equal(output.match(/"finish_reason":"tool_calls"/g)?.length, 1)
})

test('Mimo maps the bash pipe alias to the declared exec_command tool', async () => {
  const plan = makePlan()
  plan.tools[0].parameters = {
    type: 'object',
    properties: { cmd: { type: 'string' } },
    required: ['cmd'],
    additionalProperties: false,
  }
  const handler = new MimoStreamHandler('MiMo-V2.6-Pro-Ultraspeed', 'conversation', 'separate', plan, {
    deferOutput: true,
    tolerateProtocolError: true,
  })
  const output = await collect(handler, sseStream('bash>command>echo local-ok'))

  assert.equal(handler.hasEmittedToolCall(), true)
  assert.match(output, /"name":"exec_command"/)
  assert.doesNotMatch(output, /bash>command>/)
})

test('Mimo keeps a valid managed tool call while removing a reasoning wrapper', async () => {
  const handler = new MimoStreamHandler('MiMo-V2.6-Pro-Ultraspeed', 'conversation', 'separate', makePlan(), {
    deferOutput: true,
    tolerateProtocolError: true,
  })
  const output = await collect(handler, sseStream(`<think>${TOOL_RESULT_WRAPPER}</think>${TOOL_CALL}`))

  assert.equal(handler.hasEmittedToolCall(), true)
  assert.doesNotMatch(output, /CHAT2API\|tool_result/)
  assert.doesNotMatch(output, /INTERNAL_RESULT/)
  assert.match(output, /tool_calls/)
})

test('Mimo non-stream output also strips managed wrappers before conversion', async () => {
  const handler = new MimoStreamHandler('MiMo-V2.6-Pro-Ultraspeed', 'conversation', 'separate', makePlan())
  const result = JSON.parse(await handler.handleNonStream(sseStream(`<think>${TOOL_RESULT_WRAPPER}</think>answer`)))

  assert.doesNotMatch(JSON.stringify(result), /CHAT2API\|tool_result/)
  assert.doesNotMatch(JSON.stringify(result), /INTERNAL_RESULT/)
  assert.match(result.choices[0].message.content, /answer/)
})
