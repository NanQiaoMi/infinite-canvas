# 本地更新详单（NanQiaoMi 二开）

> 这份文档是我的版本相对于上游 `v0.20.0` 的全部提交清单，按模块归档。上游仓库：[basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas)（MIT）。二开性质与协议见 [NOTICE.md](NOTICE.md)。

## 一、我的版本状态

| 项目 | 值 |
|---|---|
| 分支 | `feat/conversation-agent` |
| 基线 | `v0.20.0`（上游 tag） |
| 当前 HEAD | `6354d5f` |
| 提交数（含合并） | **128** |
| 提交数（不含合并） | 112 |
| 时间跨度 | 2026-10-20 ～ 2026-11-09 |
| 版本状态 | 仍是 `v0.20.0`，**未发版，开发中** |
| 代码改动量 | 183 files changed, 32992 insertions(+), 570 deletions(-) |

提交作者分布（`git log v0.20.0..HEAD --format='%an' | sort | uniq -c`）：

```
124 mimi
   2 NanQiaoMi
   2 HouYunFei
```

提交类型分布：feat 47 / fix 36 / docs 18 / style 6 / refactor 3 / build 1 / chore 1；另含 `merge` 合并提交 16 个。

## 二、我做了什么（摘要）

1. **把「无限画布」从生图工具做成 Agent 工作台**：对话里任务拆解 + 工具循环（ReAct），AI 自己决定出图、改图、批量排布与画布操作。
2. **对话稳定性**：多会话隔离（线程/项目/身份门禁）、后台丢图修复、网络重试与可见化、长文本误判修复、历史提示词污染治理。
3. **生图链路**：工作台排队与互斥去重、客户端并发上限、可恢复错误自动重试、刷新后任务恢复、张数超 4 的 422 拆批、默认模型升级 `gpt-image-2.6`、GIF（9 帧/5fps，可调 1–20fps）。
4. **画布 Agent**：12 张批量排布（4 列网格）、节点创建/连线/聚焦/更新/删除等工具、画布与普通会话隔离。
5. **生成诊断**：诊断面板与持久化、最近 7 天失败率趋势、渠道健康检查。
6. **服务端模式**：渠道管理、额度服务（每日/每周/每 IP）、relay、身份与管理后台 API、长任务超时。
7. **界面与排版**：内置 Cascadia Mono + 方正小标宋字体、Claude 风格衬线体系、三端设计语言统一、动效时序打磨。
8. **宣传片**：`promo/L43_活体实机录屏/` 90 秒 L43 风格衍生片《小方上岗记》。
9. **工程化**：清理历史 TypeScript 错误至 typecheck 归零、构建与文档整理。

## 三、按模块的完整提交清单

> 格式：`提交 hash` 日期　提交说明。数据由 `git log v0.20.0..HEAD --no-merges` 生成，可与仓库对照。

### 对话 Agent 与工具链（59 条）

意图判定、任务拆解、工具循环、多会话隔离、重试、诊断等。

