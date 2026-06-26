import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('Qwen AI requests are routed through a per-provider governor', () => {
  const forwarderSource = fs.readFileSync('src/main/proxy/forwarder.ts', 'utf8')
  const governorSource = fs.readFileSync('src/main/proxy/qwenAiRequestGovernor.ts', 'utf8')

  assert.match(forwarderSource, /qwenAiRequestGovernor/)
  assert.match(forwarderSource, /qwenAiRequestGovernor\.run\(account\.id/)
  assert.match(forwarderSource, /this\.forwardQwenAi\(request, account, provider, actualModel, startTime\)/)

  assert.match(governorSource, /CHAT2API_QWEN_AI_MAX_CONCURRENT/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_GLOBAL_MIN_INTERVAL_MS/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_ACCOUNT_MIN_INTERVAL_MS/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_RISK_COOLDOWN_MS/)
  assert.match(governorSource, /maxConcurrent/)
  assert.match(governorSource, /accountNextAvailableAt/)
  assert.match(governorSource, /attachRelease\(result\.stream, release\)/)
})

test('Qwen AI risk-control failures open account cooldown instead of immediate reuse', () => {
  const chatRouteSource = fs.readFileSync('src/main/proxy/routes/chat.ts', 'utf8')
  const loadBalancerSource = fs.readFileSync('src/main/proxy/loadbalancer.ts', 'utf8')
  const governorSource = fs.readFileSync('src/main/proxy/qwenAiRequestGovernor.ts', 'utf8')

  assert.match(chatRouteSource, /isQwenAiRiskControl/)
  assert.match(chatRouteSource, /FAIL_SYS_USER_VALIDATE\|RGV587/)
  assert.match(chatRouteSource, /loadBalancer\.markQwenAiRiskControl\(account\.id\)/)

  assert.match(loadBalancerSource, /markAccountCooldown/)
  assert.match(loadBalancerSource, /markQwenAiRiskControl/)
  assert.match(loadBalancerSource, /QWEN_AI_RISK_COOLDOWN/)
  assert.match(loadBalancerSource, /cooldownUntil/)
  assert.match(loadBalancerSource, /isAccountInHardCooldown/)
  assert.match(loadBalancerSource, /filter\(account => !this\.isAccountInHardCooldown\(account\.id\)\)/)

  assert.match(governorSource, /qwen_ai_risk_control/)
  assert.match(governorSource, /2 \*\* \(failures - 1\)/)
})
