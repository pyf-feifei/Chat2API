# 诊断：本地 Qwen 全池风控（2026-09-25）

> 与 [diag-2026-09-22-codex-bxpunish.md](diag-2026-09-22-codex-bxpunish.md) 是**两种不同的
> 故障**，不要混淆：
> - 9/22 那次是**内容**判定（transcript 命中上游屏蔽模式），换 IP 无用。
> - 9/25 这次是**出口 IP** 判定（`egress-IP flag`），换 IP 立刻好。

## 1. 现象

- 本地 Docker 实例 340 个 Qwen 账号中 339 个被写成 `inactive`，报
  `Qwen AI account is not registered: email not found`
- 聊天请求返回 503 `qwen_ai_content_verdict` / `RGV587`
- **同一批账号在生产环境（195.242.178.82）一切正常**

最初结论（本机被风控，等窗口过去）**是错的**，见下文。

## 2. 根因：Clash 节点就是那台生产服务器

Clash Verge 的活动节点：

```yaml
proxies:
- name: hysteria2
  type: hysteria2
  server: 195.242.178.82     # ← 正是"线上"那台机器
  port: 443
```

于是**"本地"和"线上"从来就不是两个出口，是同一个出口**。

配套环境变量：

```
HTTP_PROXY  = http://127.0.0.1:7897
HTTPS_PROXY = http://127.0.0.1:7897
NO_PROXY    = 127.0.0.1,localhost      # 只排除了本机
系统代理     ProxyEnable=1, ProxyServer=127.0.0.1:7897
```

`NO_PROXY` 只排除了本机，其余全部走代理。实测：

```
$ node -e "const p=require('proxy-from-env');p.getProxyForUrl('https://chat.qwen.ai/api/v1/chat')"
http://127.0.0.1:7897        # 走代理
```

## 3. 三个反直觉的关键事实

### 3.1 "家宽 IP 被封"是伪命题

| 路径 | 出口 IP | 归属 |
|---|---|---|
| 走 Clash（应用实际） | `195.242.178.82` | AS7488 CNServer LLC，洛杉矶机房 |
| 直连（真家宽） | `221.213.36.92` | AS4837 中国联通，昆明 |

家宽 IP **从未被使用过**，也就谈不上被封。

### 3.2 Docker 容器没有代理环境变量，照样走代理

```
$ docker exec chat2api sh -c "env | grep -i proxy"
(空)

$ docker exec chat2api node -e "fetch('https://ipinfo.io/ip').then(...)"
195.242.178.82
```

Docker Desktop 的网络层继承 Windows 系统代理。拦截发生在容器网络栈**之下**，
所以在容器内设 `NO_PROXY` 毫无作用——容器里根本没有 `HTTP_PROXY` 可绕。

**结论：Docker 部署的唯一有效修法是 mihomo 规则。**

### 3.3 关闭 Windows「代理」设置页对 Node 无效

Node 读的是 `HTTP_PROXY`/`HTTPS_PROXY` **环境变量**，不读 WinINET 设置。
这是最常见的假修复。

## 4. 为什么之前那次 A/B 对照是无效的

当时的论证是"本地住宅 IP 被风控，线上同账号不同 IP 全 200"。但两端的出口
是同一个 `195.242.178.82`——**被当成了"不同 IP"的同 IP 对照**，而实验看起来
完全自洽，整个诊断因此跑偏了一整个会话。

教训：**做 A/B 之前，先把两端的出口 IP 并排打出来确认它们真的不同。**

## 5. 已确认的修复

### 5.1 代码层：强制直连

`src/main/proxy/egressPolicy.ts`（新增），在 `src/main/index.ts` 与
`src/server/index.ts` 中先于任何网络模块执行。原理：`proxy-from-env` 每次
`getProxyForUrl()` 都重读 `process.env`，所以运行时追加对已存在的 axios 实例
也立即生效。

```
[Egress] Provider traffic forced direct. proxy=http://127.0.0.1:7897
         no_proxy=127.0.0.1,localhost,.qwen.ai,.qianwen.com,.aliyuncs.com,...
```

对 Electron / `npm run dev` / 本机 node 进程有效；**对容器无效**（见 3.2）。

### 5.2 Clash 层：订阅覆写加 DIRECT

写在**覆写文件**（`profiles/<uid>.yaml` 的 `prepend`），不是订阅本体——
订阅每次更新都会被覆盖。

### 5.3 出口级熔断

原有的熔断是**按请求指纹**的，挡不住出口级风控：不同 transcript 的请求各有
指纹、各自换账号继续冲。新增进程级出口熔断（`qwenAiRiskCircuit.ts`）：
窗口内 N 个**不同请求体**被判风控后，在消耗下一个账号之前拒绝所有新流量；
一次成功即关闭。

## 6. 验证（决定性证据）

mihomo 控制端是 Windows 命名管道，不是 HTTP。管道名**不能**从
`clash-verge.yaml` 读（那份可能是旧的），要枚举：

```powershell
[System.IO.Directory]::GetFiles('\\.\pipe\') | Where-Object { $_ -match 'verge|mihomo' }
```

查询 `/rules` 得到运行中核心的规则表：

```
[0] DomainSuffix qwen.ai => DIRECT   hitCount=29
```

从容器内发起一次 `chat.qwen.ai` 请求后：

```
[0] DomainSuffix qwen.ai => DIRECT   hitCount=30   (+1)
```

一次同时证明两件事：容器流量确实经过 Clash，且现在被规则 [0] 接管为 DIRECT。

对照组 `ipinfo.io`（不在直连规则内）出口仍是 `195.242.178.82`，说明代理功能
未被破坏，只有 qwen 路径改变。

## 7. 最终结果

```
POST /v1/chat/completions  model=Qwen3.8-Max
→ http=200  time=3.77s  content="PONG"

accountId   1781330009915-i2h54co93   （单账号）
风控判定    0 条
熔断触发    0 次
账号池      340 total / 339 active / 1 inactive（未恶化）
```

回归：`tests/server` 全量 1103/1103 通过；`tsc` 类型错误 302，与基线一致。

## 8. 与 9/22 死锁的关系

同期还发现一个**独立**问题（与出口无关，代码层面）：

`qwenAiSessionRepair.ts` 曾对非 `active` 账号直接判 `unrepairable`，而
`qwen-ai-token-refresh.ts` 会把账号写成 `inactive`——一次 `email not found`
误判就让刷新功能对自己永久失效，修复队列再也捞不回来。

已在 2026-09-22 修复：strike 窗口确认（需连续多次才落盘 `inactive`）+ 对
repairable 的非 active 账号走 probe 队列。

## 9. 复盘清单

1. 测**应用**的出口，不是浏览器的。
2. 比对 **AS 号**，不是延迟。
3. 做本地/线上 A/B 前，先确认两端出口**真的不同**。
4. "请求量太大"是导火索，不是根因；出口是机房 IP 的话下次还会犯。
5. WAF 挑战页**不能**证明 IP 被封——无凭证请求在任何网络下都返回同样的页。
6. 不要在工作机上跑全量账号池；限流是按出口 IP 计的。

配置细节见 [network-egress.md](network-egress.md)。
