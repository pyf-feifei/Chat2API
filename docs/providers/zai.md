# Z.ai

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | zai |
| 官网 | https://chat.z.ai |
| API Base | https://chat.z.ai/api |
| 认证 | JWT Token |
| 凭据字段 | `token`，可选 `captcha_verify_param` |
| 当前状态 | 受前端验证码风控限制，暂不可用 |

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| GLM-5.1 | GLM-5.1 |
| GLM-5-Turbo | GLM-5-Turbo |
| GLM-5V-Turbo | GLM-5v-Turbo |
| GLM-5 | glm-5 |
| GLM-4.7 | glm-4.7 |

## 适配状态

暂不可用：Z.ai 当前对 `/api/v2/chat/completions` 增加了前端验证码风控校验。Web 页面可用是因为浏览器会运行阿里云 CaptchaJS、生成设备令牌并完成 VerifyCaptchaV3，再把短时有效的 `captcha_verify_param` 带入对话请求。代理侧仅携带 JWT token、Cookie、浏览器 headers 或 HAR 中复制出的旧 `captcha_verify_param`，仍可能返回 `FRONTEND_CAPTCHA_REQUIRED`。

已完成的适配尝试：流式对话、非流式对话、多轮会话、账号级清理对话记录、GLM 系列模型映射、`X-FE-Version: prod-fe-1.1.37`、`X-Region: domestic`、带浏览器环境 query 参数和 token 认证头的 `/api/v2/chat/completions` 请求。

后续方向：需要独立评估真实浏览器辅助模式，让 Z.ai Web 页面自行生成短时验证码参数；在此之前不建议把 Z.ai 作为稳定可用供应商。

## Token 刷新（重新登录）

Z.ai 的登录 JWT **不带 `exp`**，`/api/v1/auths/` 也返回 `expires_at: null` —— 它不会到期，只会被服务端撤销（风控踢线、封号、会话清理）。所以这里说的“刷新”实际是**重新登录换一个新的 JWT**：代理在收到 401/403 时才触发。

刷新由 `scripts/zai-captcha/solve.py --mode signin` 完成：用 Playwright/patchright 打开 Z.ai 的 OAuth 授权页（邮箱登录入口），自动填账号密码，解阿里云滑块验证码，取回 SPA 存下的 JWT。验证码与该浏览器会话的设备指纹绑定，所以整件事必须在同一个浏览器会话里做完 —— 纯 Node 的 axios 请求一定会被拒。

### 验证码是怎么解的

Z.ai 会把图源**先做 inpaint 再渲染**：页面上的 `#aliyunCaptcha-img` 是洞被修补后的图，没有可见缺口。因此：

- **不要**用“找最亮/最强边缘的缺口”那套思路，那是给带暗色缺口的验证码用的，在这里会稳定选到画面最花的地方。
- 现在的做法是找**最平滑的一块**：inpaint 补出来的区域明显比照片平滑（实测洞口 std≈2.8，其他地方≈50）。
- 页面还会把图源画进一个方形画布，留下的**空白边比任何真洞都平滑**，会把答案吸到 x=8 / x=289 这种边缘位置。所以搜索会先排除整列都没内容的窗口（排除不掉时再回退全量扫描，宁可给个噪音答案也不要不拖）。
- 视觉大模型只在本地匹配置信度低时才兜底 —— 实测它对同一张图会给出 360/400/240 三个不同答案，不可靠。

**实测成功率约 1/3 每次尝试**，每次登录最多 3 次尝试，因此单次登录大约 70% 能自动通过；剩下的走人工兜底。

### 人工兜底

自动解失败时，浏览器窗口会保持打开等人手动拖滑块（控制台会打印账号和倒计时）。桌面应用**默认开启**；容器内默认关闭（没人坐在屏幕前），Dockerfile 里已固定 `ZAI_REFRESH_ALLOW_HUMAN=0`。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ZAI_CAPTCHA_SOLVER_PATH` | `/app/scripts/zai-captcha/solve.py` | 求解脚本路径 |
| `ZAI_PYTHON_PATH` | 自动探测 | 指定解释器；设置后不再探测 |
| `ZAI_REFRESH_ALLOW_HUMAN` | 桌面 `1`，容器 `0` | 自动解失败后是否等人手动拖 |
| `ZAI_REFRESH_HUMAN_TIMEOUT` | `180` | 等人拖滑块的秒数 |
| `ZAI_REFRESH_TIMEOUT_MS` | `180000` | 子进程总预算（开人工兜底时自动放宽） |
| `ZAI_REFRESH_MAX_CONCURRENCY` | `1` | 并发刷新数，防止小内存机器 OOM |
| `C2A_RUNTIME` | 未设置 | `docker`/`container` 视为容器；`desktop`/`electron` 视为桌面 |

求解脚本需要 `patchright`、`numpy`、`pillow`。PATH 上第一个 `python` 常常是另一个没装这些包的安装版，启动时会自动探测 `python`/`python3`/`py` 以及常见的 Windows 安装目录，挑第一个能 `import patchright, numpy, PIL` 的；都找不到时报错会直接指明缺哪个包。

## 搜索与思考深度

- 单轮搜索：请求体 `web_search: true`（或 `X-Web-Search: true` 头）映射为 z.ai 的 `features.auto_web_search`。
- 高级搜索（多轮研究）：请求体 `deep_research: true`（或 `X-Deep-Research: true` 头）同时开启搜索与思考，由 z.ai 服务端执行多轮检索分析。
- 思考深度：`reasoning_effort`（`low`/`medium`/`high`；`minimal`/`xhigh` 先归一化）映射为 z.ai Web 的 `features.reasoning_effort`（`low`/`high`/`max`）；未显式指定档位时默认 `max`；`reasoning_effort: false` 关闭深度思考。

## 超长会话传输

内联历史超出 `CHAT2API_ZAI_REQUEST_MAX_BYTES`（默认 `92160` 字节）时，代理将完整会话转录为 `context-<id>.txt` 文档上传，活跃轮仅保留指针句与 8KB 尾部摘录。`CHAT2API_ZAI_TRANSCRIPT_UPLOAD_ENABLED=false` 关闭该 offload、保持完整内联上下文；用户原始附件上传不受影响。

## 工具调用与多轮历史

- z.ai 上游以建会话时的种子消息作为模型上下文；代理把扁平化后的完整历史（含 managed XML 工具调用、工具结果与 workflow 续接提示）作为种子写入新建 chat，保证 tool result 回喂与多轮上下文可达上游。
- 流式/非流式工具拦截统一走 `ToolStreamParser(plan)`（与 GLM 一致），识别 managed 协议并防止包装泄漏。

## 教程

1. 登录 `chat.z.ai`。
2. 打开 DevTools -> Application -> Cookies 或请求头，复制以 `eyJ` 开头的 JWT token。
3. 在供应商管理中添加 Z.ai 账号，填入 `token`。
4. 当前对话接口受验证码风控限制，添加账号不代表可正常完成对话。
5. `captcha_verify_param` 仅保留为调试字段；该值通常短时有效，不能作为长期账号凭据使用。
