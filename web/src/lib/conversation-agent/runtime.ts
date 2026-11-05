import { nanoid } from "nanoid";

import { parseAgentOutput, serializeToolResult, stripForStreaming } from "./protocol";
import { buildSystemPrompt } from "./system-prompt";
import type { AgentContextInput, AgentEvent, AgentMessage, AgentModelCall, AgentModelMessage, AgentToolCall, AgentToolDefinition, AgentToolExecutor, AgentToolResult, AgentTurnResult } from "./types";
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
export async function runAgentTurn(options: AgentRuntimeOptions): Promise<AgentTurnResult> {
    const maxRounds = Math.max(1, options.maxRounds ?? 8);
    const newMessages: AgentMessage[] = [];
    for (let round = 0; round < maxRounds; round += 1) {
        if (options.signal.aborted) return { messages: newMessages, aborted: true, roundLimitReached: false };
        const turn = await options.callModel({
            systemPrompt: buildSystemPrompt({ locale: options.locale, context: options.buildContext(), tools: options.tools }),
            messages: toModelMessages([...options.messages, ...newMessages]),
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
        if (!calls.length && !invalid.length) return { messages: newMessages, aborted: false, roundLimitReached: false };

        for (const call of calls.slice(0, 3)) {
            if (options.signal.aborted) return { messages: newMessages, aborted: true, roundLimitReached: false };
            options.onEvent?.({ type: "tool-start", call });
            const result = await options.executeTool(call, { signal: options.signal });
            options.onEvent?.({ type: "tool-end", call, result });
            newMessages.push({ id: nanoid(), role: "tool", call, result, text: serializeToolResult(call, result), createdAt: Date.now() });
            if (result.ok === false && result.code === "canceled") return { messages: newMessages, aborted: true, roundLimitReached: false };
        }
    }
    return { messages: newMessages, aborted: false, roundLimitReached: true };
}
