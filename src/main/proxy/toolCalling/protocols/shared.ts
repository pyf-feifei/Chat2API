import type { NormalizedToolDefinition, NormalizedToolResult, ToolParseResult, ToolProtocolId } from '../types.ts'
import type { ToolProtocolDetection } from './base.ts'
import type { ToolCall } from '../../types.ts'

export function detectMarkers(buffer: string, markers: string[]): ToolProtocolDetection {
  let earliest = -1
  for (const marker of markers) {
    const index = buffer.indexOf(marker)
    if (index !== -1 && (earliest === -1 || index < earliest)) {
      earliest = index
    }
  }

  if (earliest !== -1) {
    return { matched: true, partial: false, markerStart: earliest }
  }

  let partialStart = -1
  for (const marker of markers) {
    const maxPrefixLength = Math.min(buffer.length, marker.length - 1)
    for (let length = maxPrefixLength; length > 0; length -= 1) {
      const index = buffer.length - length
      if (marker.startsWith(buffer.slice(index))) {
        if (partialStart === -1 || index < partialStart) {
          partialStart = index
        }
        break
      }
    }
  }

  return partialStart === -1
    ? { matched: false, partial: false }
    : { matched: false, partial: true, markerStart: partialStart }
}

export function stripFencedCodeBlocks(content: string): string {
  return content.replace(/```[\s\S]*?```/g, '')
}

export function toolNames(tools: NormalizedToolDefinition[]): Set<string> {
  return new Set(tools.map((tool) => tool.name))
}

export function createParseResult(input: {
  content: string
  toolCalls: ToolCall[]
  protocol: ToolProtocolId | 'unknown'
  rawMatches: string[]
  invalidToolNames?: string[]
  malformedReason?: string
}): ToolParseResult {
  return {
    content: input.content,
    toolCalls: input.toolCalls,
    protocol: input.protocol,
    rawMatches: input.rawMatches,
    malformedReason: input.malformedReason,
    invalidToolNames: input.invalidToolNames ?? [],
  }
}

export function buildToolCall(
  id: string,
  index: number,
  name: string,
  args: unknown,
  rawText?: string,
  tool?: NormalizedToolDefinition,
): ToolCall {
  return {
    id,
    index,
    type: 'function',
    function: {
      name,
      arguments: normalizeArguments(args, tool),
    },
    ...(rawText ? { rawText } : {}),
  } as ToolCall
}

export function normalizeArguments(args: unknown, tool?: NormalizedToolDefinition): string {
  if (typeof args === 'string') {
    const trimmed = args.trim()
    if (!trimmed) return '{}'
    try {
      return JSON.stringify(normalizeArgumentsForSchema(JSON.parse(trimmed), tool))
    } catch {
      const recovered = recoverJsonValueFromMalformedSnapshots(trimmed)
      if (recovered !== undefined) {
        return JSON.stringify(normalizeArgumentsForSchema(recovered, tool))
      }
      return trimmed
    }
  }

  return JSON.stringify(normalizeArgumentsForSchema(args ?? {}, tool))
}

export function getMissingRequiredArguments(args: unknown, tool?: NormalizedToolDefinition): string[] {
  if (!tool) return []

  const parsed = parseArgumentCandidate(args)
  if (!parsed.ok) return []

  const normalized = normalizeArgumentsForSchema(parsed.value ?? {}, tool)
  return collectMissingRequiredFields(normalized, tool.parameters)
}

export function parseJsonValue(value: string): unknown {
  const trimmed = unwrapCdata(value).trim()
  if (!trimmed) return ''

  try {
    return JSON.parse(trimmed)
  } catch {
    const recovered = recoverJsonValueFromMalformedSnapshots(trimmed)
    if (recovered !== undefined) {
      return recovered
    }
    return decodeXml(trimmed)
  }
}

function recoverJsonValueFromMalformedSnapshots(value: string): unknown | undefined {
  const trimmed = decodeXml(unwrapCdata(value)).trim()
  if (!trimmed || !/^[\[{]/.test(trimmed)) return undefined

  const candidates: Array<{ index: number; value: unknown }> = []
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]
    if (char !== '{' && char !== '[') continue

    const jsonText = extractBalancedJson(trimmed, index)
    if (!jsonText) continue

    try {
      candidates.push({ index, value: JSON.parse(jsonText) })
    } catch {
      // Keep scanning later positions; repeated snapshots may become valid there.
    }
  }

  if (candidates.length === 0) return undefined

  const candidate = candidates[candidates.length - 1]
  if (candidate.index === 0) return undefined

  if (hasRepeatedSnapshotPrefix(trimmed.slice(0, candidate.index), candidate.value)) {
    return candidate.value
  }

  return undefined
}

