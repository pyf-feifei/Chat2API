import test from 'node:test'
import assert from 'node:assert/strict'

import { buildToolCallingRuntimePlan } from '../../src/main/proxy/toolCalling/runtimePlan.ts'
import {
  aliasManagedToolDefinitions,
  buildQwenAiToolNameAliasTable,
  clientToolNameFromAlias,
  hasQwenAiToolNameAliases,
} from '../../src/main/proxy/toolCalling/qwenAiToolNameAlias.ts'
import { getToolProtocol } from '../../src/main/proxy/toolCalling/protocols/index.ts'
import type { NormalizedToolDefinition } from '../../src/main/proxy/toolCalling/types.ts'

function tool(name: string): NormalizedToolDefinition {
  return {
    name,
    description: `Runs a command`,
    parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
    source: 'openai',
  }
}

function qwenAiPlan(toolNames: string[]) {
  return buildToolCallingRuntimePlan({
    requestId: 'alias-test',
    providerId: 'qwen-ai',
    actualModel: 'qwen3.8-max',
    model: 'qwen3.8-max',
    config: {
      enabled: true,
      mode: 'auto',
      clientAdapterId: 'standard-openai-tools',
      diagnosticsEnabled: false,
      advanced: { promptPreviewEnabled: false },
    },
    clientRequest: {
      clientAdapterId: 'standard-openai-tools',
      toolSource: 'openai',
      tools: toolNames.map(tool),
      toolChoice: { mode: 'auto' },
      diagnostics: { rawToolCount: toolNames.length, normalizedToolNames: toolNames },
    },
  })
}

test('colliding client tool names are aliased on the upstream wire only', () => {
  const table = buildQwenAiToolNameAliasTable(['exec_command', 'view_image'])
  assert.equal(hasQwenAiToolNameAliases(table), true)
  assert.equal(table.toUpstream.get('exec_command'), 'ch2_invoke_7a3f')
  assert.equal(table.toUpstream.has('view_image'), false)
  assert.equal(clientToolNameFromAlias('ch2_invoke_7a3f', table), 'exec_command')
  // A name with no alias passes through untouched.
  assert.equal(clientToolNameFromAlias('view_image', table), 'view_image')
})

test('platform-owned tool names are never aliased', () => {
  const table = buildQwenAiToolNameAliasTable(['web_search', 'code_interpreter'])
  assert.equal(hasQwenAiToolNameAliases(table), false)
})

test('an alias that collides with a declared tool is skipped', () => {
  // Both the colliding name and its target are declared: renaming would make
  // the two indistinguishable on the way back, so no alias may be applied.
  const table = buildQwenAiToolNameAliasTable(['exec_command', 'ch2_invoke_7a3f'])
  assert.equal(hasQwenAiToolNameAliases(table), false)
})

test('the plan keeps client names so parsed calls match the allowlist and the client', () => {
  const plan = qwenAiPlan(['exec_command'])

  assert.equal(plan.protocol, 'qwen_hermes')
  assert.deepEqual([...plan.allowedToolNames], ['exec_command'])
  assert.deepEqual(plan.tools.map(t => t.name), ['exec_command'])
  assert.ok(plan.toolNameAliases)

  // A call parsed under the client name is in the allowlist...
  assert.equal(plan.allowedToolNames.has('exec_command'), true)
  // ...and the alias name is not, so a leaked alias can never reach the client.
  assert.equal(plan.allowedToolNames.has('ch2_invoke_7a3f'), false)
})

test('the parser accepts the alias and emits the client name', () => {
  const plan = qwenAiPlan(['exec_command'])
  const protocol = getToolProtocol(plan.protocol)
  const parseContext = {
    tools: plan.tools,
    protocol: plan.protocol,
    allowPartial: true,
    toolNameAliases: plan.toolNameAliases,
  }
  const block = (name: string) =>
    `<tool_call>\n<function=${name}>\n<parameter=cmd>\npwd\n</parameter>\n</function>\n</tool_call>`

  // The prompt teaches the alias, so a call carrying it must resolve to the
  // client's declared name rather than being rejected as undeclared.
  const viaAlias = protocol.parse(block('ch2_invoke_7a3f'), parseContext)
  assert.deepEqual(viaAlias.invalidToolNames, [])
  assert.deepEqual(viaAlias.toolCalls.map(c => c.function.name), ['exec_command'])

  // A model that drifts back to the real name still works.
  const viaClientName = protocol.parse(block('exec_command'), parseContext)
  assert.deepEqual(viaClientName.invalidToolNames, [])
  assert.deepEqual(viaClientName.toolCalls.map(c => c.function.name), ['exec_command'])
})

test('without the alias table the taught alias is not silently accepted', () => {
  const plan = qwenAiPlan(['exec_command'])
  const protocol = getToolProtocol(plan.protocol)
  const parsed = protocol.parse(
    '<tool_call>\n<function=ch2_invoke_7a3f>\n<parameter=cmd>\npwd\n</parameter>\n</function>\n</tool_call>',
    { tools: plan.tools, protocol: plan.protocol, allowPartial: true },
  )
  assert.deepEqual(parsed.toolCalls, [])
  assert.deepEqual(parsed.invalidToolNames, ['ch2_invoke_7a3f'])
})

test('the aliased name is exactly what the upstream prompt teaches', () => {
  const plan = qwenAiPlan(['exec_command'])
  const promptTools = aliasManagedToolDefinitions(plan.tools, plan.toolNameAliases)
  const prompt = getToolProtocol(plan.protocol).renderPrompt(promptTools)

  // The model must be taught the neutral alias and see no trace of the
  // colliding client name anywhere in the tool contract.
  assert.match(prompt, /"name":"ch2_invoke_7a3f"/)
  assert.doesNotMatch(prompt, /exec_command/)
})

test('a non-colliding tool name is unchanged in the upstream prompt', () => {
  const plan = qwenAiPlan(['view_image', 'apply_patch'])
  const promptTools = aliasManagedToolDefinitions(plan.tools, plan.toolNameAliases)
  const prompt = getToolProtocol(plan.protocol).renderPrompt(promptTools)

  assert.match(prompt, /view_image/)
  assert.match(prompt, /apply_patch/)
})

test('the demonstrated call example names a real aliased tool, never a placeholder', () => {
  const plan = qwenAiPlan(['exec_command', 'write_stdin'])
  const promptTools = aliasManagedToolDefinitions(plan.tools, plan.toolNameAliases)
  const prompt = getToolProtocol(plan.protocol).renderPrompt(promptTools)

  // A placeholder echoed verbatim under a forced call is rejected upstream as
  // an undeclared native tool call, so the example must be a legal call.
  assert.doesNotMatch(prompt, /example_function_name|example_parameter_name/)
  assert.match(prompt, /<function=ch2_invoke_7a3f>/)
  assert.match(prompt, /<parameter=cmd>/)
})