- `fb3a71a` 2026-11-09　fix(chat): 严格会话身份并清理跨会话残留，按线程过滤本地 Agent tool_call
- `5fa19b4` 2026-11-09　fix(chat,image): 生图等待态改用真实数字并去除蓝色
- `01d5547` 2026-11-08　fix(chat): 修复长文本加工请求被误判为出图，并补充限流错误重试
- `a075378` 2026-11-08　feat(chat): 诊断持久化、7 天失败率趋势与渠道健康检查
- `d8e763d` 2026-11-08　feat(chat): 新增生成诊断面板并完成故障注入验证
- `a04a241` 2026-11-08　feat(chat): 生成失败自动降级与画布面板就地重试
- `723179d` 2026-11-08　feat(chat): 生成稳定性增强（空闲超时、自动重试、失败就地重试）
- `236766d` 2026-11-08　fix(chat): 完善模糊输入的意图判定（生成/优化/追问）
- `8666fe0` 2026-11-08　feat(chat): 对话与生成体验优化（耗时反馈、重试可见化、提示词追问修正）
- `af0fa56` 2026-11-08　feat(chat): 意图改由模型主决策，显式命令与明确改图仍直连
- `7f46c0a` 2026-11-08　refactor(chat): 画幅比例交由模型自主决定并简化批量生图意图指令
- `5b58ac6` 2026-11-08　fix(chat): 修复网络重试 setSteps 异常并全面升级为 AI 自主决策构图与动态参数返回
- `1454e8d` 2026-11-08　feat(chat): 消除多会话交叉污染、步骤外溢与后台丢图，并全面接入异步排队任务队列
- `92ed4da` 2026-11-08　fix(chat): 扩展场景生图意图识别并杜绝历史总结卡片复读污染
- `9ab5b37` 2026-11-08　fix(chat): 修复 useMemo 未定义导致的运行时白屏异常
- `95031d1` 2026-11-08　fix(chat): 修复批量提示词畸变、误加表情包场景与设计稿继承
- `0b8969c` 2026-11-08　fix(chat): 物理隔离画布与普通会话并消除额度推诿复读
- `1e52ab7` 2026-11-08　fix(chat): 修复多会话交叉污染、续作意图继承断裂与大模型推诿
- `86a561a` 2026-11-08　fix(chat): 优化AI对话多次生图时序逻辑、显现动画与上游连接韧性
- `aa78c02` 2026-11-07　fix(chat): 优化AI对话生图显现时序与动画，根除历史套话复读
- `4887612` 2026-11-07　fix(chat): resolve sidebar text clipping, flexible tool parsing and canvas batch intent routing
- `3a0abe4` 2026-11-07　fix(chat): guard rawText and length props in SmoothStreamText and chat components
- `230f48e` 2026-11-07　feat(chat): optimize task decomposition and intent recognition for user scenarios and tools
- `8442998` 2026-11-07　feat(chat): dispatch transparent background command
- `b3cba55` 2026-11-07　feat(chat): support task decomposition & tool loop
- `15d08a0` 2026-11-07　feat(chat): enforce solid background rules for asset prompts
- `e6de7a9` 2026-11-07　fix(chat): 净化图片结果展示层，移除多余高光动画覆盖
- `120bb79` 2026-11-07　feat(chat): 内置 Cascadia Mono 与方正小标宋 WOFF2 字体包并建立全局加载
- `6825cd0` 2026-11-07　feat(chat): 应用 Cascadia Mono 英文与方正小标宋中文排版字族
- `362936e` 2026-11-07　feat(chat): 对齐 Claude 人文主义衬线字体体系与排版细节
- `ce10f7a` 2026-11-07　feat(chat): empower ai to determine image aspect ratio and composition
- `094b497` 2026-11-07　feat(chat): support animated gif generation and polish step trail
- `600b6f1` 2026-11-07　feat(chat): support intelligent image aspect ratio inference
- `a0eb593` 2026-11-07　feat(chat): 优化思维链时间线导轨与从容呼吸空间
- `57b87a2` 2026-11-07　fix(chat): 优化普通对话思考卡片展示与发送按钮图标对比度
- `eabcf54` 2026-11-07　feat(chat): 对齐 Claude 思考过程卡片与排版，修复 Markdown 粗体与缩进代码块残留
- `eeb0ac0` 2026-11-07　feat(chat): 对齐 Claude 级典雅排版与输出布局，优化段落、引用及全宽阅读流
- `41ea511` 2026-11-07　refactor(chat): 去除生图与卡片外框，波浪点阵与图片直接在背景中无框呈现
- `14be1e2` 2026-11-07　refactor(chat): 纯正还原 ChatGPT 单色波浪点阵与极简卡片，重构素雅品牌头像
- `52a78a4` 2026-11-07　feat(chat): upgrade dot matrix with physical waveform dynamics and neutral styling
- `b7cd5ef` 2026-11-07　fix(chat): keep slash-command arguments when pressing Tab
- `1deca81` 2026-11-07　feat(chat): support keyboard navigation and tab completion for slash commands
- `cee31da` 2026-11-07　feat(chat): overhaul image generation animation with ChatGPT and Claude aesthetic
- `3772ada` 2026-11-07　feat(chat): polish chat UI, smooth stream text, and waiting animations
- `8ea44e9` 2026-11-07　fix(chat): use antd v6 container slot in compare modal
- `3721cb1` 2026-11-07　fix(chat): route complete image prompts to generation locally
- `1f8abf8` 2026-11-07　feat(chat): add prompt library entry in composer
- `254203d` 2026-11-07　feat(chat): multi-select compare, /model channel prefix, retry step status
- `8795198` 2026-11-06　feat(chat): live step trail during agent turns
- `f1e86e9` 2026-11-06　feat(chat): continue editing from artifact panel
- `d9f64c7` 2026-11-06　feat(chat): artifact preview panel and model switcher
- `7527cd5` 2026-11-06　feat(chat): command palette and streaming motion polish
- `a40fd34` 2026-11-06　style(chat): polish motion and interaction effects
- `34f295f` 2026-11-06　style(chat): adopt claude-like flat layout and composer
- `9eed8ab` 2026-11-06　feat(chat): agent console UI with timeline tools and generation skeleton
- `46d5c3e` 2026-11-06　style(chat): unify layout with workbench pages
- `b5914ab` 2026-11-06　feat(chat): add image editing and channel tool protocol
- `29d1f10` 2026-11-06　fix(chat): execute image tool on prompt follow-ups
- `f40b564` 2026-11-06　feat(chat): add built-in conversation agent with prompt and image tools

