# 无限画布 · 服务端额度与管理员改造方案

> 状态：已实施（本地分支 `feat/server-quota-admin`，未推送）
> 性质：**本地改造，仅本地分支提交，不推送、不建 PR、不触发远端 CI**
> 基线：`main` @ `9cd3dea`（v0.20.0 + 2 个文档提交）
> 日期：2026-11-05

---

## 0. 一句话方案

在现有纯前端项目旁边新增一个 **Bun 服务端**：浏览器不再持有 AI API Key，所有生成请求经同源 `/api/relay` 转发到管理员配置的上游渠道；服务端按 **IP + 浏览器指纹** 建立匿名访客身份，按 **每日 / 每周** 校验额度并在窗口边界自动刷新；渠道与 Key 的配置、额度策略、使用记录、访客记录全部收敛到 **仅管理员可访问** 的 `/admin` 与 `/api/admin/*`。普通用户打开网页即可直接生成，无需登录、无需配置。

---

## 1. 需求拆解与验收标准

| # | 用户需求原文 | 需求解读 | 验收标准（可验证） |
| - | --- | --- | --- |
| R1 | 记录 IP 和浏览器指纹 | 服务端为每个匿名访客建立身份记录：IP、浏览器指纹、UA、首次/最近访问、IP 历史 | 管理后台「用户与 IP」列表可见；数据库 `clients` / `client_ips` 有真实行；不登录的普通用户访问后 1 分钟内出现在列表中 |
| R2 | 完成额度的限制 | 图片（生图/图生图）按张消耗日/周额度，由服务端强制拦截；文本不限量（仍记录用量） | 图片额度用尽后接口返回 429（直接 curl 同样被拒），前端提示重置时间；文本生成不受额度拦截 |
| R3 | 限制 1 天 1 周的额度 | 图片额度同时有日（默认 100 张）和周（默认 700 张）两个独立窗口 | 两个限额都生效；任一超限即拒绝；后台可修改数值 |
| R4 | 能完成刷新 | 额度按自然日 / 自然周自动刷新；管理员可手动重置 | 跨过 00:00（可配时区）后日额度恢复；跨周一周额度恢复；后台「重置额度」立即生效；前端展示下次重置时间 |
| R5 | 能完成后端的改造 | 从「纯静态 + 浏览器直连上游」改为「静态前端 + 服务端」 | 新增 `server/`、新镜像可构建、数据持久化（SQLite 数据卷）、健康检查、重启恢复 |
| R6 | 让 API 接入只能管理员访问 | 渠道、Base URL、API Key、模型脚本、额度策略只能管理员配置；普通用户前端拿不到 Key | 普通用户前端所有网络请求中不存在真实 Key；未登录访问 `/api/admin/*` 返回 401；页面无渠道配置入口 |
| R7 | 普通用户访问只用直接进入完成生成 | 匿名直接使用，流程不被打断 | 全新浏览器打开站点 → 直接输入提示词生成成功，无需登录/配置；过程中只出现额度提示 |

**总体验收**（全部满足才算完成）：

1. 普通用户首访 → 生成成功，浏览器 DevTools 中无 `Authorization: Bearer sk-...` 真实 Key、`localStorage` 无 Key。
2. 管理员在 `/admin` 配置渠道后，普通用户可见模型列表变化并能生成。
3. 手动把日额度调成 1，第 2 次生成被 429 拦截，并提示重置时间；把时间/窗口推进到次日，额度恢复。
4. 管理员可看到每个访客的 IP、指纹、今日/本周用量，并可重置单人额度/封禁。
5. 服务重启、容器重建后数据仍在（`./data` 卷）；旧静态部署方式不受影响。
6. `web` 类型检查、单测、构建通过；服务端单测与集成测试通过；Docker 镜像可构建运行。

---

## 2. 现状分析与改造边界

### 2.1 现状链路（改造前）

```
浏览器(React SPA)
  ├─ 渠道配置(含 API Key) ── localStorage: infinite-canvas:ai_config_store
  ├─ 生图/图生图 ─────────────→ [axios/fetch] → 上游 /v1/images/generations · /v1/images/edits
  ├─ 视频 ─────────────────────→ [axios/fetch] → 上游 /v1/videos (+ 轮询)
  ├─ 音频 ─────────────────────→ [axios/fetch] → 上游 /v1/audio/speech
  ├─ 文本/问答 ───────────────→ [fetch SSE]  → 上游 /v1/responses 或 Gemini :generateContent
  └─ 自定义调用脚本 ───────────→ new Function 注入 http/request → 上游（Authorization 由脚本/配置注入）
```

部署形态：`Dockerfile`（bun 构建 `web` → nginx 静态镜像），无任何后端与数据库。

### 2.2 关键代码位置（改造锚点）

| 位置 | 作用 | 改造方式 |
| --- | --- | --- |
| `web/src/stores/use-config-store.ts` | 渠道/模型/Key 与请求辅助（`buildApiUrl:487`、`withLocalProxy:501`、`isAiConfigReady:210`） | 新增 server mode 数据与逻辑；`withLocalProxy` 在 server mode 改为同源中转 |
| `web/src/services/api/image.ts` | 生图/图生图/文本 SSE（`requestGeneration:694`、`requestEdit:754`、`requestImageQuestion:821`） | 不改协议；仅错误/额度反馈接入 |
| `web/src/services/api/video.ts` | 视频任务创建与轮询（`createVideoGenerationTask:72`） | 同上 |
| `web/src/services/api/audio.ts` | TTS（`requestAudioGeneration:23`） | 同上 |
| `web/src/services/api/model-plugin.ts` | 自定义脚本执行，注入 `http/request`（`runModelPlugin:113`） | 依赖 `buildApiUrl/withLocalProxy`，无需改脚本 |
| `web/src/services/file-storage.ts:12`、`image-storage.ts:82` | 媒体资源下载（也走 `withLocalProxy`） | 同源中转自动覆盖 |
| `web/src/components/layout/app-config-modal.tsx` | 配置弹窗（渠道/本地代理/偏好/提示词/WebDAV/本地存储） | server mode 隐藏渠道与本地代理页签，增加额度信息 |
| `web/src/components/layout/client-root-init.tsx` | 启动初始化（URL 参数导入 Key） | server mode 改为引导会话/指纹初始化，禁用 URL 导入 |
| `web/src/components/layout/user-status-actions.tsx` | 顶栏操作（配置、语言、主题、版本） | 增加额度指示器与管理员入口 |
| `Dockerfile`、`docker-compose*.yml`、`nginx.conf` | 部署 | 新增服务端镜像与编排；旧静态镜像保留 |

### 2.3 改造边界（明确不做）

- 不改画布数据结构、画布交互、插件系统、Canvas Agent / MCP 协议、WebDAV 同步。
- 不做用户注册/登录体系（普通用户匿名）；不做计费/支付；不做多租户。
- 不引入 Redis/消息队列/独立数据库服务；不做多实例部署（单实例 SQLite）。
- 不改上游 `Dockerfile` 的静态产物语义（GitHub Pages / Vercel / Render / 上游 GHCR 镜像继续以「静态模式」工作）。
- **不推送、不建 PR、不触发远端 CI**；只做本地分支提交。

### 2.4 双模式兼容策略

前端启动时请求 `GET /api/bootstrap`：

- 200 → **服务端模式**：使用服务端渠道（Key 为空占位）、隐藏渠道配置、启用额度。
- 404 / 超时 / 非 JSON → **静态模式**：保持现有行为（浏览器本地配置、直连上游）。

同一份前端产物即可同时支持两种部署，避免破坏开源项目的静态发布能力。

---

## 3. 总体架构

