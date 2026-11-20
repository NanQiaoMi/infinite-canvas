# Infinite Canvas Agent

本地 Canvas Agent 用来连接画布网页和用户电脑上的 Codex / Claude Code。本地开发时优先连接 `http://localhost:3000`，不需要先使用线上站点。

## 启动

```bash
npx -y @basketikun/canvas-agent@latest
```

带上 `@latest` 是因为 npx 会缓存已下载的版本，不加就可能一直运行旧版本。

需要排查连接、线程、Codex app-server 或工具调用问题时，可开启 Debug 模式：

```bash
npx -y @basketikun/canvas-agent@latest --debug
```

Debug 日志会以 `[DEBUG][HH:mm:ss]` 等传统格式输出到终端，并按启动日期保存到 `~/.infinite-canvas/logs/canvas-agent-YYYY-MM-DD.log`。终端日志带级别颜色，文件日志为纯文本；日志包含 HTTP、SSE、线程、turn、Codex app-server 和工具调用事件，token 与图片 Data URL 会自动隐藏。

本仓库开发时也可以直接运行：

```bash
cd canvas-agent
npm install
npm run build
node dist/index.js
```

启动后会输出本机地址和 token：

```txt
Local URL: http://127.0.0.1:17371
Connect token: xxxxxx
```

在画布右上角点击 `Agent`，填入地址和 token 后连接。

Codex app 插件会读取启动输出里的 Local URL 和 Connect token，并直接打开画布网页地址；Canvas Agent 不负责生成画布打开 URL。

Canvas Agent 默认只监听 `127.0.0.1`。网页第一次带正确 token 连接后，Canvas Agent 会记录该网页 Origin；之后其他 Origin 不能复用这个本地 Agent，除非用户清理 `~/.infinite-canvas/canvas-agent.json` 里的 `origins`。

## 一键接入 MCP

使用稳定的启动命令（当前 node 绝对路径 + 运行时入口 + `mcp`）为本地 AI 工具注册 Infinite Canvas MCP：

```bash
npx -y @basketikun/canvas-agent@latest install-mcp [--client claude|codex|antigravity|all] [--entry <dist/index.js 绝对路径>] [--dry-run]
```

- `--client`：要接入的客户端，默认 `all`；Claude Code 注册为用户级，Codex 已通过插件提供时自动跳过。
- `--entry`：指定本地入口文件（需为绝对路径）；不指定时安装到 `~/.infinite-canvas/runtime`。
- `--dry-run`：只显示将执行的操作，不写入任何配置。
- 命令结束后会自检 MCP 工具列表，任一客户端失败时退出码为 1。

## 发布

`canvas-agent` 使用自己的 `package.json` 版本号，不跟仓库根目录 `VERSION` 绑定。推送到 `main` 后，GitHub Actions 会检查 npm 上是否已经存在当前包版本；不存在时才发布 `@basketikun/canvas-agent`。

发布前需要在 GitHub 仓库 Secrets 中配置 `NPM_TOKEN`。

## Codex MCP

如果希望 Codex 终端能直接操作画布，需要先把 Canvas Agent 注册成 Codex MCP。

直接运行 `npx -y @basketikun/canvas-agent@latest` 只启动本地 Agent 服务，不会安装 MCP，也不会增加 Codex 工具上下文。只有安装 Codex app 插件，或手动执行 `codex mcp add` 后，`infinite-canvas` 工具才会进入 Codex 上下文；由于工具较多，不使用时建议移除。

通过插件安装时移除插件：

```bash
codex plugin remove infinite-canvas
```

手动添加 MCP 时移除 MCP：

```bash
codex mcp remove infinite-canvas
```

### Codex app 插件

仓库内提供了 Codex app 插件：`plugins/infinite-canvas`。在 Codex app 中添加本仓库的 marketplace 后，可以安装 `Infinite Canvas` 插件；插件会注册同一个 `infinite-canvas` MCP，并带上画布操作说明。

添加本地 marketplace 时建议使用仓库绝对路径，避免 Codex 从其他工作目录解析失败：

```bash
cd /path/to/infinite-canvas
codex plugin marketplace add "$(pwd)"
codex plugin add infinite-canvas@infinite-canvas-local
```

插件默认通过 npm 启动 MCP；这个命令只提供 MCP 工具，不会把 MCP 写入全局配置，也不会在退出时自动卸载：

```bash
npx -y @basketikun/canvas-agent@latest mcp
```

使用时可以直接在 Codex 里说“打开 Infinite Canvas”，插件会启动本地 Agent，读取 Local URL 和 Connect token，然后在右侧打开 `https://canvas.best/` 并自动新建、连接画布；只有明确要求使用本地项目时才会启动本地前端。

