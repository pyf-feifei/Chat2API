import type { ToolCallingConfig } from '../../../shared/toolCalling.ts'
import type { NormalizedClientToolRequest } from './clientAdapters/types.ts'
import { getProviderToolProfile } from './providerProfiles.ts'
import { buildQwenAiToolNameAliasTable, hasQwenAiToolNameAliases } from './qwenAiToolNameAlias.ts'
import type { ToolCallingPlan } from './types.ts'

export function buildToolCallingRuntimePlan(input: {
  requestId?: string
  providerId: string
  providerProfileKey?: string
  actualModel?: string
  model?: string
  config: ToolCallingConfig
  clientRequest: NormalizedClientToolRequest
  /**
   * Proxy-internal tools, taught to the model but owned by this process.
   *
   * These are added to `plan.tools` and to the parser's allowlist, so the prompt
   * teaches them and a call to them parses. They are deliberately NOT in
   * `clientRequest.tools`: that is the client contract, and the client never
   * declared them. The response path partitions them out before they can reach
   * the client, and the adapter boundary strips them from the wire payload.
   */
  localTools?: NormalizedToolDefinition[]
}): ToolCallingPlan {
  const profile = getProviderToolProfile(input.providerProfileKey ?? input.providerId)
  const clientTools = input.clientRequest.tools
  const localTools = (input.localTools ?? []).filter(
    (tool) => !clientTools.some((client) => client.name === tool.name),
  )
  const tools = [...clientTools, ...localTools]
  const toolNames = new Set(tools.map((tool) => tool.name))
  const forcedName = input.clientRequest.toolChoice.forcedName

  if (input.clientRequest.toolChoice.mode === 'forced' && forcedName && !toolNames.has(forcedName)) {
    throw new Error(`Forced tool ${forcedName} is not declared`)
  }

  // A forced tool choice means the client pinned one tool. Teaching the model
  // a second one it may not call would be noise, so local tools are dropped
  // rather than silently ignored.
  const allowedToolNames = forcedName ? new Set([forcedName]) : toolNames
  const allowedTools = forcedName ? tools.filter((tool) => tool.name === forcedName) : tools
  // Qwen's platform owns a native tool registry, and a client tool whose name
  // collides with it makes the model emit the platform's native function_call
  // channel — which the platform then rejects (422). Rename colliding tools on
  // the upstream wire only; the client contract keeps the original names.
  //
  // The rename is applied where the PROMPT is rendered (see
  // `aliasManagedToolDefinitions`), never to `plan.tools`: the parser must keep
  // validating parsed calls against the client's own names, so that a tool call
  // reaches the client under the name it declared. Keeping the plan in client
  // space means no reverse translation is needed on the response path, and no
  // parsed call can silently miss the allowed-name allowlist.
  const toolNameAliases = profile.preferredManagedProtocol === 'qwen_hermes'
      || profile.preferredManagedProtocol === 'qwen_native'
    ? buildQwenAiToolNameAliasTable(allowedTools.map((tool) => tool.name))
    : undefined
  // The alias must be an allowed name too: the upstream model may legitimately
  // echo the taught alias back over the native function_call channel, and
  // rejecting it there would strand the tool call as "undeclared" instead of
  // dispatching it to the client under the original name.
  const allowedUpstreamToolNames = hasQwenAiToolNameAliases(toolNameAliases)
    ? new Set([...allowedToolNames, ...toolNameAliases!.toUpstream.values()])
    : allowedToolNames
  const disabledReason = getDisabledReason(
    input.config,
    allowedTools.length,
    input.clientRequest.toolChoice.mode,
    profile.managedSupport,
  )
  const mode = disabledReason ? 'disabled' : 'managed'
  const protocol = profile.preferredManagedProtocol
  const shouldInjectPrompt = mode === 'managed'
  const shouldParseResponse = mode === 'managed'

  return {
    mode,
    protocol,
    clientAdapterId: input.clientRequest.clientAdapterId,
    providerId: input.providerId,
    tools: allowedTools,
    toolNameAliases,
    shouldInjectPrompt,
    shouldParseResponse,
    toolChoiceMode: input.clientRequest.toolChoice.mode,
    allowedToolNames,
    /**
     * Client names plus their upstream aliases. Used only where the UPSTREAM
     * native function_call channel is validated against declared tools; the
     * response path and the client contract use `allowedToolNames`.
     */
    allowedUpstreamToolNames,
    workflowContinuation: false,
    failedToolResultPending: false,
    forcedToolName: forcedName,
    diagnostics: {
      requestId: input.requestId,
      clientAdapterId: input.clientRequest.clientAdapterId,
      providerId: input.providerId,
      model: input.model,
      actualModel: input.actualModel,
      toolSource: input.clientRequest.toolSource,
      mode,
      protocol,
      toolCount: allowedTools.length,
      injected: shouldInjectPrompt,
      reason: disabledReason ?? `managed_${input.config.mode}`,
      toolChoiceMode: input.clientRequest.toolChoice.mode,
      forcedToolName: forcedName,
      allowedToolNames: [...allowedToolNames],
      workflowContinuation: false,
      failedToolResultPending: false,
    },
  }
}

function getDisabledReason(
  config: ToolCallingConfig,
  toolCount: number,
  toolChoiceMode: string,
  managedSupport: boolean,
): string | undefined {
  if (!config.enabled || config.mode === 'off') return 'mode_off'
  if (toolChoiceMode === 'none') return 'tool_choice_none'
  if (toolCount === 0) return 'no_tools'
  if (!managedSupport && config.mode === 'auto') return 'provider_not_supported'
  return undefined
}