```
┌─────────────────────────── 浏览器（普通用户） ───────────────────────────┐
│ React SPA（静态产物，无 Key）                                             │
│  ├─ POST /api/session/fingerprint  ← 指纹 visitorId（FingerprintJS OSS）   │
│  ├─ GET  /api/bootstrap            ← 公共模型列表 / 额度状态 / 公共设置    │
│  ├─ 生成请求 → /api/relay?url=<encoded 上游URL>（同源，带会话 Cookie）     │
│  └─ 额度展示 / 429 处理                                                   │
└───────────────────────────────────┬──────────────────────────────────────┘
                                    │ same-origin
┌───────────────────────────────────▼──────────────────────────────────────┐
│ Bun 服务端（单进程，监听 3000）                                           │
│  ├─ 静态托管 web/dist（SPA fallback；/config.js 运行时生成）               │
│  ├─ /api/bootstrap · /api/session/fingerprint · /api/quota · /api/health  │
│  ├─ /api/relay        → 校验身份/白名单/模型/额度 → 注入 Key → 上游 → 透传 │
│  ├─ /api/admin/*      → 管理员会话校验（渠道/额度策略/统计/访客/设置）     │
│  ├─ 身份模块：IP(XFF 可配) + FingerprintJS visitorId + 签名 Cookie         │
│  ├─ 额度模块：日/周窗口、预占→提交/释放、按 IP 与访客双维度上限            │
│  ├─ 安全模块：Bun.password(argon2id)、AES-256-GCM 加密 Key、限流、防 SSRF  │
│  └─ SQLite（data/app.db，WAL）                                            │
└───────────────────────────────────┬──────────────────────────────────────┘
                                    │ HTTPS/HTTP（Key 仅存在于服务端）
┌───────────────────────────────────▼──────────────────────────────────────┐
│ 上游 AI 渠道（管理员配置）：OpenAI 兼容 / Gemini 兼容 / 自建中转          │
└──────────────────────────────────────────────────────────────────────────┘

管理员浏览器 → /admin（登录页 → 管理面板） → /api/admin/*（HttpOnly 会话 Cookie）
```

### 3.1 请求链路差异

| 场景 | 改造前 | 改造后（服务端模式） |
| --- | --- | --- |
| 生图 | 浏览器 → 上游（带 Key） | 浏览器 → `/api/relay?url=<上游URL>` → 服务端校验额度 → 注入 Key → 上游 |
| 渠道配置 | 浏览器 localStorage | 服务端数据库，仅管理员接口可写 |
| 身份 | 无 | 签名 Cookie + 指纹 + IP 记录，匿名 |
| 额度 | 无 | 日/周单位额度，服务端强制执行，SSE/大文件请求同样受限 |

### 3.2 组件清单

| 组件 | 技术 | 说明 |
| --- | --- | --- |
| `server/` | Bun 1.3 + TypeScript + `Bun.serve` + `bun:sqlite` + `node:crypto` | 单进程 HTTP 服务、静态托管、API |
| 数据库 | SQLite（WAL 模式） | 渠道、访客、用量、管理员会话、审计 |
| 前端指纹 | 无新增依赖（内置实现） | canvas/WebGL/UA/屏幕/时区/语言 → SHA-256 稳定指纹；后续可接 FingerprintJS OSS 增强 |
| 部署 | `Dockerfile.server` + `docker-compose.local.yml` + `data/` 卷 | 本机构建运行，不推送镜像 |

选型理由：

- 仓库已全面使用 Bun（`web` 构建、`bun test`、Docker 构建阶段），服务端沿用 Bun 可复用同一镜像与工具链，`bun:sqlite` 免原生依赖。
- 不引入 Express/Fastify：路由面约 25 条，`Bun.serve` 内置路由 + 少量工具函数即可，符合项目「代码尽量短小」的约定；若后续膨胀再评估引入 Hono。
- SQLite 单文件便于备份迁移；单实例部署足够（本方案明确不支持多实例）。

---

## 4. 身份识别：IP + 浏览器指纹

### 4.1 采集

1. 页面启动时用内置轻量指纹算法采集：canvas 2D 绘制结果、WebGL vendor/renderer、`userAgent`、`language`、`timezone`、`screen`、`hardwareConcurrency`、`deviceMemory` → `crypto.subtle.digest("SHA-256", ...)` 得到稳定 `visitorId`（无新增依赖；后续如需更强指纹可替换为 FingerprintJS OSS）。
2. `POST /api/session/fingerprint`：请求体 `{ visitorId, source: "builtin" | "fingerprintjs", ua, lang, timezone }`；服务端创建或合并 `clients` 记录、写入 `client_ips`，并下发签名 Cookie。

### 4.2 身份凭证

- Cookie 名 `ic_client`，值 = `clientId.HMAC-SHA256(clientId)`，`HttpOnly; SameSite=Lax; Path=/; Max-Age=180d`，HTTPS 下追加 `Secure`。
- 服务端以 Cookie 中的 `clientId` 为主键做额度归属；**指纹作为记录与辅助绑定**：Cookie 丢失但指纹相同 → 复用既有 client 记录（避免误伤），并更新指纹/UA。
- IP 不作为额度主键（防误伤 / 防重置），但参与记录展示与「按 IP 的附加上限」。

### 4.3 IP 来源与真实 IP

- 默认取 TCP 连接对端 IP；`TRUST_PROXY=1` 时取 `X-Forwarded-For` 最右侧不可信条目（并校验为合法 IP）。
- **已知限制**：Docker Desktop（macOS）端口映射下，容器看到的客户端 IP 常为网关地址（本机实测 nginx 日志为 `192.168.65.1`），无法还原局域网真实 IP。方案：
  - 本机/局域网使用：指纹为主，IP 记录为「容器视角」，后台注明；
  - 需要真实 IP：宿主机进程运行（不经 Docker）、Docker `--network host`（受 Docker Desktop 版本限制）、或部署到 Linux 服务器 / 前置反向代理（配 `TRUST_PROXY=1`）。
- 后台记录 `X-Forwarded-For` 原始链（截断 512 字符）与 `remote_addr` 以便排查。

### 4.4 隐私与限制

- 仅用于额度与滥用治理；不做跨站追踪，不做广告用途；保留期默认 90 天（可配）。
- 指纹/多浏览器/VPN 均可绕过单访客额度，因此叠加「按 IP 上限」（见 §5.4）；这是启发式治理，不承诺绝对防刷。

---

## 5. 额度系统

### 5.1 计量单位与默认额度（按能力独立，均可后台修改）

> 用户确认口径（2026-11-05）：**文本不限；图片每日 100 张；单次生成张数不额外限制**（沿用现有界面 1–15 的上限，服务端按 `n` 计入日/周用量）。周额度默认取 7 倍日额度；`0` 表示不限额（仍记录用量、仍受频率限流）。

| 能力 | 计数单位 | 日额度（默认） | 周额度（默认） |
| --- | --- | --- | --- |
| 生图 | 张（按请求体 `n`） | 100 | 700 |
| 图生图 | 张（按 multipart `n`） | 100 | 700 |
| 文本/问答 | 次 | 不限（0） | 不限（0） |
| 视频 | 次 | 不限（0，建议后台按渠道成本再设） | 不限（0） |
| 音频 | 次 | 不限（0） | 不限（0） |
| 查询/轮询/模型列表/媒体下载 | — | 不计入 | 不计入 |

- 「生图」与「图生图」共用同一个「图片」额度。
- 限额为 `0` 的能力不做额度拦截，但**仍写入 `usage_events`**（后台统计/审计用），仍受频率限流。
- 计费点必须由服务端从请求本身解析，**不信任**前端传入的 units / capability。

### 5.2 窗口与刷新

- 日窗口：按 `QUOTA_TIMEZONE`（默认 `Asia/Shanghai`）的自然日，起点 00:00。
- 周窗口：ISO 周（周一 00:00 起）。
- **惰性窗口**：不依赖定时任务，每次请求按 `created_at >= windowStart` 实时统计，因此「刷新」是到点自然恢复；重启/时钟变更不会丢语义。
- 可选维护任务：每日清理超出保留期的 `usage_events`（默认 90 天）。
- 默认额度：**图片 100 张/日、700 张/周**；文本/视频/音频默认不限额；管理员可随时修改、对单人/单 IP/全局手动重置。
- 响应中附带 `resetAt`（ISO 时间，前端展示倒计时），使「刷新」对用户可见。

### 5.3 预占 → 提交 / 释放（服务端强制）