### 生图工作台与队列（8 条）

排队并发、重试与刷新恢复、模型升级、GIF、张数拆批等。

- `0276a3d` 2026-11-09　fix(image): 工作台指令归属、重试快照与刷新恢复校验，生图不再继承对话 systemPrompt
- `941fbca` 2026-11-08　feat(image): 工作台排队与抗压优化（互斥去重、客户端并发上限、可恢复错误重试）
- `e482f84` 2026-11-08　feat(image): 默认生图模型升级为最新的 gpt-image-2.6
- `bbef88b` 2026-11-08　fix(image): 解决生图张数超过4张时422报错，支持并发批次拆解与长宽比追问继承
- `052bf93` 2026-11-07　feat(image): default auto ratio and optional prompt optimization approval
- `9ecc8fb` 2026-11-07　fix(image): show gif total duration with two decimals
- `d97ad59` 2026-11-07　feat(image): align gif controls with recommended 1-20fps range
- `5512a9b` 2026-11-07　feat(image): integrate gpt-image-2.6 GIF generation

### 画布与画布 Agent（3 条）

画布页、节点工具、批量排布、连线与聚焦。

- `7218f3b` 2026-11-09　fix(canvas): 隔离画布助手会话与运行态，禁止跨项目复用
- `31f770c` 2026-11-08　fix(canvas): 清理 22 个历史 TypeScript 类型错误，typecheck 归零
- `c934072` 2026-11-07　feat(canvas): empower native ai conversation agent and canvas node tools

### Agent 运行时（3 条）

ReAct 循环、模板与历史继承隔离。

- `f1cee91` 2026-11-09　fix(agent): 历史提示词继承加续作/主题门禁，独立请求不再复用旧 promptBlocks
- `1e27294` 2026-11-08　fix(agent): 彻底消除生图 ReAct 循环失控并隔离画布工具
- `8aac5cc` 2026-11-08　feat(agent): 将批量排布与并发生图上限扩容至 12 张

### 服务端与额度（4 条）

渠道、额度、relay、身份与管理后台。

