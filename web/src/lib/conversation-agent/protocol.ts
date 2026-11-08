import type { AgentToolCall, AgentToolResult } from "./types";

export type ParsedAgentOutput = {
    displayText: string;
    toolCalls: AgentToolCall[];
    promptBlocks: string[];
    invalidCalls: Array<{ call: AgentToolCall; error: string }>;
};

const BLOCK_PATTERN = "```(tool|prompt)(?:[:\\s-]([a-zA-Z0-9_]+))?[ \\t]*\\r?\\n([\\s\\S]*?)```";
const FENCED_BLOCK_RE = /(```[\s\S]*?```)/g;
const COMPLETE_BLOCK_RE = new RegExp(BLOCK_PATTERN, "gi");
const OPEN_BLOCK_RE = /```(?:tool|prompt)(?:[:\s-][a-zA-Z0-9_]+)?/gi;

function parseToolBlock(body: string, headerTool?: string): { ok: true; call: AgentToolCall } | { ok: false; call: AgentToolCall; error: string } {
    let trimmed = body.trim();
    let inferredTool = (headerTool || "").trim();

    // 支持首行是工具名（如 ```tool\ncanvas_batch_generate_nodes\n{...}```）
    const firstLineMatch = trimmed.match(/^([a-zA-Z0-9_]+)\s*\r?\n([\s\S]+)$/);
    if (firstLineMatch && (firstLineMatch[1].startsWith("canvas_") || firstLineMatch[1].includes("image") || firstLineMatch[1].includes("prompt"))) {
        inferredTool = inferredTool || firstLineMatch[1];
        trimmed = firstLineMatch[2].trim();
    }

    let value: unknown;
    try {
        value = JSON.parse(trimmed);
    } catch {
        return { ok: false, call: { tool: inferredTool, arguments: {} }, error: "工具调用 JSON 解析失败" };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, call: { tool: inferredTool, arguments: {} }, error: "工具调用必须是 JSON 对象" };
    }
    const record = value as Record<string, unknown>;
    let tool = typeof record.tool === "string" ? record.tool.trim() : inferredTool;
    if (!tool) {
        if (Array.isArray(record.tasks)) {
            tool = "canvas_batch_generate_nodes";
        } else if (typeof record.prompt === "string") {
            tool = "generate_image";
        } else {
            return { ok: false, call: { tool: "", arguments: {} }, error: "工具调用缺少 tool 字段" };
        }
    }

    let args: Record<string, unknown> = {};
    if (record.arguments && typeof record.arguments === "object" && !Array.isArray(record.arguments)) {
        args = record.arguments as Record<string, unknown>;
    } else {
        // 允许扁平参数结构：除 tool 外所有字段均视作入参
        const { tool: _ignored, ...rest } = record;
        args = rest;
    }
    return { ok: true, call: { tool, arguments: args } };
}

/**
 * ChatGPT 网页端模型会输出自己的富文本组件标签（如 <AsyncImageGroup .../>、<text color="...">），
 * 这些标签在本项目里无法渲染，显示前统一剔除；代码块内容保持原样。
 */
export function sanitizeAssistantText(text: string) {
    if (!text.includes("<")) return text;
    return text
        .split(FENCED_BLOCK_RE)
        .map((part, index) => {
            if (index % 2 === 1) return part;
            return part
                .replace(/<(?!https?:\/\/)[A-Za-z][^<>]*\/>/g, "")
                .replace(/<\/(?!https?:\/\/)[A-Za-z][^<>]*>/g, "")
                .replace(/<(?!https?:\/\/)[A-Za-z][^<>]*>/g, "")
                .replace(/[ \t]+\n/g, "\n")
                .replace(/\n{3,}/g, "\n\n");
        })
        .join("")
        .trim();
}

/**
 * 从 ChatGPT 原生输出中提取 <AsyncImage query="..." aspectRatio="..." /> 标签。
 */
export function extractAsyncImages(raw: string): Array<{ prompt: string; size: string; title: string }> {
    const matches = [...raw.matchAll(/<AsyncImage\s+[^>]*query=["']([^"']+)["'](?:[^>]*aspectRatio=["']([^"']+)["'])?[^>]*\/?>/gi)];
    return matches.map((m, idx) => {
        const prompt = m[1].trim();
        const ratio = m[2]?.trim();
        const size = ratio === "16:9" ? "1536x864" : ratio === "9:16" ? "864x1536" : ratio === "3:4" ? "768x1024" : ratio === "21:9" ? "2016x864" : "1024x1024";
        return { prompt, size, title: `方案 ${idx + 1}` };
    });
}

/**
 * 部分大模型（如 ChatGPT 网页中转）未按规范使用 ```tool 围栏，而是直接在正文中输出了裸 JSON 对象，如：
 * {"size":"1536x864","n":1,"prompt":"..."} 或 {"tool":"generate_image","arguments":{...}}
 * 解析并将其转换为标准 AgentToolCall，同时从正文中清除该 JSON 字符串，避免裸代码泄露给用户。
 */
