import type { ToolProtocolAdapter } from './base.ts'
import type { NormalizedToolDefinition, ToolParseContext } from '../types.ts'
import {
  addParameter,
  buildToolCall,
  createParseResult,
  detectMarkers,
  escapeXmlAttribute,
  parseJsonValue,
  renderToolList,
  stripFencedCodeBlocks,
  toolNames,
} from './shared.ts'

const CHAT2API_START = '<|CHAT2API|tool_calls>'
const CHAT2API_END = '</|CHAT2API|tool_calls>'
const XML_START = '<tool_calls>'
const XML_END = '</tool_calls>'
const LOOSE_XML_START = '<|tool_calls>'
const LOOSE_XML_END = '</|tool_calls>'

interface XmlSyntax {
  startMarkers: string[]
  endMarkers: string[]
  blockPattern: RegExp
  invokePattern: RegExp
  parameterOpenPattern: RegExp
  invokeCloseTags: string[]
  parameterCloseTags: string[]
}

const MANAGED_XML_SYNTAX: XmlSyntax = {
  startMarkers: [CHAT2API_START, XML_START, LOOSE_XML_START],
  endMarkers: [CHAT2API_END, XML_END, LOOSE_XML_END],
  blockPattern: /(?:<\|CHAT2API\|tool_calls>|<tool_calls>|<\|tool_calls>)([\s\S]*?)(?:<\/\|CHAT2API\|tool_calls>|<\/tool_calls>|<\/\|tool_calls>)/g,
  invokePattern: /(?:<\|CHAT2API\|invoke\s+name=(["'])(.*?)\1\s*>|<invoke\s+name=(["'])(.*?)\3\s*>|<\|?tool_call\s+name=(["'])(.*?)\5\s*>|<\|?tool_call_id=(["'])(.*?)\7\s*>)/g,
  parameterOpenPattern: /(?:<\|CHAT2API\|parameter\s+name=(["'])(.*?)\1\s*>|<parameter\s+name=(["'])(.*?)\3\s*>|<\|parameter\s+name=(["'])(.*?)\5\s*>)/g,
  invokeCloseTags: ['</|CHAT2API|invoke>', '</invoke>', '</tool_call>', '</|tool_call>'],
  parameterCloseTags: ['</|CHAT2API|parameter>', '</parameter>', '</|parameter>'],
}

export const managedXmlProtocol: ToolProtocolAdapter = {
  id: 'managed_xml',

  renderPrompt(tools) {
    return `## Available Tools
You can invoke the following developer tools. Tool names are case-sensitive.
Use only the exact tool names listed below. Do not rename, camelCase, translate, shorten, or invent tool names.

${renderToolList(tools)}

When calling tools, respond with only this Chat2API XML block:

<|CHAT2API|tool_calls><|CHAT2API|invoke name="exact_tool_name"><|CHAT2API|parameter name="parameter_name"><![CDATA[value]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>

Use exactly the tag names shown in the tool-call block above. Do not use alternative tag names when requesting tools.

Tool results will be provided as Chat2API XML result blocks:

<|CHAT2API|tool_result tool_call_id="call_id"><![CDATA[result]]></|CHAT2API|tool_result>`
  },

  detectStart(buffer) {
    return detectMarkers(buffer, [CHAT2API_START, XML_START])
  },

  parse(content: string, context: ToolParseContext) {
    const parseable = stripFencedCodeBlocks(content)
    const allowedNames = toolNames(context.tools)
    const rawMatches: string[] = []
    const invalidToolNames: string[] = []
    const toolCalls: ReturnType<typeof buildToolCall>[] = []
    const toolDefinitions = new Map(context.tools.map((tool) => [tool.name, tool]))

    parseBlocks(parseable, {
      syntax: MANAGED_XML_SYNTAX,
      rawMatches,
      invalidToolNames,
      allowedNames,
      toolDefinitions,
      toolCalls,
    })

    if (toolCalls.length === 0 && context.allowPartial) {
      parsePartialBlocks(parseable, {
        syntax: MANAGED_XML_SYNTAX,
        rawMatches,
        invalidToolNames,
        allowedNames,
        toolDefinitions,
        toolCalls,
      })
    }

    if (toolCalls.length === 0) {
      const cleanContent = rawMatches.length > 0
        ? rawMatches.reduce((acc, raw) => acc.replace(raw, ''), parseable).trim()
        : content
      return createParseResult({
        content: cleanContent,
        toolCalls,
        protocol: rawMatches.length > 0 ? 'managed_xml' : 'unknown',
        rawMatches,
        invalidToolNames,
      })
    }

    const cleanContent = rawMatches.reduce((acc, raw) => acc.replace(raw, ''), parseable).trim()
    return createParseResult({
      content: cleanContent,
      toolCalls,
      protocol: 'managed_xml',
      rawMatches,
      invalidToolNames,
    })
  },

  formatAssistantToolCalls(calls) {
    const invokes = calls.map((call) => {
      const args = safeParseObject(call.arguments)
      const params = Object.entries(args)
        .map(([name, value]) => {
          const text = typeof value === 'string' ? value : JSON.stringify(value)
          return `<|CHAT2API|parameter name="${escapeXmlAttribute(name)}"><![CDATA[${text}]]></|CHAT2API|parameter>`
        })
        .join('')
      return `<|CHAT2API|invoke name="${escapeXmlAttribute(call.name)}">${params}</|CHAT2API|invoke>`
    })
    return `${CHAT2API_START}${invokes.join('')}${CHAT2API_END}`
  },

  formatToolResult(result) {
    return `<|CHAT2API|tool_result tool_call_id="${escapeXmlAttribute(result.toolCallId)}"><![CDATA[${result.content}]]></|CHAT2API|tool_result>`
  },
}

interface ParseBlockOptions {
  syntax: XmlSyntax
  rawMatches: string[]
  invalidToolNames: string[]
  allowedNames: Set<string>
  toolDefinitions: Map<string, NormalizedToolDefinition>
  toolCalls: ReturnType<typeof buildToolCall>[]
}

function parseBlocks(content: string, options: ParseBlockOptions): void {
  let blockMatch: RegExpExecArray | null
  options.syntax.blockPattern.lastIndex = 0

  while ((blockMatch = options.syntax.blockPattern.exec(content)) !== null) {
    options.rawMatches.push(blockMatch[0])
    parseInvokes(blockMatch[1], {
      ...options,
      allowPartialInvoke: false,
    })
  }
}

function parsePartialBlocks(content: string, options: ParseBlockOptions): void {
  let searchIndex = 0

  while (searchIndex < content.length) {
    const start = findNextMarker(content, options.syntax.startMarkers, searchIndex)
    if (!start) return

    const innerStart = start.index + start.marker.length
    const end = findNextMarker(content, options.syntax.endMarkers, innerStart)
    const rawEnd = end ? end.index + end.marker.length : content.length
    const innerEnd = end ? end.index : content.length
    const rawMatch = content.slice(start.index, rawEnd)
    const blockInner = content.slice(innerStart, innerEnd)

    if (!options.rawMatches.includes(rawMatch)) {
      options.rawMatches.push(rawMatch)
    }

    parseInvokes(blockInner, {
      ...options,
      allowPartialInvoke: true,
    })

    searchIndex = Math.max(rawEnd, start.index + start.marker.length)
  }
}

interface ParseInvokeOptions extends ParseBlockOptions {
  allowPartialInvoke: boolean
}

function parseInvokes(content: string, options: ParseInvokeOptions): void {
  const invokes = collectMatches(options.syntax.invokePattern, content)

  for (let index = 0; index < invokes.length; index += 1) {
    const invokeMatch = invokes[index]
    const name = getCapturedName(invokeMatch)
    if (!options.allowedNames.has(name)) {
      options.invalidToolNames.push(name)
      continue
    }

    const bodyStart = invokeMatch.index + invokeMatch[0].length
    const nextInvokeIndex = invokes[index + 1]?.index ?? content.length
    const close = findNextMarker(content, options.syntax.invokeCloseTags, bodyStart, nextInvokeIndex)
    const bodyEnd = close ? close.index : nextInvokeIndex
    const body = content.slice(bodyStart, bodyEnd)
    const parsedArgs = parseArguments(
      body,
      options.syntax,
      options.allowPartialInvoke,
      options.toolDefinitions.get(name),
    )

    if (!close) {
      if (!options.allowPartialInvoke || !parsedArgs.hadArgumentContent) {
        continue
      }
    }

    const rawEnd = close ? close.index + close.marker.length : bodyEnd
    const rawText = content.slice(invokeMatch.index, rawEnd)
    options.toolCalls.push(
      buildToolCall(`call_${options.toolCalls.length}`, options.toolCalls.length, name, JSON.stringify(parsedArgs.args), rawText),
    )
  }
}

function collectMatches(pattern: RegExp, content: string): RegExpExecArray[] {
  const matches: RegExpExecArray[] = []
  let match: RegExpExecArray | null
  pattern.lastIndex = 0

  while ((match = pattern.exec(content)) !== null) {
    matches.push(match)
  }

  return matches
}

function parseArguments(
  body: string,
  syntax: XmlSyntax,
  allowPartial: boolean,
  tool?: NormalizedToolDefinition,
): { args: Record<string, unknown>; hadArgumentContent: boolean } {
  const args: Record<string, unknown> = {}
  const parameters = collectMatches(syntax.parameterOpenPattern, body)
  let parameterCount = 0

  for (let index = 0; index < parameters.length; index += 1) {
    const parameterMatch = parameters[index]
    const name = getCapturedName(parameterMatch)
    const valueStart = parameterMatch.index + parameterMatch[0].length
    const nextParameterIndex = parameters[index + 1]?.index ?? body.length
    const close = findNextMarker(body, syntax.parameterCloseTags, valueStart, nextParameterIndex)

    if (close) {
      addParsedParameter(args, name, parseJsonValue(body.slice(valueStart, close.index)), tool)
      parameterCount += 1
      continue
    }

    if (allowPartial) {
      const partialValue = extractCompletePartialValue(body.slice(valueStart, nextParameterIndex))
      if (partialValue !== undefined) {
        addParsedParameter(args, name, parseJsonValue(partialValue), tool)
        parameterCount += 1
      }
    }
  }

  if (parameterCount > 0) {
    return { args, hadArgumentContent: true }
  }

  const bodyArgs = parseObjectBodyArgument(body)
  if (bodyArgs) {
    return { args: bodyArgs, hadArgumentContent: true }
  }

  return { args, hadArgumentContent: false }
}

function addParsedParameter(
  args: Record<string, unknown>,
  name: string,
  value: unknown,
  tool?: NormalizedToolDefinition,
): void {
  const unwrappedValue = unwrapRedundantNamedArgument(name, value, tool)
  if (unwrappedValue !== value) {
    addParameter(args, name, unwrappedValue)
    return
  }

  if (shouldFlattenWrapperArgument(name, value, tool)) {
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      addParameter(args, key, nestedValue)
    }
    return
  }

  addParameter(args, name, value)
}

function unwrapRedundantNamedArgument(
  name: string,
  value: unknown,
  tool?: NormalizedToolDefinition,
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value

  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length !== 1 || entries[0][0] !== name) return value

  const properties = getSchemaProperties(tool)
  if (!properties.has(name)) return value

  return entries[0][1]
}

function shouldFlattenWrapperArgument(
  name: string,
  value: unknown,
  tool?: NormalizedToolDefinition,
): boolean {
  if (name !== 'argument' && name !== 'arguments') return false
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false

  const properties = getSchemaProperties(tool)
  if (properties.has(name)) return false
  return true
}

function getSchemaProperties(tool?: NormalizedToolDefinition): Set<string> {
  const parameters = tool?.parameters
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return new Set()

  const properties = (parameters as Record<string, unknown>).properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return new Set()

  return new Set(Object.keys(properties))
}

function findNextMarker(
  content: string,
  markers: string[],
  fromIndex: number,
  beforeIndex: number = content.length,
): { index: number; marker: string } | undefined {
  let selected: { index: number; marker: string } | undefined

  for (const marker of markers) {
    const index = content.indexOf(marker, fromIndex)
    if (index === -1 || index >= beforeIndex) continue
    if (!selected || index < selected.index) {
      selected = { index, marker }
    }
  }

  return selected
}

function getCapturedName(match: RegExpExecArray): string {
  const captures = match.slice(1)
  for (let index = captures.length - 1; index >= 0; index -= 1) {
    const value = captures[index]
    if (typeof value === 'string' && value.trim() && value !== '"' && value !== "'") {
      return value.trim()
    }
  }
  return ''
}

function extractCompletePartialValue(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined

  const cdataEnd = trimmed.indexOf(']]>')
  if (trimmed.startsWith('<![CDATA[') && cdataEnd !== -1) {
    return trimmed.slice(0, cdataEnd + 3)
  }

  if (isCompleteJsonValue(trimmed)) {
    return trimmed
  }

  return undefined
}

function isCompleteJsonValue(value: string): boolean {
  if (!/^[\[{"\-0-9tfn]/.test(value)) return false

  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

function parseObjectBodyArgument(body: string): Record<string, unknown> | undefined {
  const parsed = parseJsonValue(body)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined
}

function safeParseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}
