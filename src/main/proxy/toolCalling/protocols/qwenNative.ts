import type { ToolProtocolAdapter } from './base.ts'
import type {
  NormalizedToolDefinition,
  NormalizedToolResult,
  ToolParseContext,
  ToolParseResult,
} from '../types.ts'
import {
  buildToolCall,
  createParseResult,
  decodeXml,
  detectMarkers,
  escapeXmlAttribute,
  findToolCallerStart,
  hasToolArgumentValidationIssues,
  parseJsonValue,
  parseToolCallerBlock,
  stripFencedCodeBlocks,
  TOOL_CALLER_START,
  toolNames,
} from './shared.ts'
import {
  renderQwenNativeFunctionCallsPrompt,
  renderQwenNativeContinuationReminder,
  renderQwenNativeRecoveryPrompt,
} from './qwenNativePrompt.ts'

const QWEN_NATIVE_PROTOCOL_ID = 'qwen_native' as const

const FUNCTION_CALLS_START = '<function_calls>'
const FUNCTION_CALLS_END = '</function_calls>'
const INVOKE_OPEN_TAG = '<invoke '
const INVOKE_END = '</invoke>'
// The full attribute prefix keeps the name extraction between the quotes;
// matching only '<parameter' would capture ' name=' as the parameter name.
const PARAMETER_OPEN_TAG = '<parameter name="'
const PARAMETER_CLOSE_TAG = '</parameter>'
const TOOL_RESPONSE_START = '<tool_response>'
const TOOL_RESPONSE_END = '</tool_response>'

export const qwenNativeProtocol: ToolProtocolAdapter = {
  id: QWEN_NATIVE_PROTOCOL_ID,

  renderPrompt(tools) {
    return renderQwenNativeFunctionCallsPrompt(tools)
  },

  renderRecoveryPrompt(tools) {
    return renderQwenNativeRecoveryPrompt(tools)
  },

  renderContinuationReminder(tools) {
    return renderQwenNativeContinuationReminder(tools)
  },

  detectStart(buffer) {
    // tool_caller is a platform dialect the model drifts to from training
    // memory; without it in the marker list the stream parser would flush the
    // block as plain content instead of buffering it as a tool protocol.
    return detectMarkers(buffer, [FUNCTION_CALLS_START, TOOL_CALLER_START])
  },

  parse(content: string, context: ToolParseContext): ToolParseResult {
    const parsable = stripFencedCodeBlocks(content)
    const allowedNames = toolNames(context.tools)
    const toolDefinitions = new Map(context.tools.map((tool) => [tool.name, tool]))
    const rawMatches: string[] = []
    const invalidToolNames: string[] = []
    const toolCalls: ReturnType<typeof buildToolCall>[] = []
    let malformedReason: string | undefined
    let searchIndex = 0

    while (searchIndex < parsable.length) {
      // Both the taught <function_calls> format and the platform tool_caller
      // dialect the model drifts to from training memory start a block; the
      // earliest one in the remaining text wins.
      const functionCallsStart = parsable.indexOf(FUNCTION_CALLS_START, searchIndex)
      const toolCallerStart = findToolCallerStart(parsable, searchIndex)
      const candidates = [
        { index: functionCallsStart, isToolCaller: false },
        { index: toolCallerStart, isToolCaller: true },
      ].filter(candidate => candidate.index !== -1)
      if (candidates.length === 0) break
      candidates.sort((left, right) => left.index - right.index)
      const callStart = candidates[0].index

      const parsed = candidates[0].isToolCaller
        ? parseToolCallerBlock(parsable, callStart)
        : parseFunctionCallsBlock(parsable, callStart, toolDefinitions)
      if (!parsed) {
        if (context.allowPartial) {
          rawMatches.push(parsable.slice(callStart))
          malformedReason ??= candidates[0].isToolCaller
            ? 'qwen_native_tool_caller_incomplete'
            : 'qwen_native_function_calls_incomplete'
        }
        break
      }

      rawMatches.push(parsed.rawText)
      searchIndex = parsed.end

      if (parsed.malformedReason) {
        malformedReason ??= parsed.malformedReason
        continue
      }

      const envelopes = parsed.envelopes
      if (envelopes.length === 0) {
        malformedReason ??= 'qwen_native_invalid_invoke'
        continue
      }

      for (const envelope of envelopes) {
        if (!allowedNames.has(envelope.name)) {
          invalidToolNames.push(envelope.name)
          continue
        }

        const tool = toolDefinitions.get(envelope.name)
        if (hasToolArgumentValidationIssues(envelope.arguments, tool)) {
          malformedReason ??= 'qwen_native_schema_validation_failed'
          continue
        }

        toolCalls.push(
          buildToolCall(
            `call_${toolCalls.length}`,
            toolCalls.length,
            envelope.name,
            envelope.arguments,
            parsed.rawText,
            tool,
          ),
        )
      }
    }

    if (rawMatches.length === 0) {
      return createParseResult({
        content,
        toolCalls,
        protocol: 'unknown',
        rawMatches,
        invalidToolNames,
        malformedReason,
      })
    }

    const cleanContent = rawMatches
      .reduce((current, raw) => current.replace(raw, ''), parsable)
      .trim()
    const atomicToolCalls = malformedReason || invalidToolNames.length > 0
      ? []
      : toolCalls

    return createParseResult({
      content: cleanContent,
      toolCalls: atomicToolCalls,
      protocol: QWEN_NATIVE_PROTOCOL_ID,
      rawMatches,
      invalidToolNames,
      malformedReason,
    })
  },

  formatAssistantToolCalls(calls) {
    return calls
      .map((call) => formatNativeInvoke(call.name, parseHistoryArgs(call.arguments)))
      .join('\n')
  },

  formatToolResult(result) {
    return formatNativeToolResponse(result)
  },
}

