import { StringDecoder } from 'node:string_decoder'
import { Transform } from 'node:stream'
import { createParser, type EventSourceMessage } from 'eventsource-parser'
import {
  createManagedToolResultWrapperLeakError,
  ManagedToolResultGuard,
} from './managedToolResultGuard.ts'
import type { ToolProtocolId } from './types.ts'

const ASSISTANT_TEXT_FIELDS = [
  'content',
  'reasoning_content',
  'reasoning',
  'thinking',
  'summary',
] as const

const VISIBLE_ASSISTANT_BLOCK_TYPES = new Set([
  'text',
  'output_text',
  'reasoning',
  'thinking',
  'summary',
])

type AssistantTextField = typeof ASSISTANT_TEXT_FIELDS[number]
type AssistantContainer = 'delta' | 'message'

interface GuardEntry {
  guard: ManagedToolResultGuard
  template: {
    event: EventSourceMessage
    envelope: Record<string, unknown>
    choiceIndex: unknown
    container: AssistantContainer
    field: AssistantTextField
  }
}

/**
 * Validates assistant-visible text in a completed Chat Completions body.
 * Structured tool-call arguments are deliberately not traversed: marker-like
 * strings there are data, not assistant protocol output.
 */
export function guardAssistantOutputCompletion<T extends Record<string, any>>(
  completion: T,
  protectedToolCallProtocol: ToolProtocolId | null = null,
): T {
  const choices = Array.isArray(completion.choices) ? completion.choices : []
  const guardedChoices = choices.map((choice: any, choiceIndex: number) => {
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return choice
    const guardedChoice = { ...choice }
    for (const containerName of ['message', 'delta'] as const) {
      const value = guardedChoice[containerName]
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const container = { ...value }
      for (const field of ASSISTANT_TEXT_FIELDS) {
        if (typeof container[field] === 'string') {
          container[field] = guardAssistantText(
            container[field],
            `choices[${choiceIndex}].${containerName}.${field}`,
            protectedToolCallProtocol,
          )
        } else if (field === 'content' && Array.isArray(container[field])) {
          container[field] = guardAssistantContentParts(
            container[field],
            `choices[${choiceIndex}].${containerName}.content`,
            protectedToolCallProtocol,
          )
        }
      }
      guardedChoice[containerName] = container
    }
    return guardedChoice
  })
  return { ...completion, choices: guardedChoices } as T
}

function guardAssistantContentParts(
  parts: unknown[],
  fieldPrefix: string,
  protectedToolCallProtocol: ToolProtocolId | null,
): unknown[] {
  return parts.map((part, index) => {
    if (typeof part === 'string') {
      return guardAssistantText(part, `${fieldPrefix}[${index}]`, protectedToolCallProtocol)
    }
    if (!part || typeof part !== 'object' || Array.isArray(part)) return part
    const record = part as Record<string, unknown>
    const type = typeof record.type === 'string' ? record.type : undefined
    if (type && !VISIBLE_ASSISTANT_BLOCK_TYPES.has(type)) return part
    const guarded = { ...record }
    for (const key of ['text', 'content'] as const) {
      if (typeof guarded[key] === 'string') {
        guarded[key] = guardAssistantText(
          guarded[key],
          `${fieldPrefix}[${index}].${key}`,
          protectedToolCallProtocol,
        )
      }
    }
    return guarded
  })
}

function guardAssistantText(
  value: string,
  field: string,
  protectedToolCallProtocol: ToolProtocolId | null,
): string {
  const guard = new ManagedToolResultGuard(protectedToolCallProtocol)
  const streamed = guard.push(value)
  const flushed = guard.flush()
  if (guard.hasDetectedWrapperLeak()) {
    throw createManagedToolResultWrapperLeakError(field)
  }
  return streamed.content + flushed.content
}

/**
 * Enforces the reserved managed-wrapper boundary on OpenAI-compatible SSE.
 * Only visible assistant text fields are inspected; structured tool arguments
 * remain data and are never scanned as assistant prose.
 */
