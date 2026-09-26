# 上游 Token 优化调研（2026-09-24）

> 目的：寻找可以在 Chat2API 转发到上游前使用的 token 优化方式，并区分“减少输入 token”“减少计费/计算”“保持任务质量”这三个不同目标。
>
> 结论先行：不存在对所有任务都保证“token 大幅减少且质量完全不变”的通用压缩算法。证据最充分、风险最低的是**不改写内容的 provider-native prompt cache/context cache**；如果必须减少原始 prompt token，当前项目更适合采用**任务感知的 PACE/ACON 思路 + 受保护的 extractive compressor**，而不是把 LLMLingua 直接应用到完整工具历史。

## 1. 先区分三个指标

| 指标 | 含义 | 不能混淆的地方 |
| --- | --- | --- |
| 原始输入 token | 上游实际渲染出来的 prompt token 数 | 减少它通常会改变模型看到的上下文 |
| 计费/计算 token | 缓存命中后按折扣计费，或减少 prefill 计算 | 可能原始 token 数完全没有减少 |
| 任务质量 | 回答正确率、工具调用成功率、长任务成功率 | 单看 token 节省率不能证明质量没有下降 |

Provider 的 prompt cache 通常只减少第二项。LLMLingua、PACE、ACON 等才涉及改写上下文，但质量必须用任务集验证。

## 2. Chat2API 现状与项目内基线

### 2.1 当前代码不是可直接启用的“无损优化器”

- `src/main/proxy/services/contextManagementService.ts:100-123` 用“字符数 / 3”估算 token，只是保守近似，不是任何上游的真实 tokenizer。
- 同文件 `:142-185` 的 sliding window 和 `:188-266` 的 token limit 会直接丢弃历史；它们没有工具调用、文件路径、错误状态、待办事项的语义保护。
- `SummaryStrategy` 在没有 summary generator 时会退化为只保留最后 N 条消息（`:316-325`）；summary 失败时也会丢弃旧消息（`:373-382`）。这不能作为“质量不受影响”的实现。
- Qwen 专用的 `qwenAiCompactionBoundary.ts:292-363` 已经具备按预算切块、覆盖全部源文本的 map/reduce 基础；`forwarder.ts:3417-3454` 只在检测到 `context_compaction` 时启用它，普通长请求不会自动压缩。

### 2.2 本机开发日志的规模基线（不是质量实验）

从当前工作区的 `dev-server.log` 提取到 99 条 Responses `request-intent` 记录：

- 67 条（67.7%）估算输入 token ≥ 10,000；43 条（43.4%）≥ 50,000；12 条（12.1%）≥ 100,000；最大 158,513。
- 67 条请求启用了 10 个工具；它们占全部估算 token 的约 94.96%。43 条 ≥50k 的长请求全部是工具请求，占总估算 token 的约 85.45%。
- 典型长请求包含 251–362 条消息、83–181 个 tool result，消息 JSON 约 9.8 MB。
- 27 条 Qwen upstream shape 记录中，document transport 将完整 transcript 放在附件中；按日志的 UTF-8 字节数，inline 部分相对完整 transcript 的 aggregate wire reduction 约 94.72%。**这不是 token reduction**：附件内容仍可能被上游解析并计入模型上下文。

因此，本项目的第一优先级不是压缩 tool schema，而是管理旧的 tool observation / conversation history。当前工作区的 `req_real.json` fixture 也显示：32,197 个消息文本字符中约 99.5% 来自 `tool` 消息。

## 3. 有明确数据的研究和项目

### 3.1 Provider-native cache：最接近“质量不变”

#### Qwen / DashScope Context Cache

官方文档明确写明“在不影响回复效果的前提下”：

- 显式缓存：最少 1,024 token；创建缓存通常按普通输入价 125% 计费；命中通常按 10% 计费；有效期 5 分钟。
- 隐式缓存：自动识别公共前缀；命中部分通常按普通输入价 20% 计费，但命中率不确定。
- 官方示例中，若 50% 输入命中缓存，示例总输入费用为无缓存模式的 60%：`(50% × 100%) + (50% × 20%) = 60%`。