function parseFunctionCallsBlock(
  content: string,
  blockStart: number,
  toolDefinitions: Map<string, NormalizedToolDefinition>,
): { end: number; rawText: string; envelopes: Array<{ name: string; arguments: Record<string, unknown> }>; malformedReason?: string } | undefined {
  const innerStart = blockStart + FUNCTION_CALLS_START.length
  const endTag = content.indexOf(FUNCTION_CALLS_END, innerStart)
  if (endTag === -1) return undefined

  const blockBody = content.slice(innerStart, endTag)
  const end = endTag + FUNCTION_CALLS_END.length
  const envelopes: Array<{ name: string; arguments: Record<string, unknown> }> = []
  let invokeSearchIndex = 0

  while (invokeSearchIndex < blockBody.length) {
    const invokeIdx = blockBody.indexOf(INVOKE_OPEN_TAG, invokeSearchIndex)
    if (invokeIdx === -1) break

    const nameQuote1 = blockBody.indexOf('"', invokeIdx + INVOKE_OPEN_TAG.length)
    if (nameQuote1 === -1) break
    const nameQuote2 = blockBody.indexOf('"', nameQuote1 + 1)
    if (nameQuote2 === -1) break
    const name = decodeXml(blockBody.slice(nameQuote1 + 1, nameQuote2))

    const invokeBodyStart = blockBody.indexOf('>', nameQuote2 + 1)
    if (invokeBodyStart === -1) break

    const invokeEndIdx = blockBody.indexOf(INVOKE_END, invokeBodyStart + 1)
    if (invokeEndIdx === -1) break

    const invokeBody = blockBody.slice(invokeBodyStart + 1, invokeEndIdx)
    const args: Record<string, unknown> = {}
    let paramSearchIdx = 0

    while (paramSearchIdx < invokeBody.length) {
      const paramOpenMatch = invokeBody.indexOf(PARAMETER_OPEN_TAG, paramSearchIdx)
      if (paramOpenMatch === -1) break

      const paramNameEndQuote = invokeBody.indexOf('"', paramOpenMatch + PARAMETER_OPEN_TAG.length)
      if (paramNameEndQuote === -1) break
      const paramName = decodeXml(invokeBody.slice(paramOpenMatch + PARAMETER_OPEN_TAG.length, paramNameEndQuote))

      const paramValueStart = invokeBody.indexOf('>', paramNameEndQuote + 1)
      if (paramValueStart === -1) break

      // Corrupted close tags (`</parameter name>`, `</parameter|`) end the
      // value at the next tag-looking '<' instead of leaking into the value.
      const paramValueEnd = findNativeParameterClose(invokeBody, paramValueStart + 1)
      let paramValue: string
      if (paramValueEnd !== -1) {
        paramValue = invokeBody.slice(paramValueStart + 1, paramValueEnd).trim()
        paramSearchIdx = paramValueEnd
      } else {
        paramValue = invokeBody.slice(paramValueStart + 1).trim()
        paramSearchIdx = invokeBody.length
      }

      // Schema-aware decode keeps string-typed values verbatim (a value like
      // 007 or {"a":1} stays a string) exactly like the Hermes parser.
      const parameterSchema = nativeParameterSchema(toolDefinitions.get(name), paramName)
      args[paramName] = schemaAcceptsNativeRawString(parameterSchema)
        ? decodeXml(paramValue)
        : parseJsonValue(paramValue)
    }

    envelopes.push({ name, arguments: args })
    invokeSearchIndex = invokeEndIdx + INVOKE_END.length
  }

  return {
    end,
    rawText: content.slice(blockStart, end),
    envelopes,
  }
}

