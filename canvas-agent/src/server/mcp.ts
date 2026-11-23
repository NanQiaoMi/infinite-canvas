import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { toolDescriptions, toolInputSchemas, toolNames, type ToolName } from "../canvas/schemas.js";
import { AGENT_PROMPT, loadConfig, type CanvasAgentConfig, VERSION } from "../config.js";

type CanvasAgentToolResponse = { ok?: boolean; result?: unknown; error?: string };
export type McpImageBlock = { mimeType: string; data: string; label?: string };
export type McpToolContent =
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string };
export type BridgeHealth = { ok?: boolean; protocolVersion?: number; hasCanvas?: boolean; clients?: number; codexBusy?: boolean };

type ToolBridgeOptions = {
    readConfig?: () => CanvasAgentConfig;
    ensureBridge?: (config?: CanvasAgentConfig) => Promise<{ config: CanvasAgentConfig; health: BridgeHealth | null; started: boolean }>;
};

const DEFAULT_SITE_URL = "http://localhost:3000";
const BRIDGE_START_TIMEOUT_MS = 5000;
const BRIDGE_POLL_INTERVAL_MS = 250;
const HEALTH_TIMEOUT_MS = 1200;

let startingBridgePromise: Promise<{ config: CanvasAgentConfig; health: BridgeHealth | null; started: boolean }> | null = null;

function delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error || "unknown error");
}

/** 判断本地 Agent 地址是否指向本机回环接口（仅本机地址允许自动拉起）。 */
export function isLocalBridgeUrl(urlString: string) {
    try {
        const parsed = new URL(urlString);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
        return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname.toLowerCase());
    } catch {
        return false;
    }
}

