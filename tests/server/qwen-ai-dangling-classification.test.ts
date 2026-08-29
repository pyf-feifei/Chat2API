import test from 'node:test'
import assert from 'node:assert/strict'
import { isProgressStyleManagedAnswer } from '../../src/main/proxy/adapters/qwenAiProgressIntent.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

/**
 * Pin the STRUCTURAL contract of isDanglingManagedToolAnswer (private to the
 * adapter). Over a live tool workflow the classification is wording-independent:
 * any marker-less answer ≤300 codepoints without a tool call is dangling. The
 * three real 2026-08-29 stall texts must classify through this rule alone —
 * NOT through the opener word-list (which is assistance-only and stays
 * minimal on purpose).
 */

function plan(overrides: Partial<ToolCallingPlan> = {}): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol: 'qwen_native',
    clientAdapterId: 'standard-openai-tools',
    providerId: 'qwen-ai',
    tools: [{ name: 'exec_command', parameters: {}, source: 'openai' }],
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['exec_command']),
    workflowContinuation: false,
    failedToolResultPending: false,
    hasLiveToolWorkflow: false,
    diagnostics: {
      clientAdapterId: 'standard-openai-tools',
      providerId: 'qwen-ai',
      toolSource: 'openai',
      mode: 'managed',
      protocol: 'qwen_native',
      toolCount: 1,
      injected: true,
      reason: 'test',
      workflowContinuation: false,
      failedToolResultPending: false,
    },
    ...overrides,
  }
}

// Mirror of the gate order in isDanglingManagedToolAnswer after the fix.
const MANAGED_SHORT_ANSWER_CODE_POINTS = 300
function classifyDangling(content: string, planState: ToolCallingPlan): boolean {
  const trimmed = content.trim()
  if (!planState.shouldParseResponse || planState.allowedToolNames.size === 0) return false
  if (!trimmed) return false
  // (tool-call parse and completion-marker checks precede; these fixtures
  // carry neither.)
  if (planState.hasLiveToolWorkflow) {
    if (isProgressStyleManagedAnswer(trimmed)) return true
    if ([...trimmed].length <= MANAGED_SHORT_ANSWER_CODE_POINTS) return true
  }
  if (isProgressStyleManagedAnswer(trimmed)) return true
  const midWorkflow = planState.workflowContinuation || planState.hasLiveToolWorkflow === true
  if (!midWorkflow) {
    if (planState.toolChoiceMode === 'auto') return false
    if (trimmed.length > 0) return false
  }
  // Mid-workflow marker contract: marker-less answers are dangling. Over a
  // LIVE workflow there is no length escape (no legitimate marker-less
  // terminal exists); plain continuation turns keep the 800 floor.
  if (planState.hasLiveToolWorkflow === true) return true
  return trimmed.length <= 800
}

const stall1 = [
  '理解！完全遵守 prompt.md 的强制 3D 资产管线：',
  '',
  '1. **image2-p** → 生成原型图（已有 3 张）',
  '2. **img2threejs** → 从原型图重建 3D 模型代码',
  '',
  '现在开始执行管线。先检查原型图质量，然后初始化 img2threejs 状态。',
].join('\n')

const stall2 = '继续执行 3D 资产管线。先生成缺失的原型图，然后用 img2threejs 重建模型。'

const stall3 = '我正在审视项目中的变更情况，确认哪些文件已准备就绪。  \n随后将把所有更新整合进版本历史，并同步至远程仓库。  \n整个过程确保代码的完整性和可追溯性。'

test('all three real stall texts classify as dangling over a live workflow, wording-independent', () => {
  const livePlan = plan({ hasLiveToolWorkflow: true, toolChoiceMode: 'auto' })
  assert.equal(classifyDangling(stall1, livePlan), true, 'stall1 (acknowledgment plan)')
  assert.equal(classifyDangling(stall2, livePlan), true, 'stall2 (continue statement)')
  assert.equal(classifyDangling(stall3, livePlan), true, 'stall3 (narration prose)')
  // A wording the system has NEVER seen must classify identically.
  assert.equal(classifyDangling('Alright, diving into the repo state next.', livePlan), true, 'novel English phrasing')
  assert.equal(classifyDangling('先摸一下底，再动手。', livePlan), true, 'novel Chinese phrasing')
})

test('stall texts over continuation turns (trailing tool results) also classify', () => {
  const contPlan = plan({ workflowContinuation: true, toolChoiceMode: 'auto' })
  assert.equal(classifyDangling(stall1, contPlan), true)
  assert.equal(classifyDangling(stall2, contPlan), true)
  assert.equal(classifyDangling(stall3, contPlan), true)
})

test('first-turn auto direct answers remain legitimate (no live workflow)', () => {
  const firstTurn = plan({ hasLiveToolWorkflow: false })
  assert.equal(
    classifyDangling('The build completed successfully with 12 tests passing.', firstTurn),
    false,
  )
  // Even an intent-shaped first answer stays deliverable when it does not hit
  // the generic opener list (assistance layer only, deliberately minimal).
  assert.equal(classifyDangling(stall3, firstTurn), false, 'stall3 wording on a clean first turn')
})

test('over a live workflow even LONG marker-less narrations are dangling (no length escape)', () => {
  // Observed failure mode: a 6.8k-char plan narration with zero tool calls
  // delivered as the final answer. Over a live workflow there is no
  // legitimate marker-less terminal at any length.
  const livePlan = plan({ hasLiveToolWorkflow: true })
  assert.equal(classifyDangling('x'.repeat(6814), livePlan), true, '6.8k narration')
  assert.equal(classifyDangling('x'.repeat(900), livePlan), true, '900 chars')
})

test('plain continuation turns keep the 800 substantive-summary floor', () => {
  const contPlan = plan({ workflowContinuation: true })
  assert.equal(classifyDangling('x'.repeat(300), contPlan), true, 'short: dangling')
  assert.equal(classifyDangling('x'.repeat(900), contPlan), false, 'long summary: deliverable')
})
