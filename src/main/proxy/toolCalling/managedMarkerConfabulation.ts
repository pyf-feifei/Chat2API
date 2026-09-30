/**
 * Does a completion-marker answer get delivered, or must it be re-examined for
 * confabulation first?
 *
 * The completion marker attests that the WORK is finished. A capability denial
 * ("I don't have access to your filesystem") or a colon-terminated promise
 * ("The file contains:") CONTRADICT that attestation — the model appends the
 * marker to a confabulation it never executed. Observed live 2026-09-29 on m365
 * gpt-5.6-sol: `The file `/etc/hostname` contains:
 * <chat2api_workflow_complete/>` was delivered verbatim and ended the agent turn
 * with no tool call at all.
 *
 * Kept in a leaf module (type-only deps) so it is node --test reachable:
 * `zai.ts` cannot be imported by the suite because it reaches `storeManager`
 * (electron-store), so the judgment itself is what gets pinned by tests.
 *
 * Scoped to the m365_fenced protocol. The reasoning is not backend-specific,
 * but widening it silently changes zai/qwen marker handling, so that is a
 * separate, separately-measured change.
 */
import {
  isColonTerminatedShortAnswer,
  isProgressStyleManagedAnswer,
} from '../adapters/qwenAiProgressIntent.ts'
import { isM365ToolDenialManagedAnswer } from '../adapters/m365ToolDenial.ts'
import { stripManagedWorkflowCompletionMarker } from './workflowCompletion.ts'
import type { ToolCallingPlan } from './types.ts'

/**
 * Matches the zai classifier's short-answer cap (MANAGED_SHORT_ANSWER_CODE_POINTS
 * in zai.ts). Kept as a named constant here because the cap is part of what is
 * being pinned: a long marked answer is real work, and re-prompting it would
 * discard visible output and risk a duplicate answer.
 */
const MANAGED_SHORT_ANSWER_CODE_POINTS = 300

/**
 * Codepoint count without `[...value]`, which needs downlevelIteration
 * (tsconfig.node.json targets no ES version).
 */
function codePointLength(value: string): number {
  let count = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) index += 1
    count += 1
  }
  return count
}

/**
 * Framing that means the model is TEACHING the caller, not reporting a result
 * it obtained. Deliberately does not include "here is the …" result forms.
 */
