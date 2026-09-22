# 诊断：codex 会话 01a0bddc 被上游风控拦截（2026-09-22 01:41）

## 1. 现象

codex TUI：`Reconnecting... 4/5 (4h 28m 31s)`，随后

```
Stream disconnected before completion: Qwen AI rejected the request content
(risk control verdict). The conversation transcript matches an upstream-blocked
pattern (e.g. automated signup/captcha/credential flow); retrying cannot clear it.
```

## 2. 结论先行

不是代理故障，也不是代码改烂。是**上游 Qwen 风控（bxpunish / RGV587）对这个
transcript 本身下了判定**——换账号、重连、重试全部无效。

- 该会话 transcript 已膨胀到 **352 条消息 / 141 个 tool result / 单轮 117,448 tokens**（窗口 245,100）
- 从 **00:17** 起，连续 5 个请求、8 次重试全部被同一判定拒绝，累计 **42 次 verdict**、烧掉约 **41 个账号次**
- 最后一次 503 落在 **01:40:52**，与会话文件最后一条记录时间完全一致

这个会话已经救不回来了，只能 `/compact` 或新开会话。

## 3. 证据链

### 3.1 本地 codex 会话

文件：`C:\Users\skate_f\.codex\sessions\2026\09\20\rollout-2026-09-20T16-09-05-01a0bddc-96db-7483-aa7f-fcccf1ff1cf3.jsonl`

| 项 | 值 |
|---|---|
| 文件体积 | 35.5 MB |
| 事件数 | 1008（990 行） |
| 活跃 turn | `01a0c417-c670-71b2-b525-e75ff6e11ee2` |
| turn 起止 | 2026-09-21 13:11:27Z → 17:40:52Z（GMT+8 21:11 → 01:40）= **4h31m** |
| turn 内容 | 138 次 tool call、112 段 reasoning、275 个 item |
| 累计 input tokens | 8,358,162 |
| 单轮 input tokens | 117,448 |
| 上下文窗口 | 245,100 |
| 最后一条 event | `token_count` @ 17:40:52.297Z（之后无任何新写入） |

用户消息只有一条：`继续工作`。其余 4.5 小时全是 tool 循环在跑。

### 3.2 服务端日志

`/opt/chat2api/data/logs/app-logs.ndjson`（容器 chat2api / 镜像 `toolfix24-runaway`）

12h 内错误分布：

| errorCode | 次数 |
|---|---|
| qwen_ai_content_verdict | **42** |
| qwen_ai_queue_timeout | 20 |
| qwen_ai_upload_sts_unavailable | 6 |
| qwen_ai_semantic_incomplete | 6 |
| qwen_ai_request_timeout | 1 |

被拒的 8 个 requestId（GMT+8）：

| 时间 | requestId | 轮换账号数 | 最终 latency |
|---|---|---|---|
| 09-21 21:03 | chatcmpl-mub9a29s… | 6 | — |
| 09-21 21:06 | chatcmpl-mub9ek9o… | 6 | — |
| 09-22 00:17 | resp_mubg71ri… | 6 | 79,262 ms |
| 09-22 00:18 | resp_mubg8tf18… | 5 | — |
| 09-22 01:26 | resp_mubiior1… | 1 | 256,343 ms |
| 09-22 01:38 | resp_mubj3ovd… | 6 | 79,177 ms |
| 09-22 01:39 | resp_mubj5ifl… | 6 | 74,392 ms |

单次失败请求的完整时序（01:38:29 那次，GMT+8）：

```
01:38:29  request-intent  messageCount=352 toolCount=10 toolResultCount=141
01:38:29  governor admitted   account=…-kwpjo4oyz  attempt=1
01:38:39  upstream request shape  sourceMessageCount=353
01:38:39  content verdict (bxpunish/RGV587)  elapsedMs=63644
01:38:39  → 换账号 attempt=2 …
01:39:32  content verdict (bxpunish/RGV587)  elapsedMs=79166
01:39:32  stream-delivery outcome=failed status=503 qwen_ai_content_verdict
```

请求体量：`messageCount 352 / toolResultCount 141 / systemMessageChars 38,377 / sourceMessageCount 353`。

### 3.3 时间对得上

