# Chat2API

<p align="center">
  <img src="build/icons.png" alt="Chat2API Logo" width="128" height="128">
</p>

<p align="center">
  <a href="https://github.com/pyf-feifei/Chat2API/releases"><img src="https://img.shields.io/badge/version-1.4.0-2563eb?style=flat-square" alt="版本 1.4.0"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-2563eb?style=flat-square" alt="GPL-3.0 许可证"></a>
  <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/Electron-33%2B-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron 33+"></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React 18"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 5"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat-square" alt="macOS、Windows 和 Linux">
</p>

<p align="center">
  <strong><a href="README.md">English</a> | <a href="https://chat2api-doc.vercel.app/">官网</a> | <a href="https://chat2api-doc.vercel.app/docs">文档</a></strong>
</p>

Chat2API 是一个跨平台桌面应用和无 Electron 服务端。它将基于 Web 的 AI 服务商账户统一接入本地 OpenAI 兼容网关，配置一次后即可连接 OpenAI SDK、编程代理、桌面客户端和内部工具。

![Chat2API 仪表盘](docs/screenshots/preview.png)

## 主要功能

- **OpenAI 兼容网关**：提供 `/v1/chat/completions`、`/v1/responses`、旧版 `/v1/completions`、模型列表、SSE 流式输出、API Key 认证和多模态消息处理；同时在 `/v1beta` 下提供 Gemini 兼容的生成和文件接口。
- **服务商与账户管理**：支持一个服务商配置多个账户，验证凭证、映射客户端模型名、固定首选服务商或账户，并按轮询、填充优先或故障转移策略路由。
- **工具调用与推理兼容**：在上游支持的范围内统一函数/自定义工具调用、工具结果续接、推理内容、联网搜索、深度研究和服务商专属思考模式。
- **长请求控制**：提供上下文压缩、请求和流式超时、队列准入、连接保活、有限重试，以及 Qwen 会话和响应恢复。
- **桌面与服务端部署**：在 macOS、Windows、Linux 上使用 Electron 界面，也可以在 Docker 中运行 Koa 代理和浏览器管理端。
- **运维界面**：仪表盘统计、请求日志、模型同步、API Key、代理设置、主题、系统托盘，以及中英文界面。
- **客户端桥接**：支持 [Codex CLI Responses 接口](docs/codex.md)。

## 支持的服务商

当前内置服务商及模型如下：

| 服务商 | 认证方式 | 内置模型 |
| --- | --- | --- |
| DeepSeek | User Token | `deepseek-v4-flash`、`deepseek-v4-pro` |
| GLM | Refresh Token | `GLM-5.1` |
| Kimi | JWT / Web Token | `Kimi-K2.6`、`Kimi-K3` |
| MiniMax | JWT | `MiniMax-M2.7` |
| Mimo | 浏览器 Cookie | `MiMo-V2.5-Pro`、`MiMo-V2.5`、`MiMo-V2-Flash` |
| Perplexity | Session Cookie | `Auto` |
| Qwen（国内版） | SSO Ticket | `Qwen3.6`、`Qwen3.7-Max`、`Qwen3.5-Flash`、`Qwen3-Max`、`Qwen3-Max-Thinking-Preview`、`Qwen3-Coder` |
| Qwen AI（国际版） | JWT，可选 Cookie 和登录凭证 | `Qwen3.8-Max`、`Qwen3.8-Max_Fast`、`Qwen3.8-Max_Auto`、`Qwen3.8-Max_Thinking`、`Qwen3.7-Plus`、`Qwen3.7-Max` |
| Z.ai | JWT | `GLM-5.1`、`GLM-5-Turbo`、`GLM-5V-Turbo`、`GLM-5`、`GLM-4.7` |

服务商可用性和模型名称由上游 Web 应用决定，可能随时变化。凭证获取、适配差异和模型映射请查看[服务商说明](docs/providers/README.md)。