- `67b5ab3` 2026-11-07　fix(server): set Bun.serve idleTimeout to 255s to support long generations
- `68e5cfe` 2026-11-07　fix(server): support NAT port mapping and reverse proxy in assertSameOrigin
- `e8b3043` 2026-11-05　fix(server): support localhost channel URLs inside docker
- `da81a04` 2026-11-05　feat(server): add quota service with relay, identity and admin APIs

### 界面与排版（4 条）

设计语言、样式与排版。

- `f464052` 2026-11-08　style(workbench): 修正移动端顶栏与底部 CTA 细节并同步视觉统一文档
- `cdbee17` 2026-11-07　feat(workbench): 统一生图工作台、视频创作台与AI对话界面的设计语言与交互
- `f5501ec` 2026-11-07　style(workbench): polish history footer, actions and mobile layout
- `b43185d` 2026-11-07　style(workbench): unify image and video pages with chat design


### 文档与杂项（17 条）

- `6354d5f` 2026-11-09　docs: 记录上下文污染修复与待验收项
- `9573f4f` 2026-11-09　docs: 细化二开说明与本地更新明细
- `59d8da7` 2026-11-09　docs: 二开声明与 L43 宣传片制作资料
- `08cb601` 2026-11-07　docs: record slash command menu optimization
- `2880cd0` 2026-11-07　docs: record chat prompt library entry
- `12ef281` 2026-11-07　docs: record workbench style unification
- `b4addfa` 2026-11-06　docs: record live step trail
- `281872c` 2026-11-06　docs: record artifact continue editing
- `2ce01e6` 2026-11-06　docs: record artifact panel and model switcher
- `9dc0872` 2026-11-06　docs: record command palette and motion pass
- `f06a758` 2026-11-06　docs: record chat motion polish
- `e22ceaa` 2026-11-06　docs: record claude-style chat layout
- `b80bd54` 2026-11-06　docs: record agent console UI
- `cea187f` 2026-11-06　docs: record chat UI unification
- `bd385c5` 2026-11-06　docs: record chat image editing and tool protocol work
- `6af88f9` 2026-11-06　docs: record conversation agent implementation and verification
- `4895f41` 2026-11-05　docs: record server mode implementation and verification

### 其他改动（14 条）

- `5df44c6` 2026-11-09　fix(prompts): 提示词库弹窗适配竖屏与窄窗口
- `0a6ff6b` 2026-11-07　fix(canvas-agent): resolve task interruption on batch generation and layout requests
- `8bad4f0` 2026-11-07　fix(relay): fallback from /responses to /chat/completions when upstream returns 404
- `0f0efbe` 2026-11-07　feat(nav): 优化顶栏导航间距与弹性布局，防止文字与图标重叠遮挡
- `e6429ea` 2026-11-07　feat(theme): 全站基础字族全面应用 Cascadia Mono 与方正小标宋简体
- `dc47809` 2026-11-07　fix(config): migrate legacy 1:1 default image ratio to auto once
- `b74ac85` 2026-11-07　fix(nav): show mobile menu on tablet widths
- `dd6b8ce` 2026-11-06　docs(plans): add conversation agent design plan
- `ac8b417` 2026-11-05　fix(admin): filter default model options by capability
- `db8447c` 2026-11-05　feat(admin): review dialog and better capability inference for model import
- `a842fad` 2026-11-05　build(deploy): add server docker image and docs
- `3dd1935` 2026-11-05　feat(web): add server mode with quota UI and admin console
- `9cd3dea` 2026-10-25　feat(README): add KunrouAI logo and description to the README
- `9f2bd9f` 2026-10-20　chore: update CHANGELOG for v0.20.0 release

## 四、如何复核

```bash
git log --oneline v0.20.0..HEAD            # 全部提交
git log --no-merges --format='%h %ad %s' --date=short v0.20.0..HEAD
git diff --stat v0.20.0..HEAD              # 改动文件与行数
git shortlog -sn v0.20.0..HEAD             # 作者分布
```
