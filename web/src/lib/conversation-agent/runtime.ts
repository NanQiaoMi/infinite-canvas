import { nanoid } from "nanoid";

import { detectAgentIntent, type AgentIntent } from "./intent";
import { parseAgentOutput, serializeToolResult, stripForStreaming } from "./protocol";
import { buildIntentDirective, buildSystemPrompt } from "./system-prompt";
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
    /** 本地意图识别结果；缺省时用最后一条 user 消息自动识别。 */
    intent?: AgentIntent;
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

/** 历史里最近一条 assistant 消息产出的提示词卡片，用于「再生成一版」这类续作请求的兜底。 */
function lastAssistantPromptBlock(messages: AgentMessage[]) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role === "assistant" && message.promptBlocks.length) return message.promptBlocks[0];
    }
    return "";
}

/**
 * 执行一轮对话：
 * 调模型 → 解析原生/文本工具调用 → 执行工具 → 把结果回填给模型 → 重复，直到没有工具调用或达到轮次上限。
 * 无 UI/网络依赖，便于单元测试注入假的 callModel / executeTool。
 *
 * 本地意图（options.intent）在此处生效：
 * - direct 的生成/改图意图直接执行工具，不调用模型；
 * - 其余生成/改图意图首轮注入意图指令，模型仍未调用工具时兜底强制执行一次。
 */
const REFUSAL_PATTERN = /(无法|不能|不支持|不具备|没法).{0,16}(执行|调用|使用)?(工具|图片生成|生成图片)|cannot execute|unable to execute|can't execute|don't have (the )?(ability|access).{0,20}tool|not able to (execute|call).{0,20}tool/i;
const GENERATION_INTENT_PATTERN = /(生成|出图|画一|画个|画张|改图|修改|编辑|参考图|image|generate|edit)/i;
const CORRECTION_TEXT =
    "【系统纠错】你具备工具调用能力，工具由无限画布前端执行，不要说「无法执行工具 / 后端不支持」。请直接按协议输出 ```tool 代码块（严格 JSON）。用户要求生成或修改图片时，调用 generate_image（修改已有图片用 edit_image）；用户要求填入工作台时调用 apply_prompt。";

export async function runAgentTurn(options: AgentRuntimeOptions): Promise<AgentTurnResult> {
    const maxRounds = Math.max(1, options.maxRounds ?? 8);
    const lastUserText = [...options.messages].reverse().find((message) => message.role === "user")?.text ?? "";
    // 页面未显式传 intent 时，用最后一条 user 消息在本地自动识别：/chat 页面无需改动即可获得 direct 执行与兜底。
    const intent = options.intent ?? detectAgentIntent(lastUserText, { hasReferences: (options.references?.length ?? 0) > 0 });
    /** 生成/改图意图对应的工具名；chat / apply_prompt 为 null。 */
    const intentTool = intent.kind === "generate_image" || intent.kind === "edit_image" ? intent.kind : null;
    const newMessages: AgentMessage[] = [];
    const modelOnlyMessages: AgentModelMessage[] = [];
    let correctionUsed = false;
    /** 意图工具是否已经执行过（direct 或兜底），用于避免重复执行与重复注入指令。 */
    let intentHandled = false;
    /** 模型是否已经产出过工具调用；只有一次都没有时才兜底。 */
    let modelToolCallMade = false;

    const runIntentTool = async (prompt: string) => {
        const call: AgentToolCall = { tool: intentTool as "generate_image" | "edit_image", arguments: { prompt } };
        options.onEvent?.({ type: "tool-start", call });
        const result = await options.executeTool(call, { signal: options.signal, references: options.references });
        options.onEvent?.({ type: "tool-end", call, result });
        newMessages.push({ id: nanoid(), role: "tool", call, result, text: serializeToolResult(call, result), createdAt: Date.now() });
        return result;
    };

    if (options.signal.aborted) return { messages: newMessages, aborted: true, roundLimitReached: false };
    /** 意图指令只注入首轮模型调用，一次即弃，避免总结轮再次看到「必须调用工具」而重复生成。 */
    let pendingDirective: string | null = null;
    if (intentTool && intent.direct && intent.prompt.trim()) {
        // 高置信度意图：直接执行工具，不调用模型。
        intentHandled = true;
        const result = await runIntentTool(intent.prompt.trim());
        if (result.ok === true) return { messages: newMessages, aborted: false, roundLimitReached: false, directToolResult: result };
        if (result.code === "canceled") return { messages: newMessages, aborted: true, roundLimitReached: false, directToolResult: result };
        // 其他失败：把错误结果留给模型解释，不再注入「必须生成」指令，也不再兜底，避免死循环。
    } else if (intentTool) {
        pendingDirective = buildIntentDirective(options.locale, intent);
    }

    for (let round = 0; round < maxRounds; round += 1) {
        if (options.signal.aborted) return { messages: newMessages, aborted: true, roundLimitReached: false };
        const turn = await options.callModel({
            systemPrompt: buildSystemPrompt({ locale: options.locale, context: options.buildContext(), tools: options.tools }),
            messages: [...toModelMessages([...options.messages, ...newMessages]), ...modelOnlyMessages, ...(pendingDirective ? [{ role: "user" as const, content: pendingDirective }] : [])],
            tools: options.tools,
            signal: options.signal,
            onDelta: (text) => options.onEvent?.({ type: "assistant-stream", text: stripForStreaming(text) }),
        });
        pendingDirective = null;
        if (options.signal.aborted) return { messages: newMessages, aborted: true, roundLimitReached: false };

        const parsed = parseAgentOutput(turn.content);
        const invalid: Array<{ call: AgentToolCall; error: string }> = [
            ...(turn.toolCallErrors || []).map((item) => ({ call: { tool: item.tool, arguments: {} }, error: item.error })),
            ...parsed.invalidCalls,
        ];
        const calls = [...turn.toolCalls, ...parsed.toolCalls];
        if (calls.length) modelToolCallMade = true;
        newMessages.push({ id: nanoid(), role: "assistant", text: parsed.displayText, raw: turn.content, promptBlocks: parsed.promptBlocks, createdAt: Date.now() });

        for (const item of invalid) {
            const result = invalidResult(item.call.tool, item.error);
            newMessages.push({ id: nanoid(), role: "tool", call: item.call, result, text: serializeToolResult(item.call, result), createdAt: Date.now() });
        }
        if (!calls.length && !invalid.length) {
            const refusal = REFUSAL_PATTERN.test(parsed.displayText);
            if (!correctionUsed && refusal && GENERATION_INTENT_PATTERN.test(lastUserText)) {
                correctionUsed = true;
                options.onEvent?.({ type: "correction-start", reason: "refusal" });
                modelOnlyMessages.push({ role: "user", content: CORRECTION_TEXT });
                continue;
            }
            // 确定性兜底：模型一次工具都没调用时，按本地意图强制执行一次生成/改图，再让模型总结。
            // prompt 只取意图提取结果或历史提示词卡片，绝不拿指令原文（如「用这个提示词生成图片」）去生图。
            if (!intentHandled && !modelToolCallMade && intentTool) {
                const historyPrompt = lastAssistantPromptBlock(options.messages);
                const prompt = (intent.prompt.trim() || historyPrompt).trim();
                const hasReferenceForEdit = intentTool !== "edit_image" || (options.references ?? []).some((reference) => reference.storageKey);
                if (prompt && hasReferenceForEdit) {
                    intentHandled = true;
                    const result = await runIntentTool(prompt);
                    if (result.ok === false && result.code === "canceled") return { messages: newMessages, aborted: true, roundLimitReached: false };
                    continue;
                }
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