function extractBalancedJson(value: string, start: number): string | undefined {
  const opener = value[start]
  const closer = opener === '{' ? '}' : ']'
  const stack: string[] = [closer]
  let inString = false
  let escaped = false

  for (let index = start + 1; index < value.length; index += 1) {
    const char = value[index]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '{') {
      stack.push('}')
      continue
    }

    if (char === '[') {
      stack.push(']')
      continue
    }

    if (char === '}' || char === ']') {
      if (stack.pop() !== char) {
        return undefined
      }

      if (stack.length === 0) {
        return value.slice(start, index + 1)
      }
    }
  }

  return undefined
}

function hasRepeatedSnapshotPrefix(prefix: string, value: unknown): boolean {
  if (Array.isArray(value)) {
    return prefix.trimStart().startsWith('[')
  }

  if (!value || typeof value !== 'object') {
    return false
  }

  const keys = Object.keys(value as Record<string, unknown>)
  return keys.some((key) => prefix.includes(JSON.stringify(key)))
}

export function unwrapCdata(value: string): string {
  const cdata = value.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/)
  return cdata ? cdata[1] : value
}

export function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function addParameter(target: Record<string, unknown>, name: string, value: unknown): void {
  const existing = target[name]
  if (existing === undefined) {
    target[name] = value
  } else if (Array.isArray(existing)) {
    target[name] = [...existing, value]
  } else {
    target[name] = [existing, value]
  }
}

export function normalizeArgumentsForSchema(
  value: unknown,
  tool?: NormalizedToolDefinition,
): unknown {
  return normalizeValueForSchema(value, tool?.parameters)
}

function normalizeValueForSchema(value: unknown, schema: unknown): unknown {
  const variants = schemaVariants(schema)
  const arraySchema = variants.find(schemaExpectsArray)
  if (arraySchema) {
    const itemSchema = getSchemaProperty(arraySchema, 'items')
    if (Array.isArray(value)) {
      return value.map((item) => normalizeValueForSchema(item, itemSchema))
    }

    if (isPlainObject(value)) {
      return [normalizeValueForSchema(value, itemSchema)]
    }

    return value
  }

  const objectSchema = variants.find(schemaExpectsObject)
  if (objectSchema && isPlainObject(value)) {
    const properties = getObjectSchemaProperties(objectSchema)
    if (!properties) return normalizeObjectProperties(value, undefined)

    return normalizeObjectProperties(value, properties)
  }

  const scalar = normalizeScalarForSchema(value, variants)
  if (scalar !== value) return scalar

  if (Array.isArray(value)) {
    return value.map((item) => normalizeValueForSchema(item, undefined))
  }

  if (isPlainObject(value)) {
    return normalizeObjectProperties(value, undefined)
  }

  return value
}

function normalizeScalarForSchema(value: unknown, variants: unknown[]): unknown {
  if (value === null || typeof value === 'object') return value

  // Preserve a value when it already matches one of the declared scalar types.
  // This matters for unions such as `string | number`.
  if (variants.some((variant) => schemaAcceptsScalar(variant, value))) return value

  if (variants.some((variant) => schemaTypeIncludes(variant, 'string'))) {
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
      const numericValue = Number(trimmed)
      if (Number.isFinite(numericValue) && variants.some((variant) => {
        if (schemaTypeIncludes(variant, 'integer')) return Number.isInteger(numericValue)
        return schemaTypeIncludes(variant, 'number')
      })) {
        return numericValue
      }
    }

    if (trimmed === 'true' || trimmed === 'false') {
      const booleanValue = trimmed === 'true'
      if (variants.some((variant) => schemaTypeIncludes(variant, 'boolean'))) return booleanValue
    }
  }

  return value
}

function schemaAcceptsScalar(schema: unknown, value: unknown): boolean {
  if (typeof value === 'string') return schemaTypeIncludes(schema, 'string')
  if (typeof value === 'number') {
    return schemaTypeIncludes(schema, 'number') ||
      (schemaTypeIncludes(schema, 'integer') && Number.isInteger(value))
  }
  if (typeof value === 'boolean') return schemaTypeIncludes(schema, 'boolean')
  return false
}

function normalizeObjectProperties(
  value: Record<string, unknown>,
  properties: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      normalizeValueForSchema(item, properties?.[key]),
    ]),
  )
}

function schemaVariants(schema: unknown): unknown[] {
  if (!isPlainObject(schema)) return []

  const variants: unknown[] = [schema]
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const nested = schema[key]
    if (Array.isArray(nested)) {
      variants.push(...nested.flatMap(schemaVariants))
    }
  }

  return variants
}