export function createAssistantOutputBoundaryStream(
  protectedToolCallProtocol: ToolProtocolId | null = 'managed_xml',
): Transform {
  const decoder = new StringDecoder('utf8')
  const guards = new Map<string, GuardEntry>()
  let output: Transform

  const writeEvent = (event: EventSourceMessage, data: string): void => {
    if (event.id !== undefined) output.push(`id: ${event.id}\n`)
    if (event.event !== undefined) output.push(`event: ${event.event}\n`)
    for (const line of data.split('\n')) output.push(`data: ${line}\n`)
    output.push('\n')
  }

  const failIfDetected = (entry: GuardEntry): void => {
    if (entry.guard.hasDetectedWrapperLeak()) {
      throw createManagedToolResultWrapperLeakError(entry.template.field)
    }
  }

  const flushGuards = (): void => {
    for (const entry of guards.values()) {
      const flushed = entry.guard.flush()
      failIfDetected(entry)
      if (!flushed.content) continue

      const { event, envelope, choiceIndex, container, field } = entry.template
      writeEvent(event, JSON.stringify({
        ...envelope,
        choices: [{
          index: choiceIndex,
          [container]: { [field]: flushed.content },
          finish_reason: null,
        }],
      }))
    }
    guards.clear()
  }

  const processEvent = (event: EventSourceMessage): void => {
    if (event.data === '[DONE]') {
      flushGuards()
      writeEvent(event, event.data)
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(event.data)
    } catch {
      if (event.event === 'error') flushGuards()
      writeEvent(event, event.data)
      return
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      writeEvent(event, event.data)
      return
    }

    const record = parsed as Record<string, unknown>
    const choices = Array.isArray(record.choices) ? record.choices : []
    if (choices.some(choice => (
      choice
      && typeof choice === 'object'
      && !Array.isArray(choice)
      && (choice as Record<string, unknown>).finish_reason != null
    ))) {
      flushGuards()
    }

    const { choices: _choices, ...envelope } = record
    void _choices
    for (let position = 0; position < choices.length; position += 1) {
      const choice = choices[position]
      if (!choice || typeof choice !== 'object' || Array.isArray(choice)) continue
      const choiceRecord = choice as Record<string, unknown>
      const choiceIndex = choiceRecord.index ?? position

      for (const containerName of ['delta', 'message'] as const) {
        const containerValue = choiceRecord[containerName]
        if (!containerValue || typeof containerValue !== 'object' || Array.isArray(containerValue)) {
          continue
        }
        const container = containerValue as Record<string, unknown>
        for (const field of ASSISTANT_TEXT_FIELDS) {
          const value = container[field]
          if (typeof value !== 'string') continue

          const key = `${position}:${String(choiceIndex)}:${containerName}:${field}`
          let entry = guards.get(key)
          if (!entry) {
            entry = {
              guard: new ManagedToolResultGuard(protectedToolCallProtocol),
              template: {
                event: { ...event },
                envelope: { ...envelope },
                choiceIndex,
                container: containerName,
                field,
              },
            }
            guards.set(key, entry)
          } else {
            entry.template = {
              event: { ...event },
              envelope: { ...envelope },
              choiceIndex,
              container: containerName,
              field,
            }
          }

          const guarded = entry.guard.push(value)
          failIfDetected(entry)
          container[field] = guarded.content
        }
      }
    }

    writeEvent(event, JSON.stringify(record))
  }

  const parser = createParser({
    onEvent: processEvent,
    onComment: comment => {
      for (const line of comment.split('\n')) output.push(`: ${line}\n`)
      output.push('\n')
    },
    onRetry: retry => output.push(`retry: ${retry}\n\n`),
  })

  output = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        parser.feed(decoder.write(chunk))
        callback()
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)))
      }
    },
    flush(callback) {
      try {
        const remainder = decoder.end()
        if (remainder) parser.feed(remainder)
        parser.reset({ consume: true })
        flushGuards()
        callback()
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)))
      }
    },
  })

  return output
}