export function extractEmbeddedJsonToolCalls(text: string): { toolCalls: AgentToolCall[]; cleanedText: string } {
    const jsonMatch = text.match(/\{[\s\S]*?"(?:prompt|tasks|tool)"[\s\S]*?\}/);
    if (!jsonMatch) return { toolCalls: [], cleanedText: text };
    try {
        const rawJson = jsonMatch[0];
        const parsed = JSON.parse(rawJson);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const record = parsed as Record<string, unknown>;
            let tool = "";
            let args: Record<string, unknown> = {};
            if (typeof record.tool === "string" && record.tool) {
                tool = record.tool;
                args = (record.arguments as Record<string, unknown>) || record;
            } else if (Array.isArray(record.tasks)) {
                tool = "canvas_batch_generate_nodes";
                args = record;
            } else if (typeof record.prompt === "string" && record.prompt.trim()) {
                tool = "generate_image";
                args = record;
            }
            if (tool) {
                const cleanedText = text.replace(rawJson, "").trim();
                return {
                    toolCalls: [{ tool, arguments: args }],
                    cleanedText,
                };
            }
        }
    } catch {
        // 非合法 JSON，保持原样
    }
    return { toolCalls: [], cleanedText: text };
}

export function parseAgentOutput(raw: string): ParsedAgentOutput {
    const toolCalls: AgentToolCall[] = [];
    const promptBlocks: string[] = [];
    const invalidCalls: Array<{ call: AgentToolCall; error: string }> = [];
    const displayText = raw
        .replace(new RegExp(BLOCK_PATTERN, "gi"), (_match, type: string, headerTool: string | undefined, body: string) => {
            if (type.toLowerCase() === "prompt") {
                const text = body.trim();
                if (text) promptBlocks.push(text);
                return "";
            }
            const parsed = parseToolBlock(body, headerTool);
            if (parsed.ok) toolCalls.push(parsed.call);
            else invalidCalls.push({ call: parsed.call, error: parsed.error });
            return "";
        })
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    let finalDisplayText = displayText;
    if (!toolCalls.length) {
        const extracted = extractEmbeddedJsonToolCalls(finalDisplayText);
        if (extracted.toolCalls.length) {
            toolCalls.push(...extracted.toolCalls);
            finalDisplayText = extracted.cleanedText;
        }
    }

    // 如果模型没有输出 ```tool 代码块，但输出了 ChatGPT 原生 <AsyncImage query="..." /> 标签，将其转化为提示词块
    if (!toolCalls.length) {
        const asyncImages = extractAsyncImages(raw);
        for (const item of asyncImages) {
            if (item.prompt && !promptBlocks.includes(item.prompt)) {
                promptBlocks.push(item.prompt);
            }
        }
    }

    return { displayText: sanitizeAssistantText(finalDisplayText), toolCalls, promptBlocks, invalidCalls };
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
    // 屏蔽流式中的裸 JSON 工具调用对象
    output = output.replace(/\{[\s\S]*?"(?:prompt|tasks|tool)"[\s\S]*?\}/g, "");
    return sanitizeAssistantText(output.replace(/\n{3,}/g, "\n\n").trimEnd());
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
    if (result.tool === "generate_image" || result.tool === "edit_image") {
        const payload = {
            images: result.images.map((image) => ({ id: image.id, width: image.width, height: image.height })),
            model: result.model,
            size: result.size,
            count: result.count,
            ...(result.quota ? { quota: result.quota } : {}),
        };
        return `<tool_result name="${call.tool}" status="ok">${JSON.stringify(payload)}</tool_result>`;
    }
    if (result.tool.startsWith("canvas_")) {
        return `<tool_result name="${call.tool}" status="ok">${JSON.stringify(result)}</tool_result>`;
    }
    if (result.tool === "apply_prompt") {
        return `<tool_result name="apply_prompt" status="ok">${JSON.stringify({ target: result.target, filled: true })}</tool_result>`;
    }
    return `<tool_result name="${call.tool}" status="ok">${JSON.stringify(result)}</tool_result>`;
}