服务端 503 落在 `17:40:52Z`，会话文件最后一条 `token_count` 也是 `17:40:52.297Z`。
同一秒——确定是同一个请求，不是两个故障。

## 4. 为什么会被判定

上游没有公开判定规则。从数据看是**体量 + 形态**的组合：

1. **体量**：352 条消息里 141 个是 tool result，单轮 117k tokens，system 提示 38KB
2. **形态**：tool result 里塞了大量命令输出，以及 `data:image/png;base64,…` 整图
   （会话最后一个 tool result 就是一张 base64 PNG）
3. **行为**：每轮 ~10s 一次的高频 append（本会话 138 轮连续 tool 循环）

代理给出的文案里 "automated signup/captcha/credential flow" 只是提示性猜测，
不代表上游真的判定你在做注册/验证码——**别照着这个方向去改 prompt，改不掉**。

## 5. 顺带发现的两个工程问题

### 5.1 content verdict 仍在烧账号（与日志文案不符）

日志写的是 `failing fast, no failover burn`，但实际：

```
{Retrying Responses request with another account…} attempt=2 status=503 accountFault=false
… attempt=3 … attempt=4 … attempt=5 … attempt=6
```

`accountFault: false` 说明不是账号的问题，却仍然把 6 个账号各试一遍，
每个失败请求白烧 6 个账号 + ~79s。应改成：命中 content verdict 立即 fail，不轮换。

### 5.2 `modifiedRequest is not defined`

```
09-21 20:42:00  error  Stream response failed: modifiedRequest is not defined  chatcmpl-mub8iqhr-hi176y
09-21 20:42:05  error  Stream response failed: modifiedRequest is not defined  chatcmpl-mub8iuti-jhyuq7
```

运行时引用错误，真 bug，待定位。

## 6. 处置

**立即可做（不改动代码）**

1. 在 codex 里 `/compact`，把 352 条压成摘要再继续
2. 或直接开新会话，把当前任务目标重新描述一遍（不带历史）

**工程侧可选**

3. content verdict 命中即 fail，不轮换账号（省账号池）
4. transcript 超过阈值（如 messageCount > 200 或 单轮 > 80k tokens）时提前拒绝并给出明确提示，
   而不是让上游判、还连累账号
5. base64 图片走 document offload，不要内联进 tool result

## 6b. 09:06 续发：token refresh failed（403 + 阿里 WAF）

### 现象

```
stream disconnected before completion: Qwen AI token refresh failed (risk-control):
<!doctype html> <meta charset="UTF-8"> <meta name="aliyun_waf_aa" content="ff926c7f…">
<meta name="aliyun_waf_bb" content="eade7145…"> …
```

### 这是另一层故障，不是昨晚那个 bxpunish

| | bxpunish（01:40 那次） | token refresh failed（本次） |
|---|---|---|
| 命中位置 | 聊天请求 | **凭证刷新请求** |
| 上游返回 | 流式响应里 `bxpunish: "1"` | 403 + 阿里 WAF 挑战页 HTML |
| errorCode | `qwen_ai_content_verdict` | `qwen_ai_token_refresh_failed` |
| 代理动作 | 换账号重试 | 账号 cooldown 600s → 1200s |
| 12h 计数 | 36 | 28 个账号被冻结 |

`aliyun_waf_aa / aliyun_waf_bb` 是阿里云 WAF 的挑战页标记——**出口 IP 或刷新行为被判机器人**。
昨晚连续烧 41+ 账号次的高频 token 刷新，把 IP 惊动了。

### 最关键的一点：这个错误是 6 小时前的

容器日志里最后一条业务记录停在 **2026-09-21T18:49:49Z = GMT+8 02:49**，
此后到 09:06 只有 `WebsharePoolSync pool synced` 心跳（每 30 分钟一次）。

**代理这 6 小时没收到任何请求**——codex 从 02:49 起就没再发过请求，一直卡着。
你 09:06 看到的报错是 02:49 那次的残留。

### 那一刻的体量

```
messageCount: 493      (01:40 时还是 352)
toolResultCount: 210   (01:40 时还是 141)
context: 150K used / 245K
```

比昨晚被判 bxpunish 时又大了 40%。

### 当前状态（09:07 实测）

