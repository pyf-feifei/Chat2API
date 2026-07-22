import { randomUUID } from 'node:crypto'
import type { ChatCompletionRequest, ChatMessage } from '../types.ts'
import type { Provider } from '../../store/types.ts'
import {
  DEFAULT_TOOL_CALLING_CONFIG,
  normalizeToolCallingConfig,
  type ToolCallingConfig,
} from '../../../shared/toolCalling.ts'
import { getToolProtocol } from './protocols/index.ts'
import { getToolClientAdapter } from './clientAdapters/index.ts'
import { buildToolCallingRuntimePlan } from './runtimePlan.ts'
import type { NormalizedToolDefinition, ToolCallingPlan, ToolCallingTransformResult, ToolProtocolId } from './types.ts'

export class ToolCallingEngine {
  private readonly config: ToolCallingConfig

  constructor(config: Partial<ToolCallingConfig> = {}) {
    this.config = normalizeToolCallingConfig({
      ...DEFAULT_TOOL_CALLING_CONFIG,
      ...config,
      advanced: {
        ...DEFAULT_TOOL_CALLING_CONFIG.advanced,
        ...config.advanced,
      },
    })
  }

  transformRequest(input: {
    request: ChatCompletionRequest
    provider: Provider
    actualModel: string
    requestId?: string
  }): ToolCallingTransformResult {
    const { request, provider, actualModel, requestId } = input
    const adapter = getToolClientAdapter(this.config.clientAdapterId)
    const clientRequest = adapter.normalizeRequest(request)
    const plan = buildToolCallingRuntimePlan({
      requestId,
      providerId: provider.id,
      actualModel,
      model: request.model,
      config: this.config,
      clientRequest,
    })
    const shouldInjectPrompt = plan.shouldInjectPrompt

    if (!shouldInjectPrompt) {
      return {
        messages: request.messages,
        tools: plan.mode === 'disabled' ? request.tools : undefined,
        plan,
      }
    }

    return {
      messages: injectPrompt(request.messages, renderPrompt(plan, this.config)),
      tools: undefined,
      plan,
    }
  }

  applyNonStreamResponse(result: any, plan: ToolCallingPlan): void {
    if (!plan.shouldParseResponse) return

    const message = result?.choices?.[0]?.message
    if (!message || typeof message.content !== 'string') return

    const parseResult = parseSelectedProtocol(message.content, plan, { allowPartial: true })
    plan.diagnostics.parserFormat = parseResult.protocol
    plan.diagnostics.parsedToolCallCount = parseResult.toolCalls.length
    plan.diagnostics.invalidToolNames = parseResult.invalidToolNames
    plan.diagnostics.malformedReason = parseResult.malformedReason

    if (parseResult.toolCalls.length === 0) {
      if (
        parseResult.rawMatches.length > 0 &&
        (plan.toolChoiceMode === 'forced' || plan.toolChoiceMode === 'required')
      ) {
        throw new Error('Provider returned a malformed or empty tool call block for a required tool call')
      }
      if (parseResult.rawMatches.length > 0) {
        message.content = parseResult.content || null
      }
      return
    }

    const callIdPrefix = `call_${randomUUID().replace(/-/g, '')}`
    message.content = parseResult.content || null
    message.tool_calls = parseResult.toolCalls.map((toolCall, index) => ({
      ...toolCall,
      id: `${callIdPrefix}_${index}`,
    }))

    const choice = result.choices[0]
    choice.finish_reason = 'tool_calls'
  }
}

function renderPrompt(
  plan: ToolCallingPlan,
  config: ToolCallingConfig,
): string {
  const protocolPrompt = getToolProtocol(plan.protocol).renderPrompt(plan.tools)
  const policyPrompt = renderToolChoicePolicyPrompt(plan)
  const prompt = policyPrompt ? `${protocolPrompt}\n\n${policyPrompt}` : protocolPrompt
  const customPromptTemplate = config.diagnosticsEnabled
    ? config.advanced.customPromptTemplate
    : undefined
  if (!customPromptTemplate) return prompt

  return customPromptTemplate
    .replace(/\{\{tools\}\}/g, prompt)
    .replace(/\{\{tool_names\}\}/g, plan.tools.map((tool) => tool.name).join(', '))
    .replace(/\{\{format\}\}/g, plan.protocol)
}

function renderToolChoicePolicyPrompt(plan: ToolCallingPlan): string {
  if (plan.toolChoiceMode === 'required') {
    return [
      'Tool choice policy: a tool call is required for this request.',
      'Respond with one or more tool calls using only the listed tool names and the required protocol block.',
      'Do not answer in natural language instead of calling a tool.',
    ].join('\n')
  }

  if (plan.toolChoiceMode === 'forced' && plan.forcedToolName) {
    return [
      `Tool choice policy: you must call \`${plan.forcedToolName}\` for this request.`,
      'Use only that tool name and the required protocol block.',
      'Do not answer in natural language instead of calling the tool.',
    ].join('\n')
  }

  return ''
}

function injectPrompt(messages: ChatMessage[], prompt: string): ChatMessage[] {
  const [first, ...rest] = messages
  if (first?.role === 'system' && typeof first.content === 'string') {
    return [{ ...first, content: `${first.content}\n\n${prompt}` }, ...rest]
  }

  return [{ role: 'system', content: prompt }, ...messages]
}

function parseSelectedProtocol(
  content: string,
  plan: ToolCallingPlan,
  options: { allowPartial?: boolean } = {},
) {
  const selected = getToolProtocol(plan.protocol)
  return selected.parse(content, {
    tools: plan.tools,
    protocol: plan.protocol,
    allowPartial: options.allowPartial,
  })
}