function parseHistoryArgs(argumentsJson: string): unknown {
  const trimmed = argumentsJson.trim()
  if (!trimmed) return {}
  try {
    return JSON.parse(trimmed)
  } catch {
    return argumentsJson
  }
}

/**
 * Find the closing boundary of a parameter value. Observed upstream drift
 * closes with corrupted tags (`</parameter name>`, `</parameter|`) — an
 * enumerated whitelist cannot keep up. Structural rule instead: a parameter
 * value never contains a raw '<' (payloads are XML-escaped), so the value
 * ends at the next '<' that starts any tag-looking run. Falls back to the
 * canonical close position for values that legitimately contain '<' as
 * escaped text followed by more value.
 */
function findNativeParameterClose(body: string, fromIndex: number): number {
  const exact = body.indexOf(PARAMETER_CLOSE_TAG, fromIndex)
  const nextTag = body.indexOf('<', fromIndex)
  if (nextTag === -1) return exact
  // A next '<' that is not part of the canonical close ends the value there.
  if (exact === -1 || nextTag < exact) return nextTag
  return exact
}

function nativeParameterSchema(
  tool: NormalizedToolDefinition | undefined,
  parameterName: string,
): unknown {
  if (!isObjectRecord(tool?.parameters)) return undefined
  const properties = tool.parameters.properties
  return isObjectRecord(properties) ? properties[parameterName] : undefined
}

function schemaAcceptsNativeRawString(schema: unknown): boolean {
  if (!isObjectRecord(schema)) return false
  if (schema.type === 'string') return true
  if (Array.isArray(schema.type) && schema.type.includes('string')) return true
  if (typeof schema.const === 'string') return true
  if (Array.isArray(schema.enum) && schema.enum.some(value => typeof value === 'string')) return true
  return ['anyOf', 'oneOf'].some((key) => (
    Array.isArray(schema[key]) && schema[key].some(schemaAcceptsNativeRawString)
  ))
}

function formatNativeInvoke(name: string, args: unknown): string {
  const parameters = isObjectRecord(args)
    ? Object.entries(args).map(([parameterName, value]) => [
        `<parameter name="${escapeXmlAttribute(parameterName)}">`,
        serializeNativeParameterValue(value),
        PARAMETER_CLOSE_TAG,
      ].join('\n'))
    : []

  return [
    FUNCTION_CALLS_START,
    `<invoke name="${escapeXmlAttribute(name)}">`,
    ...parameters,
    INVOKE_END,
    FUNCTION_CALLS_END,
  ].join('\n')
}

function serializeNativeParameterValue(value: unknown): string {
  if (value !== null && typeof value === 'object') {
    return JSON.stringify(value)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
  }
  return escapeXmlAttribute(String(value))
}

function formatNativeToolResponse(result: NormalizedToolResult): string {
  const statusLine = result.isError ? 'status: error\n' : ''
  return `${TOOL_RESPONSE_START}\n${statusLine}${escapeNativeTextBoundaries(result.content)}\n${TOOL_RESPONSE_END}`
}

function escapeNativeTextBoundaries(content: string): string {
  return content.replace(/<\/?(?:tools|tool_call|tool_calls|tool_caller|tool_name|tool_response|function_calls|invoke|parameter)>/gi, boundary => (
    boundary.replace('<', '&lt;').replace('>', '&gt;')
  ))
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