```
POST /api/relay
  1. 身份校验（Cookie）→ clientId、ip
  2. 白名单校验（目标 URL 必须匹配已启用渠道的 Base URL 前缀；媒体 GET 走 §6.5.6）
  3. 解析请求体 → capability / model / units（见 §5.1、§6.5.4）
  4. 额度预占（SQLite 事务，按 capability 分别校验）:
       该能力日上限 > 0 且 日已用(committed+reserved) + units > 日上限 → 拒绝
       该能力周上限 > 0 且 周已用(committed+reserved) + units > 周上限 → 拒绝
       IP 维度同样校验（§5.4，默认关闭）
       → 不通过：429 { code:"quota_exceeded", scope:"daily"|"weekly", capability, resetAt, usage:{...} }
  5. 转发上游（注入 Key；流式透传）
  6. 结算:
       上游 2xx                        → committed（已扣额度）
       上游 4xx/5xx / 网络错误 / 超时   → released（不扣）
       客户端在上游 2xx 前断开          → released（尽力，进程内保证）
       客户端在上游 2xx 后断开          → committed（已产生成本，不退）
```

- 并发安全：额度预占与结算使用 `bun:sqlite` 同步事务；单进程事件循环内先预占再 `await`，避免并发超额。
- 额度统计只计入 `reserved` + `committed`，`released` 不计。
- 管理后台可对任意 client / IP / 全局做「清零当前日/周用量」（写一条 `quota_adjustments` 调整记录或直接标记相关事件作废，保留审计）。

### 5.4 多维度上限（防指纹切换）

| 维度 | 默认 | 说明 |
| --- | --- | --- |
| 每访客：按能力日/周额度 | 图片 100 / 700；文本、视频、音频不限 | 主额度（R3） |
| 每 IP：图片日/周上限 | 0（关闭） | 辅助，默认关闭（避免局域网 NAT 误伤）；后台可开启，例如 200 / 1400 |
| 每 IP：文本/视频/音频 | 仅频率限流 | 不设额度维度上限 |
| 管理员白名单 | 无 | 管理员会话请求不占额度（可配） |

### 5.5 前端额度 UX

- 顶栏额度胶囊：只展示**设了限额的能力**（默认 `今日图片 12/100 · 本周 45/700`），悬浮显示下次重置时间与分能力消耗；文本/视频/音频不限额时不展示对应额度。
- 生成前若该能力额度已耗尽：直接提示「今日图片额度已用完（100/100），将于 X 小时 Y 分钟后重置」，不发请求。
- 服务端 429 兜底：现有错误提示链路展示服务端返回的 `error.message`；同时刷新额度状态。
- 生成完成后刷新额度（`GET /api/quota`）；页面可见时每 60s 静默刷新一次。

---

## 6. 服务端设计

### 6.1 目录结构

```
server/
  package.json                 # name: infinite-canvas-server, private
  tsconfig.json
  src/
    index.ts                   # 入口：启动、路由挂载、优雅退出
    config.ts                  # 环境变量解析与默认值
    db.ts                      # SQLite 打开、迁移、事务工具
    schema.sql                 # 建表语句（版本化迁移）
    http.ts                    # 路由、JSON 响应、Cookie、错误类型、请求ID
    identity.ts                # 指纹归一化、签名 Cookie、访客 upsert、IP 记录
    quota.ts                   # 窗口计算、预占/结算/释放、手动重置、统计
    relay.ts                   # 白名单、请求体解析、能力/单位推断、上游转发、流式透传
    admin.ts                   # 管理员登录/会话/渠道/策略/统计/访客接口
    public.ts                  # bootstrap / fingerprint / quota / health
    static.ts                  # 静态托管、SPA fallback、运行时 config.js
    security.ts                # 密码哈希、AES-GCM、限流、Origin 校验、SSRF 防护
    logger.ts                  # 结构化日志（不落 Key）
  tests/
    quota.test.ts              # 窗口边界、预占/释放、并发
    relay.test.ts              # 白名单/单位推断/SSRF/Key 注入（假上游）
    auth.test.ts               # 登录限流、会话、Cookie 签名
    fixtures/mock-upstream.ts  # 本地假上游（OpenAI/Gemini 兼容最小实现）
```

### 6.2 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `DATA_DIR` | `./data` | SQLite 与会话密钥目录 |
| `ADMIN_USERNAME` | `admin` | 管理员账号（仅首次初始化使用） |
| `ADMIN_PASSWORD` | 无（缺省时随机生成并打印一次） | 首次启动写入哈希；之后以数据库为准 |
| `SESSION_SECRET` | 自动生成并持久化 `data/secret.key`（0600） | Cookie 签名 / Key 加密主密钥派生 |
| `TRUST_PROXY` | `0` | 0=忽略 XFF；1=可信一层反代取真实 IP |
| `TZ` / `QUOTA_TIMEZONE` | `Asia/Shanghai` | 额度窗口时区 |
| `QUOTA_IMAGE_DAILY_LIMIT` | `100` | 每访客图片日额度（0=不限；首启种子，之后以数据库为准） |
| `QUOTA_IMAGE_WEEKLY_LIMIT` | `700` | 每访客图片周额度 |
| `QUOTA_TEXT_DAILY_LIMIT` / `QUOTA_VIDEO_DAILY_LIMIT` / `QUOTA_AUDIO_DAILY_LIMIT` | `0` | 其它能力日额度（0=不限） |
| `QUOTA_IMAGE_IP_DAILY_LIMIT` / `QUOTA_IMAGE_IP_WEEKLY_LIMIT` | `0` | 每 IP 图片上限（0=关闭） |
| `RELAY_MAX_BODY_MB` | `128` | 中转请求体上限（图生图/视频参考素材） |
| `RELAY_TIMEOUT_MS` | `600000` | 上游请求超时（生图/视频默认 10 分钟） |
| `ANALYTICS_GA4_ID` / `ANALYTICS_BAIDU_ID` | 空 | 保留原运行时统计配置 |

安全要求：`.env` 不入库；镜像/仓库不包含任何真实 Key。

