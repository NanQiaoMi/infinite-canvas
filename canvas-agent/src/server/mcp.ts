import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { toolDescriptions, toolInputSchemas, toolNames, type ToolName } from "../canvas/schemas.js";
import { AGENT_PROMPT, loadConfig, type CanvasAgentConfig, VERSION } from "../config.js";

type CanvasAgentToolResponse = { ok?: boolean; result?: unknown; error?: string };
export type McpImageBlock = { mimeType: string; data: string; label?: string };
export type McpToolContent =
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string };

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
    const config = loadConfig(true);
    const server = new McpServer({ name: "canvas-agent", version: VERSION }, { instructions: AGENT_PROMPT });
    toolNames.forEach((name) => registerCanvasTool(server, config, name));
    await server.connect(new StdioServerTransport());
}

/** 向 MCP Server 注册单个 Canvas Agent 工具。 */
function registerCanvasTool(server: McpServer, config: CanvasAgentConfig, name: ToolName) {
    const schema = toolInputSchemas[name];
    server.registerTool(name, { description: toolDescriptions[name], inputSchema: schema.shape }, async (input: unknown) => {
        const result = await postCanvasAgentTool(config, name, schema.parse(input));
        return formatMcpToolResult(result);
    });
}

/** 将 MCP 工具调用转发到本地 Canvas Agent HTTP 服务。 */
async function postCanvasAgentTool(config: CanvasAgentConfig, name: ToolName, input: unknown) {
    const res = await fetch(`${config.url}/api/tools`, { method: "POST", headers: { "content-type": "application/json", "x-canvas-agent-token": config.token }, body: JSON.stringify({ name, input }) });
    const body = (await res.json()) as CanvasAgentToolResponse;
    if (!body.ok) throw new Error(body.error || "tool call failed");
    return body.result;
}