- 代理存活：`curl 127.0.0.1:8080/` → **200**（注意端口是 **8080**，不是 7863）
- 账号池：**410 个，405 active / 4 error / 1 inactive，0 个在 cooldown**
- cooldown 是运行时内存状态，不写入 `data.json`，已从容器中过期释放

### 追加的处置项

6. token refresh 撞 WAF 时应指数退避 + 降频，不要高频连刷把 IP 打黑
7. content verdict（bxpunish）命中即 fail，不轮换账号（见 5.1）

## 6c. 修复与实测（2026-09-22 10:35）

### 改动清单

| # | 文件 | 问题 | 修复 |
|---|---|---|---|
| A | `src/main/proxy/qwenContentFailover.ts` | `qwen_ai_content_verdict` 不在停换账号的 code 列表里，bxpunish 每次烧 6 个账号 | 新增 verdict 集合 + `isQwenAiContentVerdictFailure()`，**默认 -1 = 第一次命中即停**；env `CHAT2API_QWEN_AI_CONTENT_VERDICT_ROTATION_MAX` |
| B | `src/main/proxy/adapters/qwen-ai-token-refresh.ts` | refresh 撞 WAF 后连锁冻结账号（一晚 28 个） | 全局 refresh 闸 `openQwenAiRefreshRiskGate()`（默认 300s，1x/2x/4x/8x 退避上限 1h）；闸内不发网络请求，抛 `qwen_ai_token_refresh_gated` |
| B | `src/main/proxy/qwenAiRequestGovernor.ts` | refresh 风控走 600s→1200s 风险阶梯 | refresh 类改短 bench（30s–120s），不喂全局风险电路 |
| C | `src/main/proxy/forwarder.ts` | `modifiedRequest is not defined`（09-21 20:42 两次） | 声明提到 while 循环外，消除 TDZ 风险 |
| D | `src/main/proxy/adapters/qwen-ai.ts` | **token 被上游吊销时全池不可用**（见下） | `isUnauthorizedPayload()` + `createChat` 命中 200-envelope 时强制刷新并重试 |

### D 是实测时挖出来的，比 A/B 更致命

请求返回 `500 Failed to create chat: no chat ID returned`，上游 body 是：

```json
{"success": false, "data": {"code": "unauthorized",
  "details": "Token has expired, please log in again."}}
```

**HTTP 状态是 200**。而刷新逻辑只认 HTTP 401（`postWithRefreshRetry` 里
`if (response.status === 401)`），`refreshIfNeeded` 又只按本地 JWT `exp` 判断
（服务端吊销时 exp 还在未来）——两处都不触发刷新，于是**全池 340 个账号每个请求都死在
create chat**。这是"服务活着但完全不可用"的状态。

### 实测结果

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 401 条消息 / 293KB 请求 | 0.6s → **500** no chat ID | **200 / 163.1s**，正常返回内容 |
| 1 条消息小请求 | — | **200 / 5.9s**，内容 `OK` |
| 日志证据 | 无 refresh 记录 | 3× `create chat reported an unauthorized payload inside HTTP 200 — forcing token refresh` |

线上镜像 `skatef/chat2api:toolfix26-unauth`（ImageID `sha256:9b777139…`，与本地构建一致），
旧容器 `chat2api-old-toolfix25` / `-old-toolfix24` 留作回滚。

### 未覆盖的部分（诚实说明）

401 条消息的请求**没有**触发 bxpunish（返回 200），所以 A / B 两条修复这次
**没有被真实触发**，只有代码级验证（编译产物 grep + 容器 env 生效）。
要复现 bxpunish 需要当时那个 493 条 / 210 tool result 的真实 codex 会话形态，代价是烧账号。

## 7. 附：codex 多个 tool-call 是怎么发给 API 的

实测这一轮的 response_item：

- `function_call` 138 个、`function_call_output` 138 个
- 批次形态：绝大多数轮是 **1 个 tool_call → 1 个 output**；只在最后观测到一次 **4 个一批**
- 关键点：**一次 HTTP 请求 = 一轮循环，请求体是完整历史**，不是只发新消息

所以 tool-call 数量不决定请求数量，但**每轮请求体积随历史线性增长**——
这就是跑到 352 条时上游开始拒绝的直接原因。