/** 生成浏览器打开即可自动注入本地地址与 Token 的一键连接链接。 */
export function buildOneClickConnectUrl(config: Pick<CanvasAgentConfig, "url" | "token">, siteUrl = DEFAULT_SITE_URL) {
    let base = `${DEFAULT_SITE_URL}/`;
    try {
        const parsed = new URL((siteUrl || DEFAULT_SITE_URL).trim());
        base = parsed.pathname === "/" ? `${parsed.origin}/` : `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
    } catch {
        base = `${DEFAULT_SITE_URL}/`;
    }
    const hash = new URLSearchParams({ agentUrl: config.url, agentToken: config.token }).toString();
    return `${base}#${hash}`;
}

/** 探测本地 Canvas Agent HTTP 服务是否已就绪。 */
export async function probeBridgeHealth(urlString: string, timeoutMs = HEALTH_TIMEOUT_MS): Promise<BridgeHealth | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${urlString.replace(/\/+$/, "")}/health`, { signal: controller.signal });
        if (!res.ok) return null;
        const data = (await res.json().catch(() => null)) as BridgeHealth | null;
        return data?.ok ? data : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** 若本地 HTTP 桥接尚未运行且配置为本机地址，则后台拉起并短暂轮询等待就绪。 */
export async function ensureBridgeServer(initialConfig?: CanvasAgentConfig) {
    const current = initialConfig ?? loadConfig(true);
    const existing = await probeBridgeHealth(current.url);
    if (existing) return { config: current, health: existing, started: false };
    if (!isLocalBridgeUrl(current.url)) return { config: current, health: null, started: false };
    if (startingBridgePromise) return await startingBridgePromise;

    startingBridgePromise = (async () => {
        const isTs = import.meta.url.endsWith(".ts");
        const entryPath = fileURLToPath(new URL(isTs ? "../index.ts" : "../index.js", import.meta.url));
        const port = (() => {
            try {
                return new URL(current.url).port;
            } catch {
                return "";
            }
        })();
        const args = isTs ? [...process.execArgv, entryPath] : [entryPath];
        try {
            const child = spawn(process.execPath, args, {
                detached: true,
                stdio: "ignore",
                env: port ? { ...process.env, PORT: port } : process.env,
            });
            child.on("error", () => undefined);
            child.unref();
        } catch {
            return { config: current, health: null, started: false };
        }
        const deadline = Date.now() + BRIDGE_START_TIMEOUT_MS;
        while (Date.now() < deadline) {
            await delay(BRIDGE_POLL_INTERVAL_MS);
            const refreshed = loadConfig(true);
            const health = await probeBridgeHealth(refreshed.url);
            if (health) return { config: refreshed, health, started: true };
        }
        return { config: loadConfig(true), health: null, started: false };
    })().finally(() => {
        startingBridgePromise = null;
    });

    return await startingBridgePromise;
}

/** 为连接类错误补充本地状态诊断与浏览器一键连接地址。 */
export function enrichConnectionError(
    message: string,
    config: Pick<CanvasAgentConfig, "url" | "token">,
    options?: { siteUrl?: string; httpStatus?: number },
) {
    const connectUrl = buildOneClickConnectUrl(config, options?.siteUrl);
    if (options?.httpStatus === 401 || /invalid token/i.test(message)) {
        return `Canvas Agent 鉴权失败（${message}），本地 Token 可能已变更。请重试工具调用，或用一键连接地址重新连接浏览器：${connectUrl}`;
    }
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|network|abort/i.test(message)) {
        return `无法连接本地 Canvas Agent HTTP 服务（${config.url}）：${message}。请确认本地桥接已运行（终端可执行 npx -y @basketikun/canvas-agent@latest），连接后在浏览器打开一键连接地址：${connectUrl}`;
    }
    if (message.includes("当前没有已连接网页")) {
        return `本地 HTTP 桥接已就绪（${config.url}），但尚未连接浏览器网页。请在浏览器打开以下一键连接地址即可自动完成连接：${connectUrl}`;
    }
    if (message.includes("当前没有已连接画布")) {
        return `当前未打开画布或尚未连接网页：若浏览器已连接，请先调用 site_navigate({ path: "/canvas" }) 打开画布；若尚未连接网页，请在浏览器打开一键连接地址：${connectUrl}`;
    }
    return message;
}

/** 返回本地 HTTP 桥接和浏览器网页的连接状态，并按需自动拉起本机桥接。 */
export async function getConnectionStatus(
    input: { siteUrl?: string; autoStart?: boolean } = {},
    options: ToolBridgeOptions = {},
) {
    const readConfig = options.readConfig ?? (() => loadConfig(true));
    const ensureBridge = options.ensureBridge ?? ensureBridgeServer;
    let config = readConfig();
    let health = await probeBridgeHealth(config.url);
    let autoStarted = false;
    if (!health && input.autoStart !== false) {
        const ensured = await ensureBridge(config);
        config = ensured.config;
        health = ensured.health;
        autoStarted = ensured.started;
    }
    const bridgeReachable = Boolean(health?.ok);
    const connectedClients = Number(health?.clients || 0);
    const ready = bridgeReachable && connectedClients > 0;
    const oneClickConnectUrl = buildOneClickConnectUrl(config, input.siteUrl);
    return {
        ok: true,
        ready,
        bridgeReachable,
        autoStarted,
        bridgeUrl: config.url,
        protocolVersion: health?.protocolVersion ?? null,
        connectedClients,
        hasCanvas: Boolean(health?.hasCanvas),
        codexBusy: Boolean(health?.codexBusy),
        oneClickConnectUrl,
        nextStep: !bridgeReachable
            ? "本地 HTTP 桥接服务未响应，请在终端运行 npx -y @basketikun/canvas-agent@latest 后重试。"
            : connectedClients === 0
              ? "本地 HTTP 桥接服务已运行，但尚未连接浏览器。请让用户在浏览器打开 oneClickConnectUrl 自动完成连接。"
              : !health?.hasCanvas
                ? "浏览器已连接，但当前未停留在画布页；如需操作画布可先调用 site_navigate 打开 /canvas。"
                : "本地桥接与浏览器画布均已就绪，可直接调用画布或工作台工具。",
    };
}

/** 将工具返回值转换为 MCP content 列表；若含 _mcpImages，则拆出为原生 image 块。 */
export function formatMcpToolResult(result: unknown): { content: McpToolContent[] } {
    if (!result || typeof result !== "object" || Array.isArray(result) || !Array.isArray((result as { _mcpImages?: unknown })._mcpImages)) {
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    const { _mcpImages, ...rest } = result as Record<string, unknown> & { _mcpImages: unknown[] };
    const content: McpToolContent[] = [{ type: "text", text: JSON.stringify(rest, null, 2) }];
    for (const item of _mcpImages) {
        if (!item || typeof item !== "object") continue;
        const img = item as Partial<McpImageBlock>;
        if (typeof img.data !== "string" || !img.data) continue;
        if (typeof img.label === "string" && img.label.trim()) {
            content.push({ type: "text", text: img.label });
        }
        content.push({ type: "image", data: img.data, mimeType: img.mimeType || "image/jpeg" });
    }
    return { content };
}

/** 启动通过标准输入输出通信的 MCP 服务。 */
export async function startMcpServer() {
    const server = new McpServer({ name: "canvas-agent", version: VERSION }, { instructions: AGENT_PROMPT });
    toolNames.forEach((name) => registerCanvasTool(server, name));
    await server.connect(new StdioServerTransport());
}

/** 向 MCP Server 注册单个 Canvas Agent 工具。 */
function registerCanvasTool(server: McpServer, name: ToolName) {
    const schema = toolInputSchemas[name];
    server.registerTool(name, { description: toolDescriptions[name], inputSchema: schema.shape }, async (input: unknown) => {
        const parsed = schema.parse(input);
        const result = name === "canvas_connection_status"
            ? await getConnectionStatus(parsed as { siteUrl?: string; autoStart?: boolean })
            : await postCanvasAgentTool(name, parsed);
        return formatMcpToolResult(result);
    });
}

async function sendToolRequest(config: CanvasAgentConfig, name: ToolName, input: unknown) {
    const res = await fetch(`${config.url}/api/tools`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-canvas-agent-token": config.token },
        body: JSON.stringify({ name, input }),
    });
    const body = (await res.json().catch(() => ({}))) as CanvasAgentToolResponse;
    return { status: res.status, body };
}

/** 将 MCP 工具调用转发到本地 Canvas Agent HTTP 服务，并在 401/断连时自动热加载配置与拉起桥接重试一次。 */
export async function postCanvasAgentTool(name: ToolName, input: unknown, options: ToolBridgeOptions = {}): Promise<unknown> {
    const readConfig = options.readConfig ?? (() => loadConfig(true));
    const ensureBridge = options.ensureBridge ?? ensureBridgeServer;
    let config = readConfig();
    for (let attempt = 0; attempt < 2; attempt += 1) {
        let resInfo: { status: number; body: CanvasAgentToolResponse };
        try {
            resInfo = await sendToolRequest(config, name, input);
        } catch (error) {
            const msg = errorMessage(error);
            if (attempt === 0) {
                const ensured = await ensureBridge(config);
                config = ensured.config;
                if (ensured.health) continue;
            }
            throw new Error(enrichConnectionError(msg, config));
        }
        const { status, body } = resInfo;
        if (status === 401 && attempt === 0) {
            config = readConfig();
            continue;
        }
        if (!body.ok) {
            throw new Error(enrichConnectionError(body.error || `tool call failed (${status})`, config, { httpStatus: status }));
        }
        return body.result;
    }
    throw new Error(enrichConnectionError("tool call failed", config));
}
