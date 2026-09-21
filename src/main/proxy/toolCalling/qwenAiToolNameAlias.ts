/**
 * Upstream-safe tool name aliasing for the Qwen AI managed protocol.
 *
 * The Qwen platform registers its OWN native tool registry (web_search,
 * web_extractor, code_interpreter, and — as observed on 2026-09-20 — a
 * built-in shell/exec primitive). When a client-declared managed tool shares a
 * name with that registry, Qwen3.8-Max prefers the platform's NATIVE
 * function_call channel over the text protocol we teach it, and the platform
 * runtime then rejects the call because the tool is not actually resolvable
 * there:
 *
 *   Tool exec_command does not exists.
 *
 * That verdict is terminal for the turn (422 rejected_native_tool_call), and a
 * same-context replay reproduces it, because the NAME is the cue. Observed on
 * production 2026-09-20 with real codex 0.155 traffic: every tool-bearing turn
 * failed with `exec_command`, while an identical probe using a tool named
 * `shell` succeeded — proving the name, not the protocol format, is decisive.
 *
 * THE FIX
 * -------
 * Rewrite a colliding client tool name to a neutral alias on the UPSTREAM WIRE
 * ONLY. The model then has no platform tool to prefer and uses the taught text
 * protocol; the alias is resolved back to the real client name before any frame
 * reaches the client, so the client contract is untouched.
 *
 * WHAT THE ALIAS MUST NOT CONTAIN (learned the hard way, three deploys)
 * --------------------------------------------------------------------
 * A namespace PREFIX DOES NOT DE-CUE ANYTHING. The model matches on the
 * SEMANTIC CORE of the name, not on the namespace:
 *
 *   exec_command      -> native channel, rejected (2026-09-20 incident)
 *   run_command       -> native channel, rejected (first deploy attempt)
 *   ch2_run_command   -> native channel, rejected (2026-09-20, 20:18)
 *   shell             -> NOT cued, succeeded (control probe)
 *
 * `ch2_run_command` still embeds the platform-owned token `run_command`, so the
 * model reached the platform's native shell primitive through the prefix. The
 * alias must therefore contain NO token the platform could own — no `run`,
 * `command`, `exec`, `shell`, `bash`, `cmd`, `terminal`. It is opaque and
 * stable so the model sees the same identifier on every turn of a conversation.
 *
 * Rotate the alias without a rebuild via CHAT2API_QWEN_AI_TOOL_NAME_ALIASES.
 */

import type { NormalizedToolDefinition } from './types.ts'

/**
 * Client tool names that collide with a Qwen platform-native tool and therefore
 * cue the native channel. Keys are lowercased client names; values are the
 * upstream-safe alias to expose in the managed tool list.
 *
 * Add an entry only when a real production rejection names the tool — this list
 * is a wire-compatibility shim, not a general rename table.
 */
const QWEN_AI_PLATFORM_TOOL_NAME_COLLISIONS: Record<string, string> = {
  // codex 0.155's default shell tool. Qwen registers its own exec/shell
  // primitive under this name, so the model routes it through the native
  // channel and the platform rejects it (2026-09-20 production incident).
  //
  // The alias must contain NO platform-ownable token. Prefixing is not enough:
  // `ch2_run_command` still embedded `run_command` and was cued through the
  // native channel on 2026-09-20 20:18, reproducing the exact 422 this table
  // exists to prevent. Hence an opaque identifier with no verb the platform
  // could own.
  exec_command: 'ch2_invoke_7a3f',
}

/**
 * Names the platform genuinely owns. A client tool with one of these names must
 * NEVER be aliased (the platform can actually run it), and it is also excluded
 * from the managed list upstream by the capability rules.
 */
const QWEN_AI_PLATFORM_OWNED_TOOL_NAMES = new Set([
  'web_search',
  'web_extractor',
  'code_interpreter',
])

export interface QwenAiToolNameAliasTable {
  /** client name (as declared) -> upstream name actually sent in the prompt. */
  toUpstream: ReadonlyMap<string, string>
  /** upstream name -> client name, for translating parsed calls back. */
  toClient: ReadonlyMap<string, string>
}

const EMPTY_ALIAS_TABLE: QwenAiToolNameAliasTable = {
  toUpstream: new Map(),
  toClient: new Map(),
}