Canvas Agent 启动后，给 Codex 添加 MCP：

```bash
codex mcp add infinite-canvas -- npx -y @basketikun/canvas-agent@latest mcp
```

本仓库开发时可以改成，实际使用建议替换为本机绝对路径：

```bash
codex mcp add infinite-canvas -- node /path/to/infinite-canvas/canvas-agent/dist/index.js mcp
```

Canvas Agent 源码使用 TypeScript 编写，MCP 协议层使用官方 `@modelcontextprotocol/sdk`，工具入参使用 `zod` 描述。

如果希望终端里的 Codex 不被 MCP 审批卡住，可以在 `~/.codex/config.toml` 里给这个 MCP 设置自动放行：

```toml
[mcp_servers.infinite-canvas]
command = "npx"
args = ["-y", "@basketikun/canvas-agent@latest", "mcp"]
default_tools_approval_mode = "approve"
```

可用工具：

- `canvas_get_state`
- `canvas_get_selection`
- `canvas_export_snapshot`
- `canvas_apply_ops`
- `canvas_create_text_node`
- `canvas_create_image_prompt_flow`

`canvas_apply_ops` 示例：

```json
{
  "ops": [
    {
      "type": "add_node",
      "nodeType": "text",
      "title": "标题",
      "position": { "x": 0, "y": 0 },
      "metadata": { "content": "文本内容" }
    }
  ]
}
```

## 侧边栏 Codex

本地面板会把提示词发送给 Canvas Agent。Canvas Agent 使用官方 `@openai/codex` CLI 的 `codex app-server --stdio` 启动并复用同一个 Codex thread，启动时会注入 `infinite-canvas` MCP 配置并自动放行 MCP 审批，真正执行画布修改前仍由网页侧边栏二次确认。

侧边栏会展示 Codex 返回的 `thread.started`、`turn.started`、`item.*`、`turn.completed` 等结构化事件；Canvas Agent 会合并短时间内的回复、思考摘要和命令输出增量，网页使用同一条消息持续更新，并把任务进度、计划、搜索、文件修改与工具操作整理为中文过程时间线。

侧边栏上传或粘贴的图片会先发到本机 Canvas Agent，再由 Canvas Agent 临时写入本机文件并作为 app-server `localImage` 输入传给 Codex；前端会提示附件体积，单次请求体限制为 30MB。

## 侧边栏 Claude

侧边栏顶部可在 Codex 与 Claude 之间切换，两者共用同一套对话、历史、Skill、权限审批和中断接口（`/agent/:runtime/...`）。Claude 运行时基于官方 `@anthropic-ai/claude-agent-sdk`：

- 首次使用前需在终端运行 `claude` 并执行 `/login`，或配置 `ANTHROPIC_API_KEY`；未登录时侧边栏会给出明确提示。
- Canvas Agent 直接把 `infinite-canvas` MCP 传给 Claude，无需额外注册；准备对话时会真实启动一次 MCP 检查是否就绪，画布工具自动放行。
- 权限模式：「请求」对应 Claude 默认模式并走网页审批卡片，「自动」对应 auto 模式，「完全访问」对应 bypassPermissions。
- 会话由 Claude 自身保存（`~/.claude/projects/`），画布侧的展示历史保存在 `~/.infinite-canvas/claude-history/`；删除对话会归档 Claude 会话并清理画布侧历史。
- Skill 与 Codex 共用工作空间的 `.agents/skills`（通过 `.claude/skills` 链接），另会列出 `~/.claude/skills`；Claude 只加载技能页中启用的 Skill，插件自带 Skill 暂不加载。

## 在 Claude Code、Codex、Antigravity 中使用画布 MCP

推荐用 `install-mcp` 一键注册（见上文「一键接入 MCP」）。它会把当前版本安装到 `~/.infinite-canvas/runtime`，并以 node 绝对路径注册，避免图形界面应用找不到 `npx`。

也可以手动注册：

```bash
claude mcp add --scope user infinite-canvas -- npx -y @basketikun/canvas-agent@latest mcp
```

Antigravity 的全局 MCP 配置文件为 `~/.gemini/config/mcp_config.json`：

```json
{
  "mcpServers": {
    "infinite-canvas": { "command": "/绝对路径/node", "args": ["/Users/<you>/.infinite-canvas/runtime/node_modules/@basketikun/canvas-agent/dist/index.js", "mcp"] }
  }
}
```

修改后在 Antigravity 的 MCP Servers 中刷新或重启应用。无论哪种客户端，都需要 Canvas Agent 正在运行，且网页画布已连接 Agent，画布工具才能生效。