function schemaExpectsArray(schema: unknown): boolean {
  return schemaTypeIncludes(schema, 'array') || Boolean(getSchemaProperty(schema, 'items'))
}

function schemaExpectsObject(schema: unknown): boolean {
  return schemaTypeIncludes(schema, 'object') || Boolean(getObjectSchemaProperties(schema))
}

function schemaTypeIncludes(schema: unknown, type: string): boolean {
  const schemaType = getSchemaProperty(schema, 'type')
  return schemaType === type || (Array.isArray(schemaType) && schemaType.includes(type))
}

function getObjectSchemaProperties(schema: unknown): Record<string, unknown> | undefined {
  const properties = getSchemaProperty(schema, 'properties')
  return isPlainObject(properties) ? properties : undefined
}

function getSchemaProperty(schema: unknown, key: string): unknown {
  return isPlainObject(schema) ? schema[key] : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function renderToolList(tools: NormalizedToolDefinition[]): string {
  return tools
    .map((tool) => {
      const parameters = JSON.stringify(tool.parameters ?? {})
      const requiredFields = getRequiredFields(tool.parameters)
      const requiredText = requiredFields.length > 0
        ? ` Required fields that must be provided in the same call: ${requiredFields.map((field) => `\`${field}\``).join(', ')}.`
        : ''
      return `Tool \`${tool.name}\`: ${tool.description || 'No description'}. Arguments JSON schema: ${parameters}.${requiredText}`
    })
    .join('\n')
}

function parseArgumentCandidate(args: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof args !== 'string') {
    return { ok: true, value: args }
  }

  const trimmed = args.trim()
  if (!trimmed) return { ok: true, value: {} }

  try {
    return { ok: true, value: JSON.parse(trimmed) }
  } catch {
    const recovered = recoverJsonValueFromMalformedSnapshots(trimmed)
    return recovered === undefined ? { ok: false } : { ok: true, value: recovered }
  }
}

function collectMissingRequiredFields(value: unknown, schema: unknown, path: string = ''): string[] {
  if (!isPlainObject(schema)) return []

  const oneOf = getSchemaArray(schema, 'oneOf')
  const anyOf = getSchemaArray(schema, 'anyOf')
  if (oneOf.length > 0 || anyOf.length > 0) {
    const variants = [...oneOf, ...anyOf]
    return shortestMissingSet(variants.map((variant) => collectMissingRequiredFields(value, variant, path)))
  }

  const allOf = getSchemaArray(schema, 'allOf')
  const allOfMissing = allOf.flatMap((variant) => collectMissingRequiredFields(value, variant, path))

  if (schemaExpectsArray(schema)) {
    const itemSchema = getSchemaProperty(schema, 'items')
    if (!Array.isArray(value)) return uniqueStrings(allOfMissing)
    return uniqueStrings([
      ...allOfMissing,
      ...value.flatMap((item, index) => collectMissingRequiredFields(item, itemSchema, `${path}[${index}]`)),
    ])
  }

  const properties = getObjectSchemaProperties(schema)
  const required = getRequiredFields(schema)
  if (!schemaExpectsObject(schema) && required.length === 0 && !properties) {
    return uniqueStrings(allOfMissing)
  }

  if (!isPlainObject(value)) {
    return uniqueStrings([...allOfMissing, ...required.map((field) => joinRequiredPath(path, field))])
  }

  const ownMissing = required
    .filter((field) => !Object.prototype.hasOwnProperty.call(value, field))
    .map((field) => joinRequiredPath(path, field))

  const nestedMissing = properties
    ? Object.entries(properties).flatMap(([field, propertySchema]) => {
      if (!Object.prototype.hasOwnProperty.call(value, field)) return []
      return collectMissingRequiredFields(value[field], propertySchema, joinRequiredPath(path, field))
    })
    : []

  return uniqueStrings([...allOfMissing, ...ownMissing, ...nestedMissing])
}

function getSchemaArray(schema: Record<string, unknown>, key: string): unknown[] {
  const value = schema[key]
  return Array.isArray(value) ? value : []
}

function shortestMissingSet(sets: string[][]): string[] {
  if (sets.length === 0) return []
  return sets.reduce((best, candidate) => candidate.length < best.length ? candidate : best)
}

function getRequiredFields(schema: unknown): string[] {
  const required = getSchemaProperty(schema, 'required')
  return Array.isArray(required) ? required.filter((field): field is string => typeof field === 'string') : []
}

function joinRequiredPath(path: string, field: string): string {
  return path ? `${path}.${field}` : field
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

export function genericToolResultBlock(result: NormalizedToolResult): string {
  return `[TOOL_RESULT for ${result.toolCallId}] ${result.content}`
}