来源：<https://help.aliyun.com/zh/model-studio/context-cache>

注意：这是 DashScope/百炼的官方 API 能力。Chat2API 内置的 `chat.qwen.ai` Web adapter 走的是 `/api/v2/chat/completions` Web payload，不是 DashScope 的 OpenAI-compatible cache payload；不能直接把 `cache_control` 塞进去就宣称已支持，必须按 provider capability 开启并读取真实 cache-hit usage。

#### OpenAI Prompt Caching

官方文档说明缓存的是相同前缀的 KV 状态，输入 token 仍会被渲染，但可按 cached-input rate 计费；不同模型折扣不同，文档给出的上限是“up to 90%”。整个前缀必须匹配，修改 system、tools、工具顺序或历史前缀会使后续部分无法命中。

来源：<https://developers.openai.com/api/docs/guides/prompt-caching>

#### DeepSeek Context Caching

官方 API 默认启用磁盘前缀缓存，但明确是 best-effort、不保证命中率；usage 中提供 `prompt_cache_hit_tokens` 和 `prompt_cache_miss_tokens`，可用来做真实测量。

来源：<https://api-docs.deepseek.com/guides/kv_cache/>

**判断**：如果目标是“费用和延迟下降而不改变模型看到的 token 内容”，这是优先级最高、证据最充分的方案。它不是“减少 token 数量”。

### 3.2 LLMLingua / LongLLMLingua / LLMLingua-2

Microsoft 官方仓库：<https://github.com/microsoft/LLMLingua>（MIT）。相关论文均已发表于 ACL/EMNLP：

- LLMLingua：<https://aclanthology.org/2023.emnlp-main.825/>
- LongLLMLingua：<https://aclanthology.org/2024.acl-long.91/>
- LLMLingua-2：<https://aclanthology.org/2024.findings-acl.57/>

#### LLMLingua-2 的直接数据

在 LongBench 的 2,000-token constraint、GPT-3.5-Turbo 目标模型上：

| 条件 | 原始 | LLMLingua-2 | 变化 |
| --- | ---: | ---: | ---: |
| LongBench 平均 token | 10,295 | 1,954（约 5x） | 原始 token 约减少 81.0% |
| LongBench 平均分 | 44.0 | 39.1 | -4.9 分 |
| ZeroSCROLLS 平均 token | 9,788 | 1,898（约 5x） | 原始 token 约减少 80.6% |
| ZeroSCROLLS 平均分 | 34.7 | 33.4 | -1.3 分 |

在 GSM8K half-shot 上，14x 压缩为 178 token，EM 77.79；完整示例为 78.85（-1.06 分）。在 BBH half-shot 上，5x 为 176 token、EM 61.94；完整示例为 70.07（-8.13 分）。这直接说明：**即使使用 extractive compressor，也不能把 5x/14x 说成“无性能影响”**。

论文的延迟实验（V100-32G，包含压缩开销）是无压缩 14.9 s；LLMLingua-2 在 1x/2x/3x 压缩率下分别为 9.4/7.5/5.2 s，即 1.6x/2.1x/2.9x 端到端加速。模型为 355M 参数的 XLM-RoBERTa-large 或 110M 的 multilingual-BERT；论文报告 peak GPU memory 约 2.1 GB。

#### LongLLMLingua 的数据

LongLLMLingua 是 question-aware 的粗到细压缩，适合“当前问题决定哪些历史重要”的场景，而不是盲目压缩所有文本：

- NaturalQuestions 20 documents、4x constraint：原始约 2,946 token，压缩后 748 token；相关文档位于第 10 位时，分数从原始 54.1 提升到 71.2；延迟从 4.1 s 降到 2.1 s。
- LongBench 2,000-token constraint：原始平均 10,295 token、44.0 分；LongLLMLingua 约 1,822 token、48.3 分，延迟 15.6 s 降到 6.1 s。

但论文也明确指出它需要针对不同问题重新压缩，且压缩开销约为普通 LLMLingua 的两倍。对 Chat2API 的工具历史而言，不能直接把“最新用户文本”当成唯一 query，因为工具调用还依赖旧的文件路径、ID、已完成操作和失败原因。

