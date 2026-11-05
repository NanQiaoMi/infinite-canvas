import { nanoid } from "nanoid";

import { parseAgentOutput, serializeToolResult, stripForStreaming } from "./protocol";
import { buildSystemPrompt } from "./system-prompt";
import type { AgentContextInput, AgentEvent, AgentImageRef, AgentMessage, AgentModelCall, AgentModelMessage, AgentToolCall, AgentToolDefinition, AgentToolExecutor, AgentToolResult, AgentTurnResult } from "./types";
import type { AgentLocale } from "./system-prompt";

export type AgentRuntimeOptions = {
    locale: AgentLocale;
    /** 历史消息，包含本轮的 user 消息。 */
    messages: AgentMessage[];
    tools: AgentToolDefinition[];
    buildContext: () => AgentContextInput;
    callModel: AgentModelCall;
    executeTool: AgentToolExecutor;
    onEvent?: (event: AgentEvent) => void;
    signal: AbortSignal;
    maxRounds?: number;
    /** 本轮可用的参考图（对话上传或上一轮生成结果）。 */
    references?: AgentImageRef[];
};

function toModelMessages(messages: AgentMessage[]): AgentModelMessage[] {
    const result: AgentModelMessage[] = [];
    for (const message of messages) {
        if (message.role === "user") result.push({ role: "user", content: message.text });
        else if (message.role === "assistant") result.push({ role: "assistant", content: message.raw ?? message.text });
        else if (message.role === "tool") result.push({ role: "user", content: message.text });
    }
    return result.slice(-40);
}

function invalidResult(tool: string, error: string): AgentToolResult {
    return { tool, ok: false, code: "invalid_args", error };
}

/**
 * 执行一轮对话：
 * 调模型 → 解析原生/文本工具调用 → 执行工具 → 把结果回填给模型 → 重复，直到没有工具调用或达到轮次上限。
 * 无 UI/网络依赖，便于单元测试注入假的 callModel / executeTool。
 */
const REFUSAL_PATTERN = /(无法|不能|不支持|不具备|没法).{0,16}(执行|调用|使用)?(工具|图片生成|生成图片)|cannot execute|unable to execute|can't execute|don't have (the )?(ability|access).{0,20}tool|not able to (execute|call).{0,20}tool/i;
const GENERATION_INTENT_PATTERN = /(生成|出图|画一|画个|画张|改图|修改|编辑|参考图|image|generate|edit)/i;
const CORRECTION_TEXT =
    "【系统纠错】你具备工具调用能力，工具由无限画布前端执行，不要说「无法执行工具 / 后端不支持」。请直接按协议输出 ```tool 代码块（严格 JSON）。用户要求生成或修改图片时，调用 generate_image（修改已有图片用 edit_image）；用户要求填入工作台时调用 apply_prompt。";

export async function runAgentTurn(options: AgentRuntimeOptions): Promise<AgentTurnResult> {
    const maxRounds = Math.max(1, options.maxRounds ?? 8);
    const newMessages: AgentMessage[] = [];
    const modelOnlyMessages: AgentModelMessage[] = [];
    let correctionUsed = false;
    const lastUserText = [...options.messages].reverse().find((message) => message.role === "user")?.text ?? "";
    for (let round = 0; round < maxRounds; round += 1) {
        if (options.signal.aborted) return { messages: newMessages, aborted: true, roundLimitReached: false };
        const turn = await options.callModel({
            systemPrompt: buildSystemPrompt({ locale: options.locale, context: options.buildContext(), tools: options.tools }),
            messages: [...toModelMessages([...options.messages, ...newMessages]), ...modelOnlyMessages],
            tools: options.tools,
            signal: options.signal,
            onDelta: (text) => options.onEvent?.({ type: "assistant-stream", text: stripForStreaming(text) }),
        });
        if (options.signal.aborted) return { messages: newMessages, aborted: true, roundLimitReached: false };

        const parsed = parseAgentOutput(turn.content);
        const invalid: Array<{ call: AgentToolCall; error: string }> = [
            ...(turn.toolCallErrors || []).map((item) => ({ call: { tool: item.tool, arguments: {} }, error: item.error })),
            ...parsed.invalidCalls,
        ];
        const calls = [...turn.toolCalls, ...parsed.toolCalls];
        newMessages.push({ id: nanoid(), role: "assistant", text: parsed.displayText, raw: turn.content, promptBlocks: parsed.promptBlocks, createdAt: Date.now() });

        for (const item of invalid) {
            const result = invalidResult(item.call.tool, item.error);
            newMessages.push({ id: nanoid(), role: "tool", call: item.call, result, text: serializeToolResult(item.call, result), createdAt: Date.now() });
        }
        if (!calls.length && !invalid.length) {
            const refusal = REFUSAL_PATTERN.test(parsed.displayText);
            if (!correctionUsed && refusal && GENERATION_INTENT_PATTERN.test(lastUserText)) {
                correctionUsed = true;
                modelOnlyMessages.push({ role: "user", content: CORRECTION_TEXT });
                continue;
            }
            return { messages: newMessages, aborted: false, roundLimitReached: false };
        }

        for (const call of calls.slice(0, 3)) {
            if (options.signal.aborted) return { messages: newMessages, aborted: true, roundLimitReached: false };
            options.onEvent?.({ type: "tool-start", call });
            const result = await options.executeTool(call, { signal: options.signal, references: options.references });
            options.onEvent?.({ type: "tool-end", call, result });
            newMessages.push({ id: nanoid(), role: "tool", call, result, text: serializeToolResult(call, result), createdAt: Date.now() });
            if (result.ok === false && result.code === "canceled") return { messages: newMessages, aborted: true, roundLimitReached: false };
        }
    }
    return { messages: newMessages, aborted: false, roundLimitReached: true };
}