/** Env override: comma-separated `client=upstream` pairs, or 'off' to disable. */
function aliasOverridesFromEnv(): Record<string, string> {
  const raw = String(process.env.CHAT2API_QWEN_AI_TOOL_NAME_ALIASES ?? '').trim()
  if (!raw || raw.toLowerCase() === 'off') return {}
  const overrides: Record<string, string> = {}
  for (const pair of raw.split(',')) {
    const [clientName, upstreamName] = pair.split('=').map(part => part.trim())
    if (!clientName || !upstreamName) continue
    overrides[clientName.toLowerCase()] = upstreamName
  }
  return overrides
}

/**
 * Build the alias table for one request from the client's declared tool names.
 * Only names that actually collide get an entry, and a name the platform owns
 * is never aliased.
 */
export function buildQwenAiToolNameAliasTable(
  clientToolNames: readonly string[],
): QwenAiToolNameAliasTable {
  const overrides = aliasOverridesFromEnv()
  const collisions = { ...QWEN_AI_PLATFORM_TOOL_NAME_COLLISIONS, ...overrides }
  const toUpstream = new Map<string, string>()
  const toClient = new Map<string, string>()
  // Guard against two client tools aliasing to the same upstream name, and
  // against an alias colliding with a real client tool name in this request.
  const declared = new Set(clientToolNames)

  for (const clientName of clientToolNames) {
    const key = clientName.toLowerCase()
    if (QWEN_AI_PLATFORM_OWNED_TOOL_NAMES.has(key)) continue
    const alias = collisions[key]
    if (!alias || alias === clientName) continue
    // The alias must not itself be a declared tool in this request: the parser
    // could not tell the two apart when translating back.
    if (declared.has(alias)) continue
    if (toClient.has(alias)) continue
    toUpstream.set(clientName, alias)
    toClient.set(alias, clientName)
  }

  if (toUpstream.size === 0) return EMPTY_ALIAS_TABLE
  return { toUpstream, toClient }
}

export function hasQwenAiToolNameAliases(table: QwenAiToolNameAliasTable | undefined): boolean {
  return Boolean(table && table.toUpstream.size > 0)
}

/**
 * Apply the alias to a managed tool definition list. Returns a new array; the
 * input is never mutated.
 */
export function aliasManagedToolDefinitions<T extends { name: string }>(
  tools: readonly T[],
  table: QwenAiToolNameAliasTable | undefined,
): T[] {
  if (!hasQwenAiToolNameAliases(table)) return [...tools]
  return tools.map(tool => {
    const alias = table!.toUpstream.get(tool.name)
    return alias ? { ...tool, name: alias } : tool
  })
}

/** Map an upstream tool name back to the client's declared name. */
export function clientToolNameFromAlias(
  upstreamName: string,
  table: QwenAiToolNameAliasTable | undefined,
): string {
  if (!table) return upstreamName
  return table.toClient.get(upstreamName) ?? upstreamName
}

/**
 * Tool definitions keyed by BOTH the client name and the upstream alias, plus
 * the matching name set. A managed prompt teaches the alias, so a parsed call
 * may carry either; accepting both here keeps the parser honest (it validates
 * against a real declared tool) while everything downstream still sees the
 * client name, because the alias entry points at the SAME definition object
 * whose `name` is the client name.
 */
export function aliasAwareToolLookup(
  tools: readonly NormalizedToolDefinition[],
  table: QwenAiToolNameAliasTable | undefined,
): { definitions: Map<string, NormalizedToolDefinition>; allowedNames: Set<string> } {
  const definitions = new Map<string, NormalizedToolDefinition>()
  const allowedNames = new Set<string>()
  for (const tool of tools) {
    definitions.set(tool.name, tool)
    allowedNames.add(tool.name)
  }
  if (!hasQwenAiToolNameAliases(table)) return { definitions, allowedNames }

  for (const [clientName, upstreamName] of table!.toUpstream) {
    const definition = definitions.get(clientName)
    if (!definition || definitions.has(upstreamName)) continue
    definitions.set(upstreamName, definition)
    allowedNames.add(upstreamName)
  }
  return { definitions, allowedNames }
}

/** Exposed for tests and diagnostics. */
export const QWEN_AI_TOOL_NAME_COLLISION_TABLE = QWEN_AI_PLATFORM_TOOL_NAME_COLLISIONS