#### 实际 Node/Electron 集成候选

第三方纯 JS/TS port：<https://github.com/atjsh/llmlingua-2-js>（MIT，npm `@atjsh/llmlingua-2`）。README 给出的模型体积为 TinyBERT 57.1 MB、MobileBERT 99.2 MB、XLM-RoBERTa 约 2.24 GB；但仓库自己标注为 **Experimental**，且目前没有 unit tests。它适合做可选本地 sidecar/实验，不适合未经基准测试就设为默认。

**判断**：LLMLingua-2 可以作为“旧 prose 消息的 extractive scorer”，不能作为完整 managed-tool transcript 的默认压缩器。

### 3.3 更适合长工具代理的 ACON / PACE

#### ACON（Microsoft 研究实现）

论文：<https://arxiv.org/abs/2510.00615>

官方代码：<https://github.com/microsoft/ACON>

ACON 针对 AppWorld、OfficeBench 等长程 agent，压缩历史和 observation，并优化“保留哪些状态”的 guideline：

- AppWorld：平均 accuracy 56.0%，peak input 9.93k；ACON UTCO 为 56.5%、7.33k（约 -26.2% peak token，+0.5 个百分点）。
- OfficeBench：无压缩 76.84%、7.27k；ACON UT 为 74.74%、4.93k（约 -32.2%，-2.1 个百分点）；更激进的 UTCO 为 72.63%、4.54k（约 -37.6%，-4.21 个百分点）。
- 8-objective QA：无压缩 EM 0.366、peak 10.35k；ACON UT 为 EM 0.373、peak 4.71k（约 -54.5%）。

这组结果说明“任务感知、状态保护”的压缩比通用 token pruning 更适合 agent，但 aggressive 模式仍会损伤质量；它是 arXiv 预印本，不应当当作无条件保证。

#### PACE（ACL 2026 长文）

论文：<https://aclanthology.org/2026.acl-long.1252/>

代码/数据入口：<https://anonymous.4open.science/r/PACE-B000/>

PACE 使用“预测下一步相关性 + 多粒度记忆（全文/详细摘要/简短摘要/占位符）+ 可按需恢复”的上下文构建方式：

- GAIA Level 3、Claude-4-Sonnet：ReAct 42.1%，Summary 47.4%，Folding 52.6%，PACE 63.2%（+21.1 个百分点 vs ReAct）。
- 128K context budget 的 GAIA Level 3 轨迹中，PACE 在第 39 步约 28.5K token，而 ReAct 已到 128K（约 78% reduction）；在第 131 步 PACE 约 48.0K，而 Summary 已到 128K（约 63% reduction）。
- 其 ablation 显示，去掉多粒度表示后 BrowseComp/BrowseComp-ZH/WideSearch/GAIA 分别从 47.6/51.2/64.2/74.0 降到 42.3/45.5/55.9/68.5，说明“只保留摘要”并不等价于安全压缩。

PACE 不是可以直接嵌入 Chat2API 的 npm 包，但它给出了最符合本项目工具历史形态的设计：**不要把旧工具结果直接删掉，而是按下一步任务相关性降级为不同粒度，并保留可恢复入口**。

### 3.4 工具输出/日志压缩项目

#### sqz

仓库：<https://github.com/ojuschugh1/sqz>（ELv2；许可证需单独审查）。可复现报告见 [quality benchmark](https://github.com/ojuschugh1/sqz/blob/main/docs/quality-benchmark.md) 和 [session benchmark](https://github.com/ojuschugh1/sqz/blob/main/docs/benchmark.md)。它的 fixture 数据给出了比营销页面更诚实的结果：

- 表中 13 个 fixture 合计 3,115 → 1,387 token，减少 55.5%；76/76 个关键事实保留；重复内容支持 byte-exact recovery。
- 单独场景：pytest failure 311 → 71（77.2%），重复 app log 1,025 → 135（86.8%），source file、traceback、secrets 故意 0% 压缩。
- 30 分钟综合 coding session 示例为 41,900 → 6,469 token（85%），但这是固定 fixture 的 token 估算（部分使用 `chars/4`），不是 live model task-success 实验。

