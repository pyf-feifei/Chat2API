import type { ToolCallingPlan } from './types.ts'

export const MANAGED_WORKFLOW_COMPLETE_MARKER = '<chat2api_workflow_complete/>'
const MANAGED_WORKFLOW_COMPLETE_MARKER_VARIANTS = [
  MANAGED_WORKFLOW_COMPLETE_MARKER,
  '<chat2api_workflow_complete>',
] as const

type ManagedWorkflowCompletionPlan = Pick<
  ToolCallingPlan,
  | 'shouldParseResponse'
  | 'protocol'
  | 'allowedToolNames'
  | 'workflowContinuation'
  | 'failedToolResultPending'
>

export interface ManagedWorkflowCompletionProof {
  complete: boolean
  content: string
}

export function parseManagedWorkflowCompletionProof(
  content: string,
  plan?: ManagedWorkflowCompletionPlan,
): ManagedWorkflowCompletionProof {
  if (!supportsManagedWorkflowCompletionMarker(plan)) {
    return { complete: false, content }
  }

  const trimmed = content.trimEnd()
  const marker = MANAGED_WORKFLOW_COMPLETE_MARKER_VARIANTS.find(candidate => (
    trimmed.endsWith(candidate)
  ))
  if (!marker) {
    return { complete: false, content }
  }

  const markerStart = trimmed.length - marker.length
  const prefix = trimmed.slice(0, markerStart)
  if (
    MANAGED_WORKFLOW_COMPLETE_MARKER_VARIANTS.some(candidate => prefix.includes(candidate))
    || isInsideOpenCodeFence(trimmed, markerStart)
    || isQuotedOrCodeLine(trimmed, markerStart)
  ) {
    return { complete: false, content }
  }

  return {
    complete: true,
    content: prefix.trimEnd(),
  }
}

export function hasManagedWorkflowCompletionMarker(
  content: string,
  plan?: ManagedWorkflowCompletionPlan,
): boolean {
  return parseManagedWorkflowCompletionProof(content, plan).complete
}

export function stripManagedWorkflowCompletionMarker(
  content: string,
  plan?: ManagedWorkflowCompletionPlan,
): string {
  return parseManagedWorkflowCompletionProof(content, plan).content
}

export function requiresManagedWorkflowCompletionMarker(plan?: ManagedWorkflowCompletionPlan): boolean {
  return Boolean(
    supportsManagedWorkflowCompletionMarker(plan)
    // A successful continuation must terminate with either a parsed tool call
    // or an explicit completion proof. A failed tool result is different: the
    // structured failure state permits a final explanation without inventing
    // a success proof.
    && (!plan?.workflowContinuation || plan.failedToolResultPending === false)
  )
}

/**
 * The marker belongs to the managed protocol even when this branch does not
 * require the model to emit it. Keeping capability separate lets us strip an
 * optional marker without turning it into client-visible protocol text.
 */
export function supportsManagedWorkflowCompletionMarker(
  plan?: ManagedWorkflowCompletionPlan,
): boolean {
  return Boolean(
    plan?.shouldParseResponse
    && (plan.protocol === 'qwen_hermes' || plan.protocol === 'qwen_native')
    && plan.allowedToolNames.size > 0
  )
}

const COMPLETION_MARKER_PREFIX = '<chat2api_workflow_complete'

export interface ManagedWorkflowCompletionMarkerOccurrence {
  start: number
  /** Exclusive end: the index of the first character after the marker text. */
  end: number
}

/**
 * Locates a stray completion marker in assistant prose: a marker occurrence
 * that is not inside an open code fence and not a quoted or indented line.
 * These are the same visibility guards the proof parser applies, so text that
 * would be rejected as a proof for formatting reasons (documented literal
 * markers) is not treated as protocol output here either.
 */
