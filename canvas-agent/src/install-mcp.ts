import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { VERSION } from "./config.js";

export type LaunchSpec = { command: string; args: string[] };
type ClientName = "claude" | "codex" | "antigravity";
type ClientResult = { mark: "✓" | "-" | "·"; msg: string };

const CLIENTS: ClientName[] = ["claude", "codex", "antigravity"];
const LABELS: Record<ClientName, string> = { claude: "Claude Code", codex: "Codex", antigravity: "Antigravity" };
const SERVER_NAME = "infinite-canvas";
const require = createRequire(import.meta.url);

/** 解析 install-mcp 的命令行参数。 */
export function parseInstallArgs(argv: string[]) {
    const opts: { client: string; entry?: string; dryRun: boolean } = { client: "all", dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--client") opts.client = argv[++i] ?? "";
        else if (argv[i] === "--entry") opts.entry = argv[++i];
        else if (argv[i] === "--dry-run") opts.dryRun = true;
        else throw new Error(`未知参数：${argv[i]}`);
    }
    if (![...CLIENTS, "all"].includes(opts.client)) throw new Error(`不支持的客户端：${opts.client}，可选 claude、codex、antigravity、all`);
    return opts;
}

/** 生成稳定的 MCP 启动命令：绝对 node 路径 + 绝对入口文件 + mcp。 */
export function launchSpec(entry: string): LaunchSpec {
    return { command: process.execPath, args: [entry, "mcp"] };
}

/** 稳定运行时目录下的 canvas-agent 入口路径。 */
export function runtimeEntry(home: string) {
    return path.join(home, ".infinite-canvas", "runtime", "node_modules", "@basketikun", "canvas-agent", "dist", "index.js");
}

/** 安装当前版本的 canvas-agent 到稳定运行时目录，并返回入口文件。 */
export function installRuntime(home: string) {
    const runtime = path.join(home, ".infinite-canvas", "runtime");
    const pkgFile = path.join(runtime, "package.json");
    if (!fs.existsSync(pkgFile)) {
        fs.mkdirSync(runtime, { recursive: true });
        fs.writeFileSync(pkgFile, JSON.stringify({ name: "infinite-canvas-agent-runtime", private: true }, null, 2) + "\n");
    }
    const r = spawnSync("npm", ["install", "--prefix", runtime, `@basketikun/canvas-agent@${VERSION}`], { stdio: "inherit", shell: process.platform === "win32" });
    if (r.error || r.status !== 0) throw new Error(`npm 安装运行时失败：${r.error?.message ?? `退出码 ${r.status}`}`);
    const entry = runtimeEntry(home);
    if (!fs.existsSync(entry)) throw new Error(`运行时入口不存在：${entry}`);
    return entry;
}

/** 校验用户指定的入口文件，必须是存在的绝对路径。 */
export function checkEntry(entry: string) {
    if (!path.isAbsolute(entry) || !fs.existsSync(entry)) throw new Error(`入口文件不存在：${entry}`);
    return entry;
}

/** Antigravity 的 MCP 配置文件路径。 */
export function antigravityConfigFile(home: string) {
    return path.join(home, ".gemini", "config", "mcp_config.json");
}

/** 写入 Antigravity MCP 配置，保留其他配置项，首次修改前备份为 .bak。 */
export function writeAntigravityConfig(home: string, spec: LaunchSpec) {
    const file = antigravityConfigFile(home);
    const existed = fs.existsSync(file);
    let config: { mcpServers?: Record<string, unknown> } = {};
    if (existed) {
        const raw = fs.readFileSync(file, "utf8");
        try {
            config = JSON.parse(raw);
        } catch {
            throw new Error(`Antigravity MCP 配置不是有效 JSON：${file}`);
        }
        if (!fs.existsSync(`${file}.bak`)) fs.copyFileSync(file, `${file}.bak`);
    }
    config.mcpServers = { ...config.mcpServers, [SERVER_NAME]: { command: spec.command, args: spec.args, env: {} } };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
    return file;
}

/** 判断 Codex 是否已通过 Infinite Canvas 插件启用 MCP。 */
export function codexPluginEnabled(home: string) {
    const file = path.join(home, ".codex", "config.toml");
    if (!fs.existsSync(file)) return false;
    let inside = false;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const text = line.trim();
        if (text.startsWith("[")) inside = /^\[plugins\."infinite-canvas@[^"]+"\]/.test(text);
        else if (inside && /^enabled\s*=\s*true\b/.test(text)) return true;
    }
    return false;
}