该项目最有价值的设计原则是：代码、堆栈、密钥不动；日志/JSON/重复结果才压缩；压缩结果必须可恢复。README 自己也承认 fixture fact recall 不等于 agent task success。若在 Chat2API 中采用“引用 token”，必须额外提供 expansion/retrieval 能力，否则不能保证模型能恢复原文。

#### Headroom / leanctx

我也检查了 Headroom 和 leanctx。它们提供了 TypeScript/Python proxy、内容路由、可逆缓存等工程实现，但当前公开 benchmark 主要是项目方自己的 token/延迟或代理任务结果；Headroom 的 [benchmark 文档](https://github.com/headroomlabs-ai/headroom/blob/main/docs/content/docs/benchmarks.mdx) 也明确某些 LLM QA 对比没有提交可复现结果。因此它们可以作为架构参考，不能单独作为“性能不受影响”的证据。尤其不要把 hosted compression API 放进默认路径，以免工具输出和凭据离开本机。

## 4. 对 Chat2API 的推荐方案

### 4.0 当前已实现的 opt-in 模式

本项目新增了 `src/main/proxy/services/upstreamTokenOptimizer.ts`，在 `forwardChatCompletion` 发送上游前执行，默认关闭：

```bash
# 只测量候选节省，不改变请求
CHAT2API_UPSTREAM_TOKEN_OPTIMIZER=dry-run

# 开启安全的旧工具结果压缩
CHAT2API_UPSTREAM_TOKEN_OPTIMIZER=safe

# 显式实验模式：对过长旧工具结果保留头尾/关键/当前任务相关行
# 这不是无损模式，必须先在 dry-run 和真实任务集上验证
CHAT2API_UPSTREAM_TOKEN_OPTIMIZER=balanced

# 关闭
CHAT2API_UPSTREAM_TOKEN_OPTIMIZER=off
```

辅助变量：

```bash
CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_MIN_TOKENS=20000
CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_RECENT_MESSAGES=8
CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_MIN_SAVINGS=64
CHAT2API_UPSTREAM_TOKEN_OPTIMIZER_MAX_TOOL_TEXT_CHARS=16000
```

`safe` 模式目前的边界必须明确：

- 只处理达到 token 阈值的旧 `role=tool` 文本；
- 合法的 JSON 只做 `JSON.stringify` 等价的空白压缩；
- 连续 3 次以上相同的非关键日志行改成“原行 + 重复次数”标记；
- system、assistant tool-call、错误工具结果、最近 N 条消息、未完成/孤立工具状态不处理；`safe` 不改非空源代码/标记，但允许压缩连续空行；
- 不删除消息，不修改 role、tool ID、tool arguments、tool schema；
- 如果估算节省不足，直接发送原请求；
- `balanced` 模式会对超过 `MAX_TOOL_TEXT_CHARS` 的旧工具结果保留头尾、关键行和当前用户请求相关行，其余内容替换为带遗漏字符数的标记；这是有损实验模式，不应直接当作 `safe` 使用。
- 这是“保守的结构化压缩/实验性任务感知裁剪”，不是完整的 PACE/LLMLingua 摘要器，质量仍需按第 4.3 节实测。

Docker 镜像和 `docker-compose.yml` 已透传上述变量，默认值均为 `off`。

### 4.1 不建议直接做的事情

1. 不要对完整 `messages`（尤其 managed tool protocol、tool result、JSON 参数）直接调用 LLMLingua。
2. 不要把 `slidingWindow.maxMessages=20` 当作长工具代理的优化方案；它可能直接丢掉工具状态。
3. 不要把 document attachment 的 wire byte 减少当成模型 token 减少。
4. 不要在没有 upstream usage/cache 字段的情况下宣称费用已经下降。

### 4.2 推荐分层

**第 0 层：测量，不改变请求**

- 在 `src/main/proxy/routes/responses.ts` 已有的 `estimatedInputTokens` 旁边增加 optimizer dry-run 结果：`before/after/protected/candidate/estimatedSaved`。
- 读取上游真实 usage：已有 MiMo 等适配器的 usage 应保留；Qwen Web 目前 `QwenAiStreamHandler` 使用本地估算（`src/main/proxy/adapters/qwen-ai.ts:5621-5647`），不能把它当账单真值。
- 按 provider 记录 cache hit/miss、原始/优化后 token、压缩耗时、任务结果和 tool-call 成功率。

**第 1 层：无损/不改语义**

- 对支持 cache 的官方 API，按 provider capability 发送 cache breakpoint；保持 system、tools、稳定历史前缀字节完全不变。
- 支持 Responses 原生 compaction 的上游，透传 `context_management`；Qwen Web 继续使用现有显式 compaction/map-reduce，不把不兼容字段发给 Web API。
- 这一层不追求减少原始 token，只追求降低计费/prefill。

**第 2 层：PACE/ACON-lite 的任务感知历史管理**

- 保护：system prompt、工具 schema、当前 active user request、所有未完成 tool call/result、最新 tool result、路径/ID/参数/错误标记。
- 候选：较旧、已完成、低相关性的 prose observation 和重复日志。
- 表示：全文 → 详细结构化摘要 → 简短摘要 → placeholder；保留可恢复映射。
- 先只在“工具结果占比高且历史很长”的请求上启用，短普通对话不处理。

**第 3 层：可选 LLMLingua-2**

- 只对第 2 层标记为高容忍的 prose 子块做 extractive compression。
- 先在 0.5、0.7、0.8 三档保留率上做项目 A/B，不直接使用 0.2（5x）；这些档位是实验设计，不是论文对 Chat2API 的最优参数结论。
- 失败、超时、工具协议不完整、关键事实校验失败时 fail-open，发送原始请求。

### 4.3 建议的验收门槛（项目实测前不能宣称“无影响”）

对至少 100 个真实/脱敏任务，固定模型、temperature 和工具集合，做 raw vs optimized 双跑：

- 任务成功率下降不超过 1 个百分点，并报告 95% 置信区间；
- tool-call schema 成功率 100%，所有 tool name/ID/关键参数保持一致；
- 受保护区域字节级一致；
- 长工具任务输入 token 至少下降 15%（这是建议的工程门槛，不是外部论文结论）；
- 压缩额外 p95 延迟不超过上游首 token 延迟的 10%，并记录超时回退次数；
- 对 cache 单独统计 hit rate、cached-token 计费和真实账单，不与 raw-token reduction 混算。

## 5. 最终选择

- **现在就能安全做**：官方 API 的 prompt cache、已有 Responses/Qwen 原生 compaction、精确 usage 统计。
- **最值得在本项目开发的开源方向**：借鉴 PACE/ACON 的“任务感知 + 多粒度 + 可恢复”历史层；LLMLingua-2 只作为 prose 子块的 extractive scorer。
- **可以参考但不能直接复制**：`sqz` 的日志/JSON/重复结果保护规则；其 ELv2 许可证需要先做合规评估。
- **不建议**：全局 LLMLingua、简单 head/tail、固定窗口、只保留一个摘要后直接发给 Qwen Web。

## 6. 主要来源

- Microsoft LLMLingua GitHub：<https://github.com/microsoft/LLMLingua>
- LLMLingua（EMNLP 2023）：<https://aclanthology.org/2023.emnlp-main.825/>
- LongLLMLingua（ACL 2024）：<https://aclanthology.org/2024.acl-long.91/>
- LLMLingua-2（Findings ACL 2024）：<https://aclanthology.org/2024.findings-acl.57/>
- ACON：<https://arxiv.org/abs/2510.00615>；<https://github.com/microsoft/ACON>
- PACE（ACL 2026）：<https://aclanthology.org/2026.acl-long.1252/>
- Qwen Context Cache：<https://help.aliyun.com/zh/model-studio/context-cache>
- OpenAI Prompt Caching：<https://developers.openai.com/api/docs/guides/prompt-caching>
- DeepSeek Context Caching：<https://api-docs.deepseek.com/guides/kv_cache/>
- sqz：<https://github.com/ojuschugh1/sqz>
- Headroom：<https://github.com/headroomlabs-ai/headroom>
