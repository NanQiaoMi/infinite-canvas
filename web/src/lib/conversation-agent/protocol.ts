import type { AgentToolCall, AgentToolResult } from "./types";

export type ParsedAgentOutput = {
    displayText: string;
    toolCalls: AgentToolCall[];
    promptBlocks: string[];
    invalidCalls: Array<{ call: AgentToolCall; error: string }>;
};

const BLOCK_PATTERN = "```(tool|prompt)[ \\t]*\\r?\\n([\\s\\S]*?)```";
const COMPLETE_BLOCK_RE = new RegExp(BLOCK_PATTERN, "gi");
const OPEN_BLOCK_RE = /```(?:tool|prompt)/gi;

function parseToolBlock(body: string): { ok: true; call: AgentToolCall } | { ok: false; call: AgentToolCall; error: string } {
    let value: unknown;
    try {
        value = JSON.parse(body.trim());
    } catch {
        return { ok: false, call: { tool: "", arguments: {} }, error: "工具调用 JSON 解析失败" };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, call: { tool: "", arguments: {} }, error: "工具调用必须是 JSON 对象" };
    }
    const record = value as Record<string, unknown>;
    const tool = typeof record.tool === "string" ? record.tool.trim() : "";
    if (!tool) return { ok: false, call: { tool: "", arguments: {} }, error: "工具调用缺少 tool 字段" };
    const rawArgs = record.arguments;
    if (rawArgs !== undefined && rawArgs !== null && (typeof rawArgs !== "object" || Array.isArray(rawArgs))) {
        return { ok: false, call: { tool, arguments: {} }, error: "工具参数 arguments 必须是对象" };
    }
    return { ok: true, call: { tool, arguments: (rawArgs as Record<string, unknown> | undefined) ?? {} } };
}

export function parseAgentOutput(raw: string): ParsedAgentOutput {
    const toolCalls: AgentToolCall[] = [];
    const promptBlocks: string[] = [];
    const invalidCalls: Array<{ call: AgentToolCall; error: string }> = [];
    const displayText = raw
        .replace(new RegExp(BLOCK_PATTERN, "gi"), (_match, type: string, body: string) => {
            if (type.toLowerCase() === "prompt") {
                const text = body.trim();
                if (text) promptBlocks.push(text);
                return "";
            }
            const parsed = parseToolBlock(body);
            if (parsed.ok) toolCalls.push(parsed.call);
            else invalidCalls.push({ call: parsed.call, error: parsed.error });
            return "";
        })
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    return { displayText, toolCalls, promptBlocks, invalidCalls };
}

/** 流式显示时屏蔽工具/提示词块，并隐藏尚未闭合的代码块内容。 */
export function stripForStreaming(text: string) {
    let output = text.replace(new RegExp(BLOCK_PATTERN, "gi"), "");
    const openings = [...output.matchAll(new RegExp(OPEN_BLOCK_RE.source, "gi"))];
    const last = openings[openings.length - 1];
    if (last && typeof last.index === "number") {
        const rest = output.slice(last.index + last[0].length);
        if (!rest.includes("```")) output = output.slice(0, last.index);
    }
    return output.replace(/\n{3,}/g, "\n\n").trimEnd();
}

export function nativeToolCallsToAgent(calls: Array<{ name: string; arguments: string }>) {
    const converted: AgentToolCall[] = [];
    const errors: Array<{ tool: string; error: string }> = [];
    for (const raw of calls) {
        const name = (raw.name || "").trim();
        if (!name) {
            errors.push({ tool: "", error: "工具调用缺少名称" });
            continue;
        }
        let args: unknown = {};
        try {
            args = raw.arguments ? JSON.parse(raw.arguments) : {};
        } catch {
            errors.push({ tool: name, error: "工具调用参数不是合法 JSON" });
            continue;
        }
        if (args === null || typeof args !== "object" || Array.isArray(args)) {
            errors.push({ tool: name, error: "工具调用参数必须是对象" });
            continue;
        }
        converted.push({ tool: name, arguments: args as Record<string, unknown> });
    }
    return { calls: converted, errors };
}

export function validateArguments(parameters: Record<string, unknown>, args: Record<string, unknown>) {
    const properties = (parameters.properties || {}) as Record<string, Record<string, unknown>>;
    const required = Array.isArray(parameters.required) ? (parameters.required as string[]) : [];
    const value: Record<string, unknown> = {};
    for (const key of required) {
        const current = args[key];
        if (current === undefined || current === null || current === "") return { ok: false as const, error: `缺少必填参数 ${key}` };
    }
    for (const [key, spec] of Object.entries(properties)) {
        const current = args[key];
        if (current === undefined || current === null) continue;
        const type = typeof spec.type === "string" ? spec.type : "";
        if (type === "string") {
            if (typeof current !== "string") return { ok: false as const, error: `参数 ${key} 必须是字符串` };
            if (current.length > 8000) return { ok: false as const, error: `参数 ${key} 过长` };
            value[key] = current;
        } else if (type === "integer") {
            const num = typeof current === "number" ? current : Number(String(current).trim());
            if (!Number.isInteger(num)) return { ok: false as const, error: `参数 ${key} 必须是整数` };
            if (typeof spec.minimum === "number" && num < spec.minimum) return { ok: false as const, error: `参数 ${key} 不能小于 ${spec.minimum}` };
            if (typeof spec.maximum === "number" && num > spec.maximum) return { ok: false as const, error: `参数 ${key} 不能大于 ${spec.maximum}` };
            value[key] = num;
        } else if (type === "number") {
            const num = typeof current === "number" ? current : Number(String(current).trim());
            if (!Number.isFinite(num)) return { ok: false as const, error: `参数 ${key} 必须是数字` };
            if (typeof spec.minimum === "number" && num < spec.minimum) return { ok: false as const, error: `参数 ${key} 不能小于 ${spec.minimum}` };
            if (typeof spec.maximum === "number" && num > spec.maximum) return { ok: false as const, error: `参数 ${key} 不能大于 ${spec.maximum}` };
            value[key] = num;
        } else if (type === "boolean") {
            if (typeof current !== "boolean") return { ok: false as const, error: `参数 ${key} 必须是布尔值` };
            value[key] = current;
        } else {
            value[key] = current;
        }
        if (Array.isArray(spec.enum) && !spec.enum.includes(value[key])) {
            return { ok: false as const, error: `参数 ${key} 不在允许范围` };
        }
    }
    return { ok: true as const, value };
}

export function serializeToolResult(call: AgentToolCall, result: AgentToolResult) {
    if (!result.ok) {
        return `<tool_result name="${call.tool}" status="error" code="${result.code}">${JSON.stringify({ error: result.error })}</tool_result>`;
    }
    if (result.tool === "generate_image") {
        const payload = {
            images: result.images.map((image) => ({ id: image.id, width: image.width, height: image.height })),
            model: result.model,
            size: result.size,
            count: result.count,
            ...(result.quota ? { quota: result.quota } : {}),
        };
        return `<tool_result name="generate_image" status="ok">${JSON.stringify(payload)}</tool_result>`;
    }
    return `<tool_result name="apply_prompt" status="ok">${JSON.stringify({ target: result.target, filled: true })}</tool_result>`;
}
