/**
 * Copilot Studio tool-calling agent: identity, naming and wire fields.
 *
 * Why this exists at all: M365 ignores per-request prompt injection for tool
 * calling — it answers in prose or hallucinates tool results. Measured on this
 * repo's own 25-account pool (2026-09-29/30): across ~40 tool turns the
 * fenced protocol yielded ONE compliant call, everything else being a denial
 * or a fabrication, with the full fenced-protocol prompt already in place.
 * cramt/m365-copilot-proxy measures
 * the same thing and identifies the fix: the tool contract has to arrive as a
 * SERVER-SIDE system prompt, delivered by a Copilot Studio agent. The syntax
 * barely matters; "the agent is the lever, not the syntax".
 *
 * Everything in this file is pure so it can be covered by a plain node --test
 * run. The network side (BAP / Copilot Studio) lives in `agentProvisioner.ts`.
 */

import { createHash } from 'crypto'

/** Agent display name prefix. The instruction hash is appended. */
export const AGENT_BASE_NAME = 'm365-tool-agent'
export const AGENT_DESCRIPTION = 'Auto-created agent for tool calling'

/** API surface + versions, quoted from the Copilot Studio minimalBots contract. */
export const BAP_API = 'https://api.bap.microsoft.com'
export const BAP_ENVIRONMENTS_PATH =
  '/providers/Microsoft.BusinessAppPlatform/environments/~default?api-version=2023-06-01'
export const PP_BOTS_PATH = '/copilotstudio/minimalBots/api?api-version=2022-03-01-preview'
export const PP_BOT_PUBLISH_PATH_SUFFIX = '/publish?api-version=2022-03-01-preview'

export const POWER_PLATFORM_SCOPE = 'https://api.powerplatform.com/.default'
export const BAP_SCOPE = 'https://api.bap.microsoft.com/.default'

/**
 * The server-side system prompt, baked into the agent at CREATE time.
 *
 * Deliberately FORMAT-CONTRACT ONLY. cramt measured that baking heavy
 * anti-confabulation / anti-advise framing into the agent SUPPRESSED tool
 * emission entirely (0 calls) — behavioural framing has to stay in the cheap
 * per-request channel where it can be A/B'd without re-provisioning the agent.
 * Keep this minimal: changing it changes the hash and provisions a new agent.
 */
export function agentInstructions(): string {
  return `You are the execution core of an automated agent. Your output is parsed by a program.

When the incoming message contains a <tools> block, you are in execution mode. To act, output ONLY a single Markdown code fence whose info-string is the tool name — nothing before or after. A fenced block is an ACTION the runtime executes immediately against a live system; it is never an example or illustration:
\`\`\`<tool_name>
<one "key: value" header line per scalar argument>

<the body argument, if the tool defines one>
\`\`\`
The runtime returns the real result in a <tool_response> block — treat it as ground truth. Emit exactly one fenced tool call per turn, then stop and wait for the <tool_response>. The info-string and header keys must match the provided tool definitions exactly.

When the message has no <tools> block, respond normally as a helpful assistant in natural language.`
}

/**
 * The agent's instructions are baked in by `create` and cannot be cheaply
 * updated in place (the update API needs a `changeToken` that only `create`
 * returns). So the agent is versioned BY NAME: edit the instructions and the
 * next request provisions a fresh agent. Hosts sharing a tenant compute the
 * same name for the same instructions and converge on one agent with no
 * coordination, which is also why stale versions are never deleted — a second
 * proxy may still be mid-conversation with one.
 */
export function agentInstructionsHash(): string {
  return createHash('sha256').update(agentInstructions()).digest('hex').slice(0, 8)
}

export function agentName(): string {
  return `${AGENT_BASE_NAME}-${agentInstructionsHash()}`
}

/**
 * `Default-<guid>` -> the bare environment id, lowercased, dashes stripped.
 * Returns undefined for a name that is not in that shape rather than guessing:
 * a wrong id produces two DNS names that do not resolve at all, and the error
 * then surfaces as an opaque network failure much later.
 */
export function parseEnvironmentIdFromName(name: string | undefined | null): string | undefined {
  if (typeof name !== 'string') return undefined
  const stripped = name.replace(/^Default-/i, '').replace(/-/g, '').toLowerCase()
  return /^[0-9a-f]{32}$/.test(stripped) ? stripped : undefined
}

/**
 * Power Platform splits the environment id across TWO DNS labels: everything
 * but the last two characters, then those two characters as a label of their
 * own.
 *
 * This is the cramt bug worth not repeating: hardcoding a `.df.` second label
 * resolves only for tenants whose environment id happens to end in `df` — the
 * maintainer's does, which is exactly why the bug stayed invisible while
 * provisioning failed outright for every other tenant (cramt issue #8). For an
 * id ending in `df` both forms reach the same host; for any other ending only
 * this one resolves.
 */
export function powerPlatformEnvironmentUrl(envId: string): string {
  if (!/^[0-9a-f]{32}$/.test(envId)) {
    throw new Error(`Unexpected Power Platform environment id: ${envId}`)
  }
  return `https://default${envId.slice(0, -2)}.${envId.slice(-2)}.environment.api.powerplatform.com`
}

/** Both DNS candidates for an id, so a probe can report which one resolved. */
export function powerPlatformEnvironmentCandidates(envId: string): string[] {
  const correct = powerPlatformEnvironmentUrl(envId)
  return [correct, `https://default${envId.slice(0, -2)}.df.environment.api.powerplatform.com`]
}

/**
 * The id the chat turn must reference.
 *
 * cramt's executed code builds `${titleId}.${botId}.gpt.default`; its prose doc
 * writes the same thing as `T_{titleId}.{botId}.gpt.default`, i.e. the `T_`
 * prefix is part of the TitleId the publish call returns rather than something
 * to add here. This follows the code, and a TitleId that already carries `T_`
 * passes through unchanged.
 */
export function agentIdFrom(titleId: string, botId: string): string {
  if (!titleId) throw new Error('Publish response missing TitleId')
  if (!botId) throw new Error('Bot id missing')
  return `${titleId}.${botId}.gpt.default`
}

/**
 * The per-turn wire fields, which REPLACE `plugins` rather than joining it:
 * cramt measured that with an agent attached, `plugins` is not what routes the
 * turn to the agent.
 */
export function buildAgentChatFields(agentId: string): {
  threadLevelGptId: { id: string; source: string }
  gpts: Array<Record<string, unknown>>
} {
  return {
    threadLevelGptId: { id: agentId, source: 'MOS3' },
    gpts: [{
      id: agentId,
      source: 'MOS3',
      version: '1.0.0',
      clientOverrides: {
        capabilities: [],
        'deepResearchModels@odata.type': 'Collection(String)',
      },
    }],
  }
}

/**
 * Attach the agent ONLY when the request carries tools.
 *
 * Measured, not stylistic: the declarative agent OVERRIDES the tone and forces
 * GPT-5, so a `Claude_Sonnet` tone silently becomes GPT-5 once the agent is
 * attached. Non-default tones therefore stay usable for plain chat only.
 */
export function shouldUseStudioAgent(toolCount: number): boolean {
  return toolCount > 0
}