## 安装

### 下载桌面版本

有可用发行版时，请从 [GitHub Releases](https://github.com/xiaoY233/Chat2API/releases) 下载。源码镜像位于 [pyf-feifei/Chat2API](https://github.com/pyf-feifei/Chat2API)：

| 平台 | 安装包 |
| --- | --- |
| macOS Apple Silicon | `Chat2API-<version>-mac-arm64.dmg` |
| macOS Intel | `Chat2API-<version>-mac-x64.dmg` |
| Windows | `Chat2API-<version>-x64-setup.exe` 或便携版 |
| Linux | `Chat2API-<version>-x64.AppImage`、`.deb` 或 `.tar.gz` |

### 从源码运行

环境要求：Node.js 18+、npm 和 Git。Docker 镜像使用 Node.js 22。

```bash
git clone https://github.com/pyf-feifei/Chat2API.git
cd Chat2API
npm install
npm run dev:win       # Windows
npm run dev           # macOS/Linux
```

构建生产版本：

```bash
npm run build
npm run build:mac
npm run build:win
npm run build:linux
npm run build:all
```

### Docker 服务端

Docker 镜像运行 Koa 代理和浏览器管理端，数据保存在 `/data`，默认监听 `8080`：

```bash
docker build -t chat2api:server .
docker run -d --name chat2api \
  -p 8080:8080 \
  -v chat2api-data:/data \
  -e CHAT2API_HOST=0.0.0.0 \
  -e CHAT2API_PORT=8080 \
  -e CHAT2API_ENABLE_MANAGEMENT_API=true \
  -e CHAT2API_MANAGEMENT_SECRET=change-me \
  chat2api:server
```

打开 `http://localhost:8080/admin/`，使用管理密钥登录。完整的 [Docker 部署指南](docs/docker.md) 介绍了 Compose、浏览器辅助导入账户、存储加密、Qwen 会话修复和运行参数调优。

## 快速开始

1. 启动 Chat2API，或启动 Docker 服务端。
2. 打开**服务商**页面，添加内置服务商并填写其 Web 凭证。凭证保存在本地，请勿提交到代码仓库。
3. 打开**代理设置**，选择端口和路由策略，然后启动代理。
4. 将 OpenAI 兼容客户端的地址设为 `http://127.0.0.1:8080/v1`。

Python OpenAI SDK 示例：

```python
from openai import OpenAI

client = OpenAI(
    api_key="your-chat2api-key",
    base_url="http://127.0.0.1:8080/v1",
)

response = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "你好，Chat2API！"}],
)

print(response.choices[0].message.content)
```

Codex CLI 请使用 Responses 接口并参考 [docs/codex.md](docs/codex.md)。

## 网络出口：让服务商流量绕过本地代理

Chat2API 必须通过你**真实**的网络路径访问服务商 API，而不是走本地 HTTP/SOCKS
代理。一旦走错，会出现一整类看起来像“账号问题”或“内容问题”、实则是出口问题的
上游故障。

这不是假设。2026-09-25，一台开启了 Clash Verge 且设置了
`HTTP_PROXY`/`HTTPS_PROXY=http://127.0.0.1:7897` 的 Windows 主机，把**所有**服务商
请求都发到了一个托管在 `195.242.178.82` 的 `hysteria2` 节点上——而那台机器正是运行
生产环境的服务器。于是 Qwen 看到的是一个共享的美国机房出口，而不是家宽 IP，阿里云
WAF 随之返回 `bxpunish` / `RGV587` 风控判定（`qwen_ai_content_verdict`、
“egress-IP flag”）。**家宽 IP 从未被封，它只是压根没被用上。**

### 自动防护

`src/main/proxy/egressPolicy.ts` 在 Electron 主进程与无头服务端中均先于任何网络模块
执行，它会把服务商域名追加到 `NO_PROXY`/`no_proxy`。之所以能立即生效，是因为 axios
使用的解析库 `proxy-from-env` 会在**每次请求时**读取 `process.env`，因此对已经创建
好的 axios 实例同样生效。你**无需**做任何配置。

默认直连的域名：`.qwen.ai`、`.qianwen.com`、`.aliyuncs.com`、`.alibabacloud.com`、
`.alicdn.com`，以及 `localhost` 和 `127.0.0.1`。

| 变量 | 作用 |
| --- | --- |
| `CHAT2API_EGRESS_DIRECT=off` | 关闭该策略（服务商流量重新走代理） |
| `CHAT2API_EGRESS_DIRECT=a.com,b.com` | 替换内置列表 |
| `CHAT2API_EGRESS_DIRECT_EXTRA=c.com` | 追加到内置列表 |

### 自行验证出口

```bash
# 策略生效后应用会走的路径
node -e "const p=require('proxy-from-env');console.log(p.getProxyForUrl('https://chat.qwen.ai/api/v1/chat')||'DIRECT')"

# 真实网络出口
curl -s https://ipinfo.io/ip
```

第一个命令输出 `DIRECT` 是预期结果。如果第二个命令返回的是机房 AS（如 `AS7488`），
说明 Chat2API 上游仍有东西在代理。（`AS4837` 属于正常家宽运营商。）

### Clash Verge / Mihomo

应用层策略管不到浏览器。如果同一账号在浏览器和 Chat2API 上使用不同出口，上游会看到
账号在两个 IP 之间“跳动”，这在风控看来极像账号被盗。请在订阅覆写里把相同域名加为
`DIRECT`，且必须放在 `MATCH,PROXY` **之前**：

```yaml
prepend:
  - DOMAIN-SUFFIX,qwen.ai,DIRECT
  - DOMAIN-SUFFIX,qianwen.com,DIRECT
  - DOMAIN-SUFFIX,aliyuncs.com,DIRECT
  - DOMAIN-SUFFIX,alibabacloud.com,DIRECT
  - DOMAIN-SUFFIX,alicdn.com,DIRECT
```

在 Clash Verge 中，该文件位于
`%APPDATA%/io.github.clash-verge-rev.clash-verge-rev/profiles/<uid>.yaml`。
改完后需在 UI 里重载订阅；核心以服务方式运行，无管理员权限的 shell 无法重启它。

> **Docker 注意**：Docker Desktop 的网络层会继承 Windows 系统代理，所以即使容器内
> **没有** `HTTP_PROXY`，流量照样被本地代理接管。在容器内设 `NO_PROXY` 无效。对
> Docker 部署而言，**上面这些 Clash 规则才是真正的修复**，而不是应用层策略。

**完整配置、验证与排障：[docs/network-egress.md](docs/network-egress.md)。**

### 容器：先查 Docker 的 VM 级代理

如果**容器**的每个请求都返回阿里云 WAF 挑战页（`aliyun_waf_aa`），而同一账号在
浏览器里正常，那原因几乎一定是 Docker Desktop 的代理，而不是服务商：

```bash
docker info | grep -A2 "^ *Proxy"     # 会打印 http.docker.internal:3128 吗？
```

如果打印了，说明 Docker 把所有容器流量都走了这个代理，容器的出口就成了代理的地址
而不是你自己的。修法：关掉 Windows 系统代理，并把 Docker Desktop 的代理模式改为
manual 且不填地址（存于 `%APPDATA%\Docker\marlin.dat`，把
`"proxyHTTPMode":{...,"Value":"system"}` 改为 `"manual"`），然后重启 Docker Desktop。

**容器内部无法覆盖它**——`HTTP_PROXY`、`NO_PROXY=*`、`--network host` 全部无效。

完整步骤，以及“所有 Webshare key 同时报 401”其实是 DNS 污染而非 key 失效的情形，
见 [docs/network-egress.md §8.5](docs/network-egress.md)。

### 不要在工作机上跑全量账号池

服务商的限流维度是**出口 IP**，不是账号。无论账号从何而来，单一 IP（尤其是共享机房
IP）上驱动约 340 个账号，本身就是一个异常形态。请把完整账号池留在生产服务器上，
本地只用一个账号做功能验证。

一旦出现风控判定，Chat2API 会自动兜底。`bxpunish` / `RGV587` 判定由出口路径决定，
而非某个特定请求体，所以除了按请求指纹的熔断之外，还有一个**进程级出口熔断**：
当 `CHAT2API_QWEN_AI_EGRESS_CIRCUIT_WINDOW_MS`（默认 5 分钟）窗口内有
`CHAT2API_QWEN_AI_EGRESS_CIRCUIT_THRESHOLD`（默认 3）个**不同请求体**被判风控时，
所有新的 Qwen AI 流量会直接以 `503 qwen_ai_risk_circuit_open` 和 `Retry-After`
拒绝，**在消耗下一个账号之前**就停住。只要有一次上游成功响应即自动关闭，因此修好路由
后能立即恢复，而不必等完整个冷却期。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `CHAT2API_QWEN_AI_EGRESS_CIRCUIT_THRESHOLD` | `3` | 多少个不同请求体被拒后停住整个出口；设为 `0` 则首次判定即停 |
| `CHAT2API_QWEN_AI_EGRESS_CIRCUIT_COOLDOWN_MS` | `600000` | 出口停住的时长 |
| `CHAT2API_QWEN_AI_EGRESS_CIRCUIT_WINDOW_MS` | `300000` | 统计风控判定的时间窗口 |

## 必须配置存储加密密钥

账号凭据在落盘时会被加密。**密钥必须在所有共用同一份数据文件的实例之间保持一致，
并且必须真正传到进程里。**

```bash
CHAT2API_STORAGE_ENCRYPTION_KEY=change-this-to-a-long-random-secret
```

选一次值，固定写在 `.env` 里，桌面端和所有共用该存储的 Docker 部署都用同一个值。

```bash
# 确认密钥已进入进程
docker exec chat2api printenv CHAT2API_STORAGE_ENCRYPTION_KEY
```

> **容器必须用 `docker compose up -d` 启动，不要用 `docker run`。** 用
> `docker run` 创建的容器没有 compose 标签，`docker compose up` 会拒绝接管它，
> `.env` 也就永远不会被注入——进程会在没有密钥的情况下静默运行。

### 如果密钥缺失或与数据不匹配

不会抛任何错。运行时会原样返回 `c2a:v1:…` 密文，于是每个账号都被当成"没有会话"，
修复队列每 25 秒对 339 个账号发起 signin，上游返回 `401 email not found`，
拒绝风暴打开风控闸门（300s → 600s → 1200s → 2400s），最终**包括普通聊天在内的所有
请求都返回 `403 qwen_ai_token_refresh_gated`**。它表现为一次风控故障，实际上是配置错误。

现在启动自检会直接拦住它：

```
[CredentialSelfCheck] Credential data is encrypted (c2a:v1:…) but encryption is
not available. … Set CHAT2API_STORAGE_ENCRYPTION_KEY … and recreate the instance
so the variable actually reaches the process (a container started with `docker run`
never reads .env).
[Store] Initialization aborted: Credential data is encrypted but
CHAT2API_STORAGE_ENCRYPTION_KEY is not usable
```

修好后必须**重建**容器（环境变量只在进程启动时读取一次，`docker restart` 不够）：

```bash
docker compose up -d --force-recreate
```

区分它和真实风控最快的办法——对比两个环境的 session repair 启动行：

```
已损坏:  [QwenAI Session Repair] started ready=0 pending=339
健康:    [QwenAI Session Repair] started ready=339 pending=0
```

`ready=0 pending=339` 说明凭据读不出来，而不是上游在拦你。只有存储确实是明文时，
才用 `CHAT2API_CREDENTIAL_SELF_CHECK=off` 绕过该自检。

## 本地与生产部署注意事项

在同一台机器上让桌面端和 Docker 服务端共用同一批账号，需要多加注意。

| 关注点 | 桌面端（工作机） | Docker（生产） |
| --- | --- | --- |
| 建议账号数量 | 1–3 个，仅做功能验证 | 完整账号池 |
| 出口 | 家宽 IP，不走代理 | 固定服务器 IP，不走代理 |
| 禁止 | 驱动生产账号池，或从本机做压测 | — |

- **不要**让本地实例和生产容器在同时运行时指向同一个 `accounts.json`/`/data` 卷。
  双方会互相覆盖 `status`/`errorMessage` 字段，且各自的修复队列会与对方的判定相互
  干扰。
- **不要**在工作机上做压测或长时间浸泡测试。上游限流是按出口 IP 计的，本机压测损害的
  是生产账号池，而不是在度量代码。
- **不要**在容器运行时直接改数据卷。请先停容器、改完再启动；否则内存态会在下一次保存时
  把你的修改覆盖掉。动手前先备份：
  ```bash
  docker exec chat2api cat /data/data.json > data.json.backup
  ```
- 桌面端会自动应用直连策略；若你在同样配置了代理的主机上跑 Docker 镜像，无头服务端会
  应用同一策略。只有当你**确实希望**该路径经过代理时，才设置
  `CHAT2API_EGRESS_DIRECT=off`。但 Docker 主机仍需配置 Clash 规则，详见
  [docs/network-egress.md](docs/network-egress.md)。

两种长得一样但根因无关的故障，详见
[docs/network-egress.md](docs/network-egress.md#9-symptom--cause)：

| 现象 | 根因 |
| --- | --- |
| 出口显示机房 AS | 本地代理被 Docker Desktop 继承 |
| 所有请求 403、账号"假死" | 存储加密密钥缺失/不匹配 |

另见 2026-09-25 全池故障的复盘：
[docs/diag-2026-09-25-qwen-egress.md](docs/diag-2026-09-25-qwen-egress.md)。

## 截图

| 仪表盘 | 服务商 |
| --- | --- |
| ![仪表盘](docs/screenshots/dashboard.png) | ![服务商](docs/screenshots/providers.png) |

| 代理设置 | API Key |
| --- | --- |
| ![代理设置](docs/screenshots/proxy.png) | ![API Key](docs/screenshots/api-keys.png) |

| 模型管理 | 会话管理 |
| --- | --- |
| ![模型管理](docs/screenshots/models.png) | ![会话管理](docs/screenshots/Session.png) |

## 配置与数据

桌面版数据保存在 `~/.chat2api/`，Docker 版数据保存在挂载的 `/data` 卷中。

| 路径 | 内容 |
| --- | --- |
| `config.json` | 代理、界面和应用设置 |
| `providers.json` | 服务商定义和模型映射 |
| `accounts.json` | 账户凭证和状态 |
| `logs/` | 请求日志 |

服务端支持主机/端口、管理 API、API Key、存储加密、负载均衡、请求超时和服务商专属参数。可从 [docs/docker.md](docs/docker.md) 中的示例开始配置。

## 参与贡献

欢迎提交 Issue、服务商适配、测试和文档改进。进行较大的适配器改动前，请先阅读现有服务商说明并创建 Issue 讨论。

```bash
npm install
npm run build
npm run test:server-compat
```

## 许可证

Chat2API 使用 [GNU General Public License v3.0](LICENSE) 发布。

## 致谢

[Electron](https://www.electronjs.org/)、[React](https://react.dev/)、[TypeScript](https://www.typescriptlang.org/)、[Tailwind CSS](https://tailwindcss.com/)、[Zustand](https://zustand-demo.pmnd.rs/) 和 [Koa](https://koajs.com/)。