const INSTRUCTIONAL_FRAMING =
  /\b(?:use this (?:format|pattern|structure|template)|for example|e\.g\.|such as|like this|should look like|template|format(?: is)?:|follow this|here is how|here's how|expected (?:format|output|shape))\b/i

/**
 * Does the answer CLAIM a result it never received?
 *
 * The colon check only fires when the answer ENDS in a colon, but the model
 * routinely writes "The file contains:\n\n```text\n<value>\n```" — a promised
 * result immediately followed by a fabricated payload, so the answer no longer
 * ends in the colon and slips through (observed live 2026-09-29: the branch
 * claimed `/etc/hostname` contains `SandboxHost-639262978165693778` with no
 * tool call at all, and it was delivered as the answer).
 *
 * Two shapes are confabulation here:
 * 1. a label ending in a colon followed by a fenced code block — the promised
 *    enumeration with a made-up body;
 * 2. an explicit "ran/returned/contains" claim of a command or file read, in a
 *    branch that produced no tool call. This is cramt's
 *    `looksLikeHallucinatedCompletion`, gated on "never acted" by the caller.
 *
 * The fenced block must be a real fence with an info string; a bare `~~~` or an
 * unterminated backtick run is not a claim.
 */
export function looksLikeFabricatedResultClaim(text: string): boolean {
  if (!text) return false

  // 1. A label ending in a colon followed by a claimed payload, on the same
  // line or the next. Both live shapes:
  //      "The file `/etc/hostname` contains:\n\n```text\n<value>\n```"
  //      "Kernel information from `uname -a`: `Linux … 6.1.158.2 …`"
  // The first is a promise plus a fabricated body; the second needs no promise
  // at all. A colon followed by a backtick or a fence introduces content the
  // model asserts it obtained.
  //
  // Instructional framing is excluded: "Use this format: ```json …```" teaches
  // the caller something and asserts no result, so the same punctuation must
  // not be read as a claim. The markers are deliberately distinct from
  // result framing ("here is how" vs "here is the output").
  if (/[:：]\s*(?:\r?\n|\r)*\s*(?:```|`)/.test(text) && !INSTRUCTIONAL_FRAMING.test(text)) return true

  // 2. An explicit result claim over a command or file read. Kept narrow: a
  // factual answer that merely discusses a command's output as data does not
  // match, because the verbs require a completed-action sense and the object
  // must be a command or a file. "running the tests" (ongoing) does not match
  // "ran the tests" (claimed).
  const claim =
    /\b(?:command|shell|script|file|contents?|output)\b[^.!?\n]{0,40}?\b(?:returned|prints?|printed|produced|shows?|showed|contains?|contained|is|was)\b/i.exec(text)
  if (claim) {
    // Guard against a question being quoted back as a plan.
    if (/\b(?:i(?:'| wi)?ll|we(?:'| wi)?ll|to run|should run|let's|how to|can you|could you|would you)\b/i.test(text)) {
      // Allow the claim only if the fabrication markers below are present.
      if (!/\b(?:here(?:'s| is)|the (?:command|output|result)|as (?:you|i) (?:asked|requested)|shown below|following)\b/i.test(text)) {
        return false
      }
    }
    return true
  }

  // 3. A result verb with no noun before it, because the command IS the
  // backticked text: "`uname -a` returned: Kernel version: 6.1.158.2"
  // (observed live 2026-09-29, delivered as an answer). Also the bare
  // "verb + colon" form, which is a claim of a payload in the next line.
  if (/`[^`\n]{1,80}`[^.!?\n]{0,24}?\b(?:returned|printed|produced|gave|output|shows?|showed|reports?)\b/i.test(text)) {
    return true
  }
  if (/\b(?:returned|printed|produced|output|shows?|reports?)\s*:/i.test(text)) {
    return true
  }
  return false
}

export type ManagedMarkerVerdict =
  /** Deliver the answer as a final answer (previous behaviour). */
  | 'deliver'
  /**
   * A confabulation signal is present (denial / colon promise / progress
   * prose) in a marked answer that never ran anything: run the caller's normal
   * confabulation checks instead of short-circuiting on the marker.
   */
  | 'scrutinize_confabulation'

export interface ManagedMarkerConfabulationResult {
  /**
   * `deliver` — the answer is a real final answer (previous behaviour).
   * `scrutinize_confabulation` — a confabulation signal is present in a marked
   * answer that never ran anything, so the caller must run its normal
   * confabulation checks instead of short-circuiting on the marker.
   */
  verdict: ManagedMarkerVerdict
  /**
   * The answer with the completion marker removed.
   *
   * The caller MUST use this for the confabulation checks it runs after
   * deciding to scrutinize: the marker is transport text, so a colon-terminated
   * promise that ends in `<chat2api_workflow_complete/>` does not end in a
   * colon. Checking the marker-bearing text instead silently passes every
   * confabulation check and delivers the denial anyway.
   */
  text: string
}

/**
 * A "label: value" claim where the value is prose rather than a fenced or
 * backticked payload. Both remaining live leaks on 2026-09-29 had this shape:
 *
 *   "The file `/etc/hostname` in the environment I can access contains: Note
 *    that this is the hostname of the execution environment…"
 *   "Kernel reported by `uname -a`: The kernel version is **6.1.146.1**."
 *
 * Deliberately NOT a claim: a list ("The steps are:\n1. …") and an
 * instructional sentence ("Use this format: …"), which are legitimate answers.
 *
 * Meant to be combined with evidence that the user actually asked for an
 * ACTION (see `looksLikeActionRequest`). Wording alone cannot separate "The
 * capital of France is: Paris" (a fact the model may legitimately know) from a
 * fabricated command result, so this function must not be used on its own.
 */
export function hasClaimedPayload(text: string): boolean {
  if (!text) return false
  if (INSTRUCTIONAL_FRAMING.test(text)) return false
  // A colon that introduces an enumeration is a legitimate answer shape.
  return /[:：]\s*(?:\r?\n|\r\s*)?\s*(?![-*•]\s)(?!\d+[.)]\s)[^\s]/.test(text)
}

/**
 * Did the user ask for an operation to be performed?
 *
 * This is the evidence that separates a fabricated result from a legitimate
 * answer. "What is the capital of France?" needs no tool, so a prose answer is
 * correct and must be delivered; "Read /etc/hostname" needs one, so a prose
 * answer claiming the contents is a confabulation. The verdict is therefore
 * used only where BOTH hold: the user asked for an action, and no tool ran.
 */
export function looksLikeActionRequest(text: string): boolean {
  if (!text) return false
  return /\b(read|run|execute|launch|list|check|inspect|edit|write|open|create|delete|remove|search|fetch|cat|ls|grep|install|update|build|test|scan|dump|print|show me|look at|tell me what(?:'s| is) in)\b/i.test(text)
}

/**
 * Does this answer, with no tool call, claim a capability denial or a result it
 * never received?
 *
 * The marker gate above is only reachable when the model emitted the completion
 * marker. A non-stream turn has no such gate, and the live M365 pool answers
 * the same request with a bare fabrication ("`uname -a` returned: Kernel
 * version: 6.1.158.2") with no marker at all, so the same judgment has to be
 * available without one. Kept separate from the marker verdict because that
 * one is explicitly scoped to marker-bearing text.
 */
export function looksLikeManagedConfabulation(text: string): boolean {
  if (!text) return false
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  return (
    isM365ToolDenialManagedAnswer(trimmed)
    || looksLikeFabricatedResultClaim(trimmed)
    || isColonTerminatedShortAnswer(trimmed)
  )
}

/**
 * Every condition is a necessary part of the "never acted" gate:
 * - tools were declared, so a tool call was reachable at all;
 * - no tool ever ran, so nothing has actually been verified;
 * - the answer is short, i.e. a claim rather than a substantive final answer.
 */
export function managedMarkerConfabulationVerdict(
  content: string,
  plan: ToolCallingPlan,
): ManagedMarkerConfabulationResult {
  const text = stripManagedWorkflowCompletionMarker(content, plan).trim()
  const deliver = (): ManagedMarkerConfabulationResult => ({ verdict: 'deliver', text })

  // M365-only. A concurrent edit briefly widened this to `optional`-marker
  // plans too, which pulls zai into the change; the scoping is deliberate and
  // only m365_fenced is an M365 transport.
  if (plan.protocol !== 'm365_fenced') return deliver()
  if (plan.allowedToolNames.size === 0) return deliver()
  if (plan.hasLiveToolWorkflow === true) return deliver()
  if (text.length === 0) return deliver()

  // A claim of a result that never arrived is a confabulation at ANY length.
  // The length cap below is not a way out of it: a long answer is not
  // automatically real work, and "I ran the command and it printed …" with no
  // tool call behind it is fabricated however much prose surrounds it.
  if (looksLikeFabricatedResultClaim(text)) {
    return { verdict: 'scrutinize_confabulation', text }
  }

  // Past this point the answer does not claim a fabricated result, so length is
  // informative: a short one is more likely a bare assertion, a long one
  // carries real requested content.
  if (codePointLength(text) > MANAGED_SHORT_ANSWER_CODE_POINTS) return deliver()

  const confabulates =
    isColonTerminatedShortAnswer(text)
    || isM365ToolDenialManagedAnswer(text)
    || isProgressStyleManagedAnswer(text)
  return { verdict: confabulates ? 'scrutinize_confabulation' : 'deliver', text }
}