export function findStrayManagedWorkflowCompletionMarker(
  content: string,
  fromIndex = 0,
): ManagedWorkflowCompletionMarkerOccurrence | undefined {
  let searchIndex = Math.max(0, fromIndex)
  while (searchIndex <= content.length - COMPLETION_MARKER_PREFIX.length) {
    const start = content.indexOf(COMPLETION_MARKER_PREFIX, searchIndex)
    if (start === -1) return undefined

    const slashClose = content.startsWith('/>', start + COMPLETION_MARKER_PREFIX.length)
      ? COMPLETION_MARKER_PREFIX.length + 2
      : undefined
    const bareClose = content.startsWith('>', start + COMPLETION_MARKER_PREFIX.length)
      ? COMPLETION_MARKER_PREFIX.length + 1
      : undefined
    if (!slashClose && !bareClose) {
      searchIndex = start + 1
      continue
    }

    if (isInsideOpenCodeFence(content, start) || isQuotedOrCodeLine(content, start)) {
      searchIndex = start + 1
      continue
    }

    return { start, end: start + (slashClose ?? bareClose!) }
  }
  return undefined
}

/**
 * Streaming companion of {@link findStrayManagedWorkflowCompletionMarker}:
 * reports whether the buffer ends with a partial marker prefix that must be
 * held back until the next delta disambiguates it. Prefixes of every full
 * variant are matched (including the bare-prefix-plus-"/" state), because a
 * delta boundary can land anywhere inside the marker text.
 */
export function trailingPartialManagedWorkflowCompletionMarkerIndex(
  buffer: string,
): number | undefined {
  const maxVariantLength = Math.max(
    ...MANAGED_WORKFLOW_COMPLETE_MARKER_VARIANTS.map(variant => variant.length),
  )
  const maxCandidateLength = Math.min(maxVariantLength - 1, buffer.length)
  for (let length = maxCandidateLength; length >= 1; length -= 1) {
    const index = buffer.length - length
    const slice = buffer.slice(index)
    if (!MANAGED_WORKFLOW_COMPLETE_MARKER_VARIANTS.some(variant => variant.startsWith(slice))) {
      continue
    }
    if (isInsideOpenCodeFence(buffer, index) || isQuotedOrCodeLine(buffer, index)) return undefined
    return index
  }
  return undefined
}

/**
 * Whether the held text can still become a completion marker once more
 * content arrives. Used to release a partial hold as ordinary prose as soon
 * as the stream leaves the marker path, so a stray "<" at a delta boundary
 * never suppresses the rest of the response.
 */
export function isManagedWorkflowCompletionMarkerPath(text: string): boolean {
  return MANAGED_WORKFLOW_COMPLETE_MARKER_VARIANTS.some(variant => variant.startsWith(text))
}

/**
 * Removes every stray marker occurrence from assistant prose. Guarded
 * occurrences (code fences, quotes, indentation) are preserved as literal
 * text; tool-call argument payloads are never routed through this helper.
 */
export function stripStrayManagedWorkflowCompletionMarkers(content: string): string {
  let result = content
  let searchFrom = 0
  for (;;) {
    const occurrence = findStrayManagedWorkflowCompletionMarker(result, searchFrom)
    if (!occurrence) return result
    result = result.slice(0, occurrence.start) + result.slice(occurrence.end)
    searchFrom = occurrence.start
  }
}

function isInsideOpenCodeFence(content: string, index: number): boolean {
  let openFence: { character: '`' | '~'; length: number } | undefined
  const linesBeforeMarker = content.slice(0, index).split('\n')

  for (const line of linesBeforeMarker) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!match) continue

    const sequence = match[1]
    const character = sequence[0] as '`' | '~'
    if (!openFence) {
      openFence = { character, length: sequence.length }
      continue
    }

    if (
      character === openFence.character
      && sequence.length >= openFence.length
      && match[2].trim() === ''
    ) {
      openFence = undefined
    }
  }

  return Boolean(openFence)
}

function isQuotedOrCodeLine(content: string, index: number): boolean {
  const lineStart = content.lastIndexOf('\n', index - 1) + 1
  const linePrefix = content.slice(lineStart, index)
  if (/^\s*>/.test(linePrefix) || /^(?: {4}|\t)/.test(linePrefix)) return true
  const singleBackticks = linePrefix.replace(/```/g, '').match(/`/g)?.length ?? 0
  return singleBackticks % 2 === 1
}