/** 通过 stdio 发送 MCP initialize 与 tools/list，返回工具数量。 */
export function verifyMcp(spec: LaunchSpec, home = os.homedir()) {
    return new Promise<number>((resolve, reject) => {
        const env = { HOME: home, PATH: "", ...(process.platform === "win32" ? { USERPROFILE: home } : {}) };
        const child = spawn(spec.command, spec.args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + "\n");
        let buf = "";
        let stderr = "";
        const finish = (err?: Error, count = 0) => {
            clearTimeout(timer);
            child.kill();
            if (err) reject(err);
            else resolve(count);
        };
        const timer = setTimeout(() => finish(new Error("MCP 自检失败：20 秒内未响应")), 20000);
        child.stderr.on("data", (d) => (stderr += d));
        child.stdin.on("error", () => {});
        child.on("error", (e) => finish(new Error(`MCP 自检失败：${e.message}`)));
        child.on("exit", (code) => finish(new Error(`MCP 自检失败：进程提前退出（${code}）${stderr.slice(-300)}`)));
        child.stdout.on("data", (d) => {
            buf += d;
            for (let idx = buf.indexOf("\n"); idx >= 0; idx = buf.indexOf("\n")) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 1);
                let msg: { id?: number; result?: { tools?: unknown[] } };
                try {
                    msg = JSON.parse(line);
                } catch {
                    continue;
                }
                if (msg.id === 1) {
                    send({ jsonrpc: "2.0", method: "notifications/initialized" });
                    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
                }
                if (msg.id === 2) finish(undefined, msg.result?.tools?.length ?? 0);
            }
        });
        send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "install-mcp", version: VERSION } } });
    });
}

/** 注册到 Claude Code 用户级 MCP；找不到 claude 命令时只提示手动执行。 */
function claudeClient(spec: LaunchSpec, _home: string, dryRun: boolean): ClientResult {
    const add = ["mcp", "add", "-s", "user", SERVER_NAME, "--", spec.command, ...spec.args];
    if (dryRun) return { mark: "·", msg: `将执行：claude mcp remove ${SERVER_NAME} -s user；claude ${add.join(" ")}` };
    const shell = process.platform === "win32";
    spawnSync("claude", ["mcp", "remove", SERVER_NAME, "-s", "user"], { shell, stdio: "ignore" });
    const r = spawnSync("claude", add, { shell, encoding: "utf8", windowsHide: true });
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { mark: "-", msg: `未找到 claude 命令，请手动执行：claude ${add.join(" ")}` };
    if (r.error || r.status !== 0) throw new Error(r.error?.message ?? (r.stderr || `退出码 ${r.status}`));
    return { mark: "✓", msg: "已注册（用户级）" };
}

/** 注册到 Codex 全局 MCP；插件已提供时跳过。 */
function codexClient(spec: LaunchSpec, home: string, dryRun: boolean): ClientResult {
    if (codexPluginEnabled(home)) return { mark: "-", msg: "Codex 已通过 Infinite Canvas 插件提供 MCP，跳过" };
    const args = ["mcp", "add", SERVER_NAME, "--", spec.command, ...spec.args];
    if (dryRun) return { mark: "·", msg: `将执行：codex ${args.join(" ")}` };
    const bin = path.join(path.dirname(require.resolve("@openai/codex/package.json")), "bin", "codex.js");
    const r = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", windowsHide: true });
    if (r.error || r.status !== 0) throw new Error(r.error?.message ?? (r.stderr || `退出码 ${r.status}`));
    return { mark: "✓", msg: "已注册（全局）" };
}

/** 写入 Antigravity 的 MCP 配置文件。 */
function antigravityClient(spec: LaunchSpec, home: string, dryRun: boolean): ClientResult {
    if (dryRun) return { mark: "·", msg: `将写入 ${antigravityConfigFile(home)}` };
    return { mark: "✓", msg: `已写入 ${writeAntigravityConfig(home, spec)}` };
}

const HANDLERS: Record<ClientName, (spec: LaunchSpec, home: string, dryRun: boolean) => ClientResult> = {
    claude: claudeClient,
    codex: codexClient,
    antigravity: antigravityClient,
};

/** 执行 canvas-agent install-mcp：解析入口、逐个客户端注册并做 MCP 自检。 */
export async function runInstallMcp(argv: string[], home = os.homedir()) {
    let failed = false;
    try {
        const opts = parseInstallArgs(argv);
        const entry = opts.entry ? checkEntry(opts.entry) : opts.dryRun ? runtimeEntry(home) : installRuntime(home);
        const spec = launchSpec(entry);
        console.log(`启动命令：${spec.command} ${spec.args.join(" ")}`);
        const clients = opts.client === "all" ? CLIENTS : [opts.client as ClientName];
        for (const client of clients) {
            try {
                const r = HANDLERS[client](spec, home, opts.dryRun);
                console.log(`${r.mark} ${LABELS[client]}：${r.msg}`);
            } catch (e) {
                failed = true;
                console.log(`✗ ${LABELS[client]}：${(e as Error).message}`);
            }
        }
        if (!opts.dryRun) {
            try {
                console.log(`✓ MCP 自检通过：${await verifyMcp(spec, home)} 个工具`);
            } catch (e) {
                failed = true;
                console.log(`✗ ${(e as Error).message}`);
            }
        }
    } catch (e) {
        failed = true;
        console.log(`✗ ${(e as Error).message}`);
    }
    if (failed) process.exitCode = 1;
}