### 6.3 数据模型（SQLite）

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE settings (            -- 键值配置（策略/公共设置/管理员密码哈希/版本）
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE schema_meta (         -- 迁移版本
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,                 -- 例如 https://api.openai.com 或 https://x/v1
  api_key_cipher TEXT NOT NULL DEFAULT '',-- AES-256-GCM(apiKey)
  api_format TEXT NOT NULL DEFAULT 'openai', -- openai | gemini
  enabled INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE channel_models (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  capability TEXT NOT NULL,               -- image | video | text | audio
  script TEXT,                            -- 自定义调用脚本（沿用现有脚本格式）
  sort INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, name)
);

CREATE TABLE clients (
  id TEXT PRIMARY KEY,                    -- 服务端生成的访客 ID
  fingerprint TEXT NOT NULL,              -- FingerprintJS visitorId / 兜底哈希
  fingerprint_source TEXT NOT NULL DEFAULT 'builtin',
  user_agent TEXT NOT NULL DEFAULT '',
  first_ip TEXT NOT NULL DEFAULT '',
  last_ip TEXT NOT NULL DEFAULT '',
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  blocked INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_clients_last_seen ON clients(last_seen_at DESC);
CREATE INDEX idx_clients_fp ON clients(fingerprint);

CREATE TABLE client_ips (                 -- 访客 IP 历史（记录 IPv4/IPv6）
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  ip TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (client_id, ip)
);

CREATE TABLE usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  ip TEXT NOT NULL,
  fingerprint TEXT NOT NULL DEFAULT '',
  capability TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  endpoint TEXT NOT NULL DEFAULT '',      -- 上游路径（不含 Key）
  units INTEGER NOT NULL,
  state TEXT NOT NULL,                    -- reserved | committed | released
  upstream_status INTEGER,
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX idx_usage_client_time ON usage_events(client_id, created_at);
CREATE INDEX idx_usage_ip_time ON usage_events(ip, created_at);
CREATE INDEX idx_usage_time ON usage_events(created_at);
CREATE INDEX idx_usage_state ON usage_events(state);

CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,            -- SHA-256(token)；原始 token 只在 Cookie
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE admin_login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  success INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,                    -- admin
  action TEXT NOT NULL,                   -- login / channel.update / quota.reset / client.block ...
  detail TEXT NOT NULL DEFAULT '',        -- JSON（不含密钥）
  ip TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
```

### 6.4 API 设计

#### 公共接口（无需登录）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查：`{ ok, version, uptime }` |
| GET | `/api/bootstrap` | 服务端模式标志、公共模型列表（不含 Key）、默认模型、额度快照、公共设置、`admin` 标记 |
| POST | `/api/session/fingerprint` | 上报 fingerprint visitorId，创建/合并访客，下发 `ic_client` Cookie，返回额度 |
| GET | `/api/quota` | 当前访客额度用量、上限、重置时间、是否被封禁 |
| ALL | `/api/relay?url=<encoded>` | 受控中转（见 §6.5）；要求有效 `ic_client` Cookie |

`GET /api/bootstrap` 响应示例：

```json
{
  "serverMode": true,
  "version": "0.20.0",
  "channels": [
    { "id": "ch_xxx", "name": "OpenAI", "apiFormat": "openai",
      "models": [ { "name": "gpt-image-2", "capability": "image" } ] }
  ],
  "defaultModels": { "imageModel": "ch_xxx::gpt-image-2", "videoModel": "...", "textModel": "...", "audioModel": "..." },
  "quota": {
    "policy": {
      "image": { "dailyLimit": 100, "weeklyLimit": 700 },
      "text": { "dailyLimit": 0, "weeklyLimit": 0 },
      "video": { "dailyLimit": 0, "weeklyLimit": 0 },
      "audio": { "dailyLimit": 0, "weeklyLimit": 0 }
    },
    "usage": {
      "image": { "dailyUsed": 12, "weeklyUsed": 45 },
      "text": { "dailyUsed": 0, "weeklyUsed": 0 }
    },
    "dailyResetAt": "2026-11-06T00:00:00+08:00",
    "weeklyResetAt": "2026-11-09T00:00:00+08:00",
    "exempt": false
  },
  "publicSettings": { "allowModelSelection": true, "announcement": "" },
  "admin": false
}
```

#### 中转响应头（每个 relay 响应）

```
X-Quota-Image-Daily-Used / X-Quota-Image-Daily-Limit
X-Quota-Image-Weekly-Used / X-Quota-Image-Weekly-Limit
X-Quota-Daily-Reset-At / X-Quota-Weekly-Reset-At
```

429 响应体（同时兼容现有 OpenAI 风格错误解析）：

```json
{ "error": { "message": "今日图片额度已用完（100/100），将于 2026-11-06 00:00 重置" },
  "code": "quota_exceeded", "scope": "daily", "capability": "image",
  "quota": { "capability": "image", "dailyUsed": 100, "dailyLimit": 100,
             "weeklyUsed": 45, "weeklyLimit": 700,
             "dailyResetAt": "2026-11-06T00:00:00+08:00", "weeklyResetAt": "2026-11-09T00:00:00+08:00" } }
```

#### 管理接口（`ic_admin` 会话 Cookie）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/login` | `{username,password}` → 会话 Cookie；限流 |
| POST | `/api/admin/logout` | 注销当前会话 |
| GET | `/api/admin/session` | 当前管理员信息（用于路由守卫） |
| GET | `/api/admin/overview` | 今日/本周总用量、访客数、渠道数、服务信息 |
| GET / PUT | `/api/admin/channels` | 渠道+模型 CRUD（整表保存；Key 传空=保持旧值；返回掩码） |
| POST | `/api/admin/channels/test` | 用临时 baseUrl/key 拉取模型列表（验证连通性；不落库） |
| GET / PUT | `/api/admin/quota-policy` | 日/周上限、权重、IP 上限、时区、管理员豁免、失败是否退款 |
| GET | `/api/admin/usage` | 用量聚合（按天/能力/访客）+ 最近事件 |
| GET | `/api/admin/clients` | 访客列表（分页/搜索：IP、指纹、UA、今日/本周用量、封禁态） |
| GET | `/api/admin/clients/:id/events` | 单访客事件明细 |
| POST | `/api/admin/clients/:id/reset-quota` | `{scope: "daily"|"weekly"|"all"}` 手动重置 |
| POST | `/api/admin/clients/:id/block` | `{blocked: true|false}` 封禁/解封 |
| POST | `/api/admin/quota/reset-all` | 全局重置（scope 同上） |
| GET / PUT | `/api/admin/settings` | 公告、是否允许选择模型、数据保留天数 |
| POST | `/api/admin/password` | `{oldPassword,newPassword}` 修改管理员密码 |

鉴权失败：`401 { error: { message } , code: "admin_required" }`；无权限操作记 `audit_logs`。

### 6.5 中转代理设计（核心）

#### 6.5.1 URL 形态

沿用前端现有「本地代理」抽象，最小心智负担：

```
浏览器请求:  /api/relay?url=https%3A%2F%2Fapi.openai.com%2Fv1%2Fimages%2Fgenerations
服务端转发:  https://api.openai.com/v1/images/generations
```

前端只需把 `withLocalProxy(url)` 在服务端模式下改为返回 `/api/relay?url=${encodeURIComponent(url)}`，所有现存 axios/fetch/自定义脚本路径统一生效，无需逐处改造（现有 7 处调用点见 §7.3）。

#### 6.5.2 身份与权限

- 必须携带有效 `ic_client` Cookie（否则 401 `session_required`）；被 `blocked` 的访客 403。
- 仅允许同源调用（校验 `Origin`/`Referer` 与站点同源，或缺失时按 Cookie SameSite 处理）。
- 黑名单 HTTP 方法：`CONNECT/TRACE`；其余方法透传。

#### 6.5.3 目标白名单（防 SSRF / 防滥用）

- 目标 URL 必须满足：`http(s)` 且以某「已启用渠道」的 `base_url` 为前缀（规范化后比较：去尾部 `/`、协议+主机+路径前缀匹配）。
- 明确拒绝：`file:`、`ftp:`、带 userinfo 的 URL、私网/回环/链路本地/元数据地址（除非该地址恰好是管理员配置的渠道，例如本机 `http://host.docker.internal:3000`，由管理员显式配置即视为可信）。
- 媒体资源（上游返回的图片/视频/音频绝对 URL）例外规则见 §6.5.6。
- 未命中白名单：`403 { code: "relay_target_not_allowed" }`。

#### 6.5.4 模型与单位推断（服务端权威）

| 请求特征 | capability | units |
| --- | --- | --- |
| `POST * /images/generations` | image | `clamp(body.n ?? 1, 1, 15)` |
| `POST * /images/edits` | image | `clamp(formData.n ?? 1, 1, 15)`（解析 multipart 字段，不读文件内容到内存之外的额外副本） |
| `POST * /videos` | video | 1 × 视频权重 |
| `POST * /audio/speech` | audio | 1 × 音频权重 |
| `POST * /responses` 或 `/chat/completions` | text | 1 × 文本权重 |
| `POST * :predictLongRunning`（Gemini 视频） | video | 1 |
| `POST * :generateContent` | 按 `body.generationConfig.responseModalities` 含 `AUDIO`→audio；否则按路径模型能力；未知→text | 1 |
| 其他 `POST/PUT/PATCH` | 由 body.model 在渠道模型表反查；未知→text | 1 |
| `GET/HEAD/OPTIONS` | — | 0 |

- 请求体在 `RELAY_MAX_BODY_MB` 内缓冲以便解析；超限 413。
- 若解析出 `model` 且该渠道未配置该模型 → `400 model_not_available`（防止借管理员 Key 调用未授权模型）。自定义脚本调用无 model 字段的接口时不强制。

#### 6.5.5 Key 注入与请求清理

- 从入站请求移除：`Authorization`、`x-goog-api-key`、`Cookie`、`Host`、`Content-Length`、逐跳头（Connection/Keep-Alive/Transfer-Encoding/Upgrade/Proxy-*）、`Origin`/`Referer` 中不必要的追踪头。
- 根据渠道 `api_format` 注入：
  - `openai`：`Authorization: Bearer <解密后的 key>`
  - `gemini`：`x-goog-api-key: <key>`
- 其余头（自定义脚本可能需要的 `x-*`、`OpenAI-Beta` 等）透传；`Content-Type` 保留。
- 真实 Key 只在服务端内存/加密列中出现，绝不返回前端。

#### 6.5.6 流式与媒体

- 上游响应：保留状态码、`Content-Type`、`Cache-Control` 等，body 以流式转发（SSE 不缓冲；`text/event-stream` 直接 `ReadableStream` 转发）。
- 上游请求超时默认 600s；客户端断开触发 `AbortController` 取消上游。
- 媒体 URL（`GET`、非渠道前缀）：允许 `https` 公网地址，HTTP(S) 解析前做 DNS 解析并拒绝私网/回环/链路本地/IPv6 ULA/元数据地址；仅 `GET/HEAD`；内容类型限定图片/视频/音频/octet-stream；大小上限（默认 512MB）与超时（120s）防止资源滥用；同一用户同时最多 2 个媒体转发。
- 重定向最多 5 跳，每跳重新校验白名单/SSRF 规则（不得重定向到私网）。

#### 6.5.7 错误与日志

- 上游错误原样透传（前端现有错误解析继续生效）。
- 服务端错误统一 `{ error: { message }, code }`；额度错误见 §5.5。
- 日志：请求 ID、方法、目标 host+path（**不含 query 中的敏感值**，必要时截断/打码）、状态码、耗时、clientId、units；不记录请求头/请求体；Key 永不落日志。

### 6.6 管理员鉴权

- 首次启动：读取 `ADMIN_USERNAME` + `ADMIN_PASSWORD`，用 `Bun.password.hash`（argon2id）写入 `settings`；若未提供 `ADMIN_PASSWORD`，生成 16 位随机密码并在启动日志打印一次（仅打印一次，提示立即修改）。
- 登录：校验哈希；成功创建 32 字节随机 token，DB 存 `SHA-256(token)`；Cookie `ic_admin`：`HttpOnly; SameSite=Strict; Path=/; Max-Age=7d`（HTTPS 下 `Secure`）；滑动刷新最近使用时间。
- 限流：同 IP 每分钟 5 次、每小时 10 次失败即锁定 15 分钟；成功登录重置。
- CSRF：管理接口非 GET 请求校验 `Origin`/`Referer` 同源；Cookie `SameSite=Strict` 兜底。
- 修改密码后吊销其他会话；退出登录删除 session 行。
- 管理接口全部先过会话校验；`audit_logs` 记录登录、渠道变更、额度策略变更、重置、封禁。

### 6.7 密钥与配置存储

- 渠道 API Key 用 AES-256-GCM 加密存 `api_key_cipher`；主密钥来自 `SESSION_SECRET` 的 HKDF 派生（或自动生成并持久化的 `data/secret.key`）。
- 管理接口返回掩码（如 `sk-****3f2a`）；保存时 `apiKey` 为空字符串表示保留原值。
- 服务端配置为唯一数据源；前端不再持久化真实渠道 Key。管理员可在后台导出/导入渠道配置（可选 P2）。

### 6.8 静态托管与运行时配置

- Bun 直接托管 `web/dist`：命中文件返回文件（`assets/*` 加 `Cache-Control: public, max-age=31536000, immutable`），未命中回退 `index.html`（SPA）。
- `/config.js` 动态生成：`window.__RUNTIME_CONFIG__ = { ANALYTICS_GA4_ID, ANALYTICS_BAIDU_ID, SERVER_MODE: true }`，并保证前端能识别服务端模式（也可仅依赖 `/api/bootstrap` 探测，两者取其一，实现时以 bootstrap 为准，config.js 仅保留统计配置）。

---

## 7. 前端改造

### 7.1 启动流程

```
main.tsx → AppProviders → ClientRootInit
  ├─ 静态模式（默认，立即可渲染）
  └─ 探测 GET /api/bootstrap（3s 超时）
       ├─ 成功 → 写入 server mode 状态
       │    ├─ 懒加载 FingerprintJS → POST /api/session/fingerprint
       │    ├─ 用服务端渠道覆盖 config.channels（apiKey 用占位符）
       │    ├─ 同步额度 → 展示顶栏额度
       │    └─ 校验 URL 参数导入 Key：服务端模式直接忽略并提示“由管理员统一配置”
       └─ 失败 → 保持静态模式（现有行为，localStorage 配置继续可用）
```

### 7.2 配置 store 改造（`web/src/stores/use-config-store.ts`）

新增字段（不参与受保护持久化）：

```ts
type ServerChannel = { id: string; name: string; apiFormat: ApiCallFormat; models: ChannelModel[] };
type ServerModeState = {
  serverMode: boolean;          // 是否服务端模式
  bootstrapped: boolean;
  serverChannels: ServerChannel[];
  publicSettings: { allowModelSelection: boolean; announcement: string };
  isAdmin: boolean;
};
```

- `hydrateFromServer(bootstrap)`：写 `config.channels`（`baseUrl` 用真实上游地址，`apiKey = SERVER_MANAGED_KEY = "__server_managed__"`）、`config.models`、默认模型、`channelMode: "local"`；`proxyEnabled: false`。
- `withLocalProxy(url)`（`:501`）：优先判断 `serverMode` → 返回 `/api/relay?url=...`；否则保持现有本地代理逻辑。
- `isAiConfigReady`（`:210`）：服务端模式下只要服务端渠道存在且模型可见即视为就绪（占位 Key 使现有判断自然通过）。
- `persist.partialize`：服务端模式下不持久化 `channels`（避免旧 Key/旧渠道残留）；只保留用户偏好。静态模式保持原样。
- `config-file.ts` 导出/导入：服务端模式剔除渠道与 Key（仅导出用户偏好）；导入忽略渠道字段。
- 自定义脚本：脚本文本随 bootstrap 下发（管理员编写，不含 Key）；脚本内 `http/request` 走 `buildApiUrl`/`withLocalProxy`，自动经中转，Key 由服务端注入。

### 7.3 请求层改造

| 文件 | 改动 |
| --- | --- |
| `use-config-store.ts:501` `withLocalProxy` | 服务端模式返回 `/api/relay?url=`，其余逻辑不变 |
| `image.ts:313/317/334`、`video.ts:35/39`、`audio.ts:12/16` | 无需改协议；`aiHeaders` 在服务端模式发送占位 Key（服务端会剥离并注入），或直接保留（服务端覆盖） |
| `image.ts`、`video.ts`、`audio.ts` 的 `readAxiosError`/错误解析 | 识别 `code:"quota_exceeded"` → 触发额度刷新 + 友好提示（服务端 message 已可直接展示） |
| `file-storage.ts:12`、`image-storage.ts:82` | 由 `withLocalProxy` 自动覆盖 |
| `model-plugin.ts` | 无需改动（依赖 `buildApiUrl`/`withLocalProxy`） |

### 7.4 UI 改造

1. **顶栏**（`user-status-actions.tsx`）：新增额度指示器（仅服务端模式）；管理员会话时显示「管理后台」入口（盾牌图标）。
2. **配置弹窗**（`app-config-modal.tsx`）：
   - 服务端模式隐藏「渠道」「本地代理」页签；
   - 新增「额度」区块：今日/本周用量、重置时间、分能力消耗；
   - 静态模式维持现状（本地开发/静态部署可用）。
3. **额度提示**：生成前快速预检、429 兜底提示、额度详情弹窗、封禁提示。
4. **管理后台** `/admin`（新页面，仅管理员）：
   - 未登录：登录表单（账号/密码、错误次数提示）；
   - 已登录：左侧/顶部页签：
     - 概览（今日/本周用量、访客数、最近事件）
     - 渠道管理（增删改渠道、Key 掩码输入、模型能力/脚本编辑、测试连通性/拉取模型）
     - 额度策略（按能力设置日/周额度，默认图片 100/700、文本/视频/音频不限；IP 上限、时区、失败退款、管理员豁免）
     - 使用统计（今日/7 天，按能力/访客聚合表格）
     - 用户与 IP（访客列表：指纹、IP 历史、UA、今日/本周用量、封禁/重置）
     - 系统设置（修改密码、公告、模型选择开关、保留天数、服务版本）
5. **路由**：`web/src/router.tsx` 增加 `/admin`；该页独立布局（不套用户导航或使用极简头部）。

### 7.5 新增/修改文件清单

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `server/**`（约 15 个文件） | 新增 | 见 §6.1 |
| `web/package.json` | 不变 | 指纹用内置实现，不新增依赖 |
| `web/src/stores/use-config-store.ts` | 修改 | 服务端模式状态、hydrate、withLocalProxy、持久化过滤 |
| `web/src/stores/use-quota-store.ts` | 新增 | 额度状态、刷新、headers/429 同步 |
| `web/src/services/api/server.ts` | 新增 | bootstrap/session/quota/admin 客户端封装 |
| `web/src/types/server.ts` | 新增 | 服务端契约类型 |
| `web/src/services/api/image.ts` / `video.ts` / `audio.ts` | 小改 | 额度错误识别与刷新 |
| `web/src/services/config-file.ts` | 修改 | 服务端模式导出/导入过滤渠道 |
| `web/src/components/layout/client-root-init.tsx` | 修改 | 启动探测、指纹上报、URL 参数禁用 |
| `web/src/components/layout/quota-indicator.tsx` | 新增 | 顶栏额度胶囊 + 详情弹窗 |
| `web/src/components/layout/app-config-modal.tsx` | 修改 | 页签过滤、额度区块 |
| `web/src/components/layout/user-status-actions.tsx` | 修改 | 额度展示、管理员入口 |
| `web/src/pages/admin/index.tsx` + `web/src/pages/admin/components/*` | 新增 | 管理后台（约 6-7 个组件） |
| `web/src/router.tsx` | 修改 | 增加 `/admin` |
| `web/src/i18n/locales/zh-CN.ts` / `en-US.ts` | 修改 | 新增服务端/额度/管理文案（中英） |
| `web/src/services/api/local-proxy.ts` | 保持 | 静态模式继续使用；服务端模式隐藏入口 |

### 7.6 文案与国际化

所有新增 UI 文案同时补充 `zh-CN` 与 `en-US`，命名空间建议：

```
server: { quota: {...}, admin: {...}, errors: {...} }
```

---

## 8. 部署改造

### 8.1 镜像

新增 `Dockerfile.server`（**不改动原 `Dockerfile`**，保持上游静态镜像语义）：

```dockerfile
# stage 1: 构建前端（与现有 Dockerfile 相同）
FROM oven/bun:1.3.13 AS web-build
WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN bun run build

# stage 2: 服务端依赖
FROM oven/bun:1.3.13 AS server-deps
WORKDIR /app/server
COPY server/package.json server/bun.lock* ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --production

# stage 3: 运行
FROM oven/bun:1.3.13
WORKDIR /app
COPY --from=web-build /app/web/dist ./web/dist
COPY server ./server
COPY --from=server-deps /app/server/node_modules ./server/node_modules
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data
RUN mkdir -p /app/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["bun", "run", "server/src/index.ts"]
```

### 8.2 编排（本地构建，不推送镜像）

`docker-compose.local.yml` 改为：

```yaml
services:
  app:
    image: infinite-canvas:server
    build:
      context: .
      dockerfile: Dockerfile.server
    container_name: infinite-canvas
    ports:
      - "3002:3000"
    restart: unless-stopped
    env_file:
      - .env            # ADMIN_PASSWORD 等，不入库
    volumes:
      - ./data:/app/data
    environment:
      TZ: Asia/Shanghai
```

- 数据卷 `./data` 持久化 SQLite 与签名密钥；`.gitignore` 追加 `data/`、`.env`。
- 升级：`docker compose -f docker-compose.local.yml up -d --build`；回滚：切回旧镜像/旧 compose。
- 备份：停容器复制 `data/app.db`（或新增 `/api/admin/backup` 触发 `VACUUM INTO`，P2）。
- `docker-compose.yml`（拉取上游静态镜像）保持原样：该镜像为静态模式，不含额度能力。

### 8.3 反向代理 / 真实 IP / HTTPS

- 若前置 Nginx/Caddy：`TRUST_PROXY=1`，透传 `X-Forwarded-For`；HTTPS 下 Cookie 自动带 `Secure`（以 `X-Forwarded-Proto` 判断）。
- Docker Desktop 本机部署：容器内看到客户端 IP 为网关地址，后台会注明「容器视角」；如需精确 IP 可用宿主进程运行（bun 直跑）或 Linux 服务器部署。
- 静态托管（GitHub Pages / Vercel / Render / 上游 GHCR 镜像）保持静态模式：不提供额度与管理后台，行为与现状一致。

### 8.4 文档与版本记录

- `README.md`：部署章节区分「静态模式」与「服务端模式（本地方案）」。
- `docs/content/docs/overview/docker.mdx` + `.zh-CN.mdx`：补充服务端镜像、环境变量、数据卷、管理员初始化。
- 新增 `docs/content/docs/development/server-mode.mdx`（+ zh）与 `meta.json` 索引：服务端模式架构、API、额度说明、安全边界。
- `CHANGELOG.md` `Unreleased`：按 `[新增]/[调整]/[修复]` 记录。
- `docs/content/docs/progress/pending-test.mdx` + `.zh-CN.mdx`：记录本次可测试变更；完成后从 `todo.mdx` 移除对应待办（若存在）。

---

## 9. 安全设计要点

| 风险 | 措施 |
| --- | --- |
| Key 泄露给普通用户 | Key 仅存服务端（AES-GCM 加密），前端仅占位符；验证方式：抓包/构建产物中无真实 Key |
| 普通用户绕过前端直连上游 | 前端无 Key；上游请求必须经服务端注入 Key；直连上游无凭据 |
| 越权访问管理接口 | 全部 `/api/admin/*` 会话校验；`SameSite=Strict` + Origin 校验；登录限流/锁定 |
| SSRF | 中转目标白名单（渠道 Base URL）；媒体 GET 做 DNS/IP 私网校验；重定向逐跳校验 |
| 恶意刷额度 | 访客 + IP 双维度日/周上限；限流（每访客 120 req/min、并发 20）；大 request 413；超时 |
| 密码爆破 | argon2id 哈希；登录限流；审计 |
| 密钥/会话泄露 | HttpOnly + Secure + SameSite；SESSION_SECRET 不入库；日志脱敏；DB 文件权限 |
| CSRF | Cookie SameSite=Strict；写接口校验 Origin |
| 注入/异常 | SQLite 预编译语句；请求体大小限制；上游错误透传但内部错误不暴露堆栈 |
| 指纹伪造 | 明确为启发式：Cookie 为主 + 指纹/IP 记录；IP 上限兜底；文档说明局限 |
| 多实例竞态 | 明确单实例部署；SQLite WAL；如需多实例，后续引入集中存储 |

---

## 10. 实施计划

### 10.0 总原则

- **本地分支**：从 `main @ 9cd3dea` 创建 `feat/server-quota-admin`；全程本地提交，**不 push、不建 PR、不 fetch/pull 远端**。
- 分阶段提交，小步可回滚：`feat(server): ...`、`feat(web): ...`、`feat(admin): ...`、`build(deploy): ...`、`docs: ...`。
- 每个阶段先冻结契约再并行；写范围不重叠；阶段末跑验证命令。
- 项目规则与用户规则冲突时（如构建/测试），按「验证必须真实」执行最小充分验证（类型检查/单测/集成/构建）。

### 10.1 阶段与任务

#### P0 契约与骨架（Lead，0.5 天）

| ID | 任务 | 产出 | 验收 |
| --- | --- | --- | --- |
| T0.1 | 建分支、记录基线 | `feat/server-quota-admin`，HEAD=9cd3dea | `git log` 可追溯 |
| T0.2 | 冻结 API/类型契约 | `web/src/types/server.ts` 初版 + 本文档 §6.4 定稿 | 前后端按同一契约开发 |
| T0.3 | 服务端骨架与本地可运行 | `server/` 可 `bun run`，`/api/health` 200 | 本地 curl 通过 |

#### P1 后端核心（W1，2–3 天）

| ID | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| T1.1 | DB 初始化/迁移/事务（schema.sql） | T0.3 | 启动建表；重启幂等 |
| T1.2 | 身份模块：签名 Cookie、访客 upsert、IP 记录 | T1.1 | 单测 + curl 可建访客 |
| T1.3 | 额度模块：窗口计算、预占/结算/释放、429、手动重置 | T1.1 | 单测覆盖日/周边界与并发 |
| T1.4 | 中转模块：白名单、body 解析、能力/单位推断、Key 注入、流式透传、超时/大小限制 | T1.3 | 假上游集成测试通过；直连被拒 403/401 |
| T1.5 | 公共接口：bootstrap/session/quota | T1.2/T1.3/T1.4 | curl 断言字段完整 |
| T1.6 | 管理接口：登录/会话/渠道 CRUD/策略/统计/访客/重置 | T1.1–T1.5 | 未登录 401；登录后全部通过 |
| T1.7 | 安全模块：argon2id、AES-GCM、限流、Origin、SSRF 防护 | T1.4/T1.6 | 安全单测（伪造 XFF、重定向私网、暴力登录） |
| T1.8 | 静态托管 + SPA fallback + 运行时 config.js | T1.5 | 直接托管 web/dist 可访问 |

#### P2 前端接入（W2，2 天）

| ID | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| T2.1 | 契约类型 + server API 客户端 + 额度 store | T0.2 | 单测/手测 |
| T2.2 | 启动探测 + 指纹上报 + store hydrate（含 `withLocalProxy` 改造） | T2.1/P1 | 服务端模式生成请求打到 /api/relay；静态模式不受影响 |
| T2.3 | 配置弹窗/顶栏/URL 参数/导入导出适配 | T2.2 | 服务端模式无渠道与代理入口；静态模式原样 |
| T2.4 | 额度指示器 + 429/封禁提示 + 生成前预检 | T2.2 | 超额时前端提示正确，恢复后正常 |
| T2.5 | i18n 中英文案 | T2.3/T2.4 | 无硬编码中文散落 |

#### P3 管理后台（W3，1.5–2 天，依赖 P1 接口 + T2.1 类型）

| ID | 任务 | 验收 |
| --- | --- | --- |
| T3.1 | `/admin` 路由 + 登录/会话守卫 + 布局 | 未登录跳登录；登录后进入 |
| T3.2 | 渠道管理（复用 ChannelEditorDrawer/ModelScriptEditor；Key 掩码；测试连通性/拉模型） | 增删改后普通用户 bootstrap 同步变化 |
| T3.3 | 额度策略表单（按能力的日/周额度、IP 上限、时区、退款、豁免） | 保存后立即生效 |
| T3.4 | 概览 + 使用统计表格 | 数据与数据库一致 |
| T3.5 | 用户与 IP（列表/搜索/详情/重置额度/封禁） | 能看到刚才普通用户的 IP/指纹/用量 |

#### P4 部署与文档（W4，1 天，依赖 P1/P2）

| ID | 任务 | 验收 |
| --- | --- | --- |
| T4.1 | `Dockerfile.server` + compose + `.env.example` + `.gitignore` | `docker compose -f docker-compose.local.yml up -d --build` 成功 |
| T4.2 | 数据卷/健康检查/重启恢复验证 | 重建容器数据仍在 |
| T4.3 | README + docker 文档（中英）+ 新 development 页 + meta.json | 文档路径可访问（静态检查） |
| T4.4 | CHANGELOG / pending-test / todo 更新 | 符合项目文档规范 |

#### P5 联合验证与收尾（Lead + 独立复核，1 天）

| ID | 任务 | 验收 |
| --- | --- | --- |
| T5.1 | 静态模式回归（无 /api 时行为不变） | 旧配置流程可用 |
| T5.2 | 服务端模式 E2E（匿名生成、超额 429、次日恢复、管理员重置） | 全部通过 |
| T5.3 | 安全验证（无 Key 泄露、越权 401、SSRF、日志脱敏） | 检查清单逐项通过 |
| T5.4 | 独立复核 + 最终报告 | 复核意见关闭 |

### 10.2 并行分工与写范围（用于 Agent Teams / 子代理）

| 工作流 | Owner | 写范围（互不重叠） | 依赖 |
| --- | --- | --- | --- |
| W1 后端 | teammate-server | `server/**`、`Dockerfile.server`、`.env.example` | T0 |
| W2 前端接入 | teammate-web | `web/src/stores/**`、`web/src/services/api/**`、`web/src/services/config-file.ts`、`web/src/components/layout/**`（除 user-status-actions 与 app-config-modal 由 W2 负责，W3 不改）、`web/src/pages/image|video|canvas`、`web/src/i18n/**`、`web/src/types/**`、`web/package.json` | T0、T1 接口 |
| W3 管理后台 | teammate-admin | `web/src/pages/admin/**`、`web/src/router.tsx`、`web/src/components/layout/user-status-actions.tsx` | T0、T2.1；i18n 由 W2 统一写入（依赖其 commit） |
| W4 部署文档 | teammate-infra | `docker-compose.local.yml`、`README.md`、`docs/**`（除本方案文件）、`CHANGELOG.md` | T1/T2 |
| 复核 | teammate-reviewer | 只读 | 全部 |

- 冲突规避：i18n 文件只由 W2 写入；W3 需要的新文案先列清单交给 W2（或由 Lead 在 T0.2 契约中列出）。
- 若团队工具不可用，由 Lead 按 W1→(W2‖W3)→W4→P5 顺序执行，写范围不变。

### 10.3 里程碑

| 里程碑 | 内容 | 完成标志 |
| --- | --- | --- |
| M1 | 后端可跑 | `/api/health`、bootstrap、relay、admin API 单测绿 |
| M2 | 前端可匿名生成 | 浏览器无需配置即可生成；请求经 relay |
| M3 | 管理闭环 | 后台配置渠道/额度，普通用户超额被拦，次日恢复 |
| M4 | 交付 | Docker 构建运行、静态模式回归、文档更新、最终报告 |

---

## 11. 测试与验收

### 11.1 命令（实现阶段执行并记录退出码）

```bash
# 前端类型检查 / 单测 / 构建（首次需先 bun install）
cd web && bun run typecheck && bun test && bun run build

# 服务端类型检查 / 单测
cd server && bunx tsc --noEmit && bun test

# 集成测试（假上游 + 临时数据目录，随机端口）
bun test server/tests/integration.test.ts

# 构建与运行（本机 Docker）
docker compose -f docker-compose.local.yml build
docker compose -f docker-compose.local.yml up -d
curl -s http://127.0.0.1:3002/api/health

# 静态模式回归
cd web && bun run build   # 构建产物在无 /api 的静态服务器下打开，配置流程可用
```

### 11.2 测试矩阵

| 类型 | 用例 | 方式 |
| --- | --- | --- |
| 单元 | 日/周窗口边界、时区、预占/释放、并发超额 | `server/tests/quota.test.ts` |
| 单元 | 白名单匹配、SSRF 判定、单位推断（n/multipart/Gemini）、Key 注入 | `server/tests/relay.test.ts` |
| 单元 | Cookie 签名篡改、密码校验、登录限流、Origin 校验 | `server/tests/auth.test.ts` |
| 集成 | 匿名访客：bootstrap → fingerprint → relay 生图（假上游）→ 用量入库 | 假上游 + fetch |
| 集成 | 日额度=1：第 2 次 429；手动重置后恢复；窗口前移后恢复 | 可注入时钟（`server/src/config.ts` 支持 `NOW_OVERRIDE` 测试钩子） |
| 集成 | 未配置 URL / 私网 URL / 未授权模型 → 403/400；无效 Cookie → 401 | fetch |
| 管理 | 未登录 401；登录后渠道 CRUD；普通用户 bootstrap 变化；重置/封禁生效 | fetch + Cookie |
| E2E | 新浏览器打开 3002 → 直接生成 → 顶栏额度减少 → 超额提示 → 后台重置后恢复 | js-reverse MCP 独立标签页 |
| 安全 | 构建产物 / 网络请求中无真实 Key；日志无 Key；伪造 XFF 不生效（TRUST_PROXY=0） | grep + 抓包 + 日志 |
| 部署 | 镜像构建、容器重启数据保留、健康检查 | docker |

### 11.3 验收清单（交付前逐项勾选）

- [ ] R1 IP 与指纹已记录并在后台可见
- [ ] R2 额度由服务端强制（curl 同样受限）
- [ ] R3 日/周双额度生效
- [ ] R4 自动刷新 + 手动重置生效
- [ ] R5 服务端与数据持久化、部署文档完成
- [ ] R6 管理接口仅管理员；普通用户无 Key/无渠道配置
- [ ] R7 普通用户开箱即用
- [ ] 前端 typecheck/test/build 通过
- [ ] 服务端 typecheck/test 通过
- [ ] 静态模式回归通过
- [ ] CHANGELOG / pending-test / README / docs 更新
- [ ] 全部提交在本地分支，未推送

---

## 12. 风险与限制

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 指纹可伪造 / 多浏览器 | 单人额度可被绕过 | Cookie 为主 + IP 维度上限 + 封禁；文档明示为治理而非强认证 |
| Docker Desktop IP 失真 | IP 记录不精确 | 后台注明；需要精确 IP 时用宿主进程/Linux/反代 |
| 大请求体（图生图/视频参考） | 内存占用 | 上限 128MB 可配；超限 413；流式转发响应 |
| 上游流式/长任务 | 超时/断连 | 可配超时 600s；客户端断开取消上游；SSE 不缓冲 |
| 自定义脚本绕过模型校验/直连 | 可调用非常规接口；脚本内绝对 URL 直连（无 Key，会失败） | 脚本仅管理员可写；文档约束；relay 仍限渠道白名单 |
| 单实例 SQLite | 不支持水平扩展 | 明确单实例；数据卷备份；后续可换集中存储 |
| 静态部署功能缺失 | Vercel/Pages 无额度/管理 | 双模式兼容，文档说明 |
| 管理员密码泄露 | 全渠道 Key 风险 | argon2id + 限流 + 后台改密 + 审计；`.env` 不入库 |
| 额度退款策略 | 上游已计费但本地退款 | 默认仅在 2xx 前失败退款；2xx 后成本自担，可配置 |
| 审计/用量数据增长 | 数据库膨胀 | 保留期 90 天 + 每日清理任务 |

---

## 13. 待确认决策（已给默认值，未确认按默认执行）

| # | 决策 | 选项 | 默认建议 |
| - | --- | --- | --- |
| Q1 | 额度计量与默认值 | A. 统一单位加权；B. 各能力独立额度；C. 全部按次均 1 | **已确认：B（按能力独立）** —— 文本不限；图片 100 张/日、700 张/周；单次张数不额外限制；视频/音频默认不限（后台均可改） |
| Q2 | 管理员账号初始化 | A. `.env` 的 `ADMIN_USERNAME/ADMIN_PASSWORD` 首启写入数据库<br>B. 首次访问设置向导<br>C. 固定配置文件 | **A**（首启后可在后台改密） |
| Q3 | 运行与真实 IP | A. 保持 Docker 单机（本机/局域网），IP 为容器视角，指纹为主<br>B. 后续挂域名/HTTPS/反代（配 `TRUST_PROXY`）<br>C. 改用宿主机进程运行以获得真实 IP | **A**（文档同时给 B/C 的切换方法） |

其他默认假设（无需确认，按此执行）：

- 普通用户匿名、无需注册；管理员为单账号。
- 允许普通用户在管理员启用的模型中选择模型（后台可关闭）。
- 保留静态模式兼容；不改上游 `Dockerfile` 与静态发布流程。
- 不推送、不建 PR、不做远端操作。

---

## 14. 不做的事（本次范围外）

- 用户注册登录、邀请码、账号体系。
- 计费、充值、订单、支付。
- 多实例/高可用/Redis/独立数据库。
- 画布数据云同步（仍为浏览器本地；WebDAV 同步保持现状）。
- 上游渠道的自动故障转移、模型自动发现调度。
- 向 GitHub 推送、发布镜像、修改远端 CI。

---

## 15. 文件与提交规划（摘要）

预计改动规模：**新增约 25–30 个文件，修改约 15 个文件，净增约 4000–6000 行**（不含依赖锁文件）。

建议提交序列（全部本地）：

1. `feat(server): scaffold bun server, sqlite schema and health/bootstrap`
2. `feat(server): identity (ip + fingerprint) and quota engine`
3. `feat(server): relay with allowlist, key injection, quota enforcement`
4. `feat(server): admin auth and management APIs`
5. `feat(web): server mode bootstrap, relay routing and quota UI`
6. `feat(admin): admin dashboard for channels, quota, usage and clients`
7. `build(deploy): server docker image and local compose`
8. `docs: server mode deployment, quota and admin documentation`
9. `test: server and integration coverage`

---

## 16. 实施记录（2026-11-05，本地）

已完成 P0–P5 的代码、测试与本机 Docker 验证；分支 `feat/server-quota-admin`，本地提交 3 个，**未推送**。

已交付：

- 服务端 `server/`：Bun + `bun:sqlite`，含身份（IP + 内置浏览器指纹 + 签名 Cookie）、按能力日/周额度（图片默认 100/日、700/周，文本/视频/音频默认不限额）、重置标记式手动刷新、`/api/relay` 中转（渠道白名单、Key 注入、模型校验、流式透传、媒体 SSRF 防护）、管理员鉴权（argon2id、会话、登录限流、审计）、渠道/额度/统计/访客管理接口。
- 前端：启动探测服务端模式、内置指纹采集、额度指示器与生成前预检、配置弹窗适配、`/admin` 管理后台（渠道、额度策略、使用统计、用户与 IP、系统设置）、中英文案；静态模式完全保留。
- 部署：`Dockerfile.server`、服务端 compose（3002 端口 + `./data` 数据卷 + `.env`）、README/文档/CHANGELOG/待验收清单更新。

验证结果：

- 服务端：`bun test server/tests` 25 项通过（额度窗口/预占结算/手动重置/跨天恢复/白名单/Key 注入/401/429）。
- 前端：`tsc --noEmit` 通过；`bun test` 15 项通过；`bun run build` 通过。
- Docker：`Dockerfile.server` 构建成功；容器 `infinite-canvas` 运行于 3002，健康检查通过，数据卷持久化。
- 浏览器端到端（本机 3998 测试实例 + mock 上游）：服务端模式自动生效、匿名生成成功、额度 1/1 后第二次被拦截并提示重置时间、管理员登录、访客 IP/指纹列表、手动重置后恢复生成；中转请求为同源 `/api/relay`，浏览器内无真实 Key。
- 容器实例：静态页面、bootstrap、管理员登录、渠道配置与从容器到宿主 mock 上游的中转均验证通过。

已知限制：

- Docker Desktop（macOS）端口映射下容器看到的客户端 IP 为网关地址（实测 `192.168.65.1`）；指纹为主要身份，IP 记录为容器视角。需要真实 IP 时可改用宿主进程运行、Docker host network 或部署到 Linux 服务器并配置 `TRUST_PROXY=1`。
- 单实例部署（SQLite），不支持多实例水平扩展。
- 自定义脚本按管理员编写的内容执行；脚本内若使用绝对 URL 直连则不会携带服务端 Key（服务端只对渠道白名单请求注入凭据）。

上线后待办：

1. 管理员登录 `/admin`，在「渠道管理」新增真实上游（容器访问宿主机服务用 `http://host.docker.internal:<port>`），拉取模型并设置默认模型。
2. 如需调整额度，在「额度策略」修改图片日/周额度或为视频/音频设置额度。
3. 如需真实客户端 IP，评估 host network / 反向代理方案后再设置 `TRUST_PROXY`。

### 16.1 后续修正：Docker 内访问宿主机服务（2026-11-05）

实际接入本机 `chatgpt2api` 时发现典型问题：容器内 `localhost:3000` / `127.0.0.1:3000` 指向容器自身而不是宿主机，导致「拉取模型」返回空列表（请求返回的是无限画布自己的 HTML），看起来像“导入成功但没有模型”。已修正：

- 服务端检测到运行在 Docker 内（`/.dockerenv`）时，保存渠道、测试渠道、中转请求都会把 `localhost` / `127.0.0.1` / `::1` 自动改写为 `host.docker.internal`；旧配置里的 localhost 也能直接工作。
- 模型拉取失败（非 JSON、缺少 data/models、空列表）不再静默返回空数组，而是返回带排查提示的 400 错误。
- 管理后台渠道编辑增加 Base URL 提示（宿主机服务用 `http://host.docker.internal:<端口>`），拉取 0 个模型时给出明确警告；README 同步说明。
- 验证：`http://localhost:3000` 作为 Base URL 拉取到 22 个模型；经中转真实出图（gpt-image-2，57s，b64 1.38MB）与文本生成（`/v1/responses`，model auto，18.5s 返回 OK）均成功。
