import { nanoid } from "nanoid";

import { inferImageSizeFromPrompt } from "./aspect-ratio";
import { detectAgentIntent, extractFollowUpModification, findLastGenerationPrompt, REFERENCE_PROMPT_PATTERN, type AgentIntent } from "./intent";
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

/**
 * 判断一段 assistant 文本是否属于后置生图总结套话或空洞确认。
 * 这类套话如果在历史中透传给上游大模型，极易诱发大模型在下一次生成请求时「复读/照抄」上一轮的回答。
 */
/**
 * 判断一段 assistant 文本是否属于后置生图总结套话、空洞确认或上游推诿借口。
 * 这类套话如果在历史中透传给上游大模型，极易诱发大模型在下一次生成请求时「复读/照抄」上一轮的回答。
 */
export function isBoilerplateSummary(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return true;
    if (REFUSAL_PATTERN.test(trimmed)) return true;
    if (/^(?:已完成工具调用|图片生成已完成|任务已完成|已完成画布操作指令|生成成功)[。.]?$/i.test(trimmed)) return true;
    if (/^已为您在画布上(?:创建生图节点并启动精细渲染|批量创建节点并排布[，, ]正在并行启动渲染)[。.]?$/i.test(trimmed)) return true;
    // 去除开头装饰性 Emoji 与标点符号
    const clean = trimmed.replace(/^[\p{Extended_Pictographic}\s*•\-—~#✨🎨📦🔍🐈🐾❤️💙💚💛💜🧡🤍🖤]+/u, "").trim();
    if (/^(?:生成成功\s*)?已(?:为[您你])?生成(?:一只|一个|一张|一组|多张|[\d]+张)?/i.test(clean)) {
        // 如果包含尺寸、模型、构图或比例说明，属于典型生图后置总结卡片，从模型历史中过滤
        if (/尺寸|模型|GPT\s*Image|构图|像素|风格|背景/i.test(clean)) return true;
    }
    return false;
}

/**
 * 检测并剥离大模型偶发的「复读上一轮回答或复读用户问题」的问题（支持段落与长句多点命中及重复循环块消除）。
 */
export function stripEchoedPrefix(currentText: string, previousText?: string, userText?: string): string {
    let text = currentText.trimStart();
    if (userText) {
        const trimmedUser = userText.trim();
        if (trimmedUser.length >= 2 && text.startsWith(trimmedUser)) {
            text = text.slice(trimmedUser.length).replace(/^[，。；：\n\s]+/, "");
        }
    }
    if (previousText) {
        const trimmedPrev = previousText.trim();
        if (trimmedPrev.length >= 6) {
            if (text.startsWith(trimmedPrev)) {
                text = text.slice(trimmedPrev.length).replace(/^[，。；：\n\s]+/, "");
            } else {
                const sentences = trimmedPrev
                    .split(/[。\n！？!]/)
                    .map((s) => s.trim())
                    .filter((s) => s.length >= 6);
                for (const sentence of sentences) {
                    if (text.startsWith(sentence)) {
                        text = text.slice(sentence.length).replace(/^[，。；：\n\s]+/, "");
                    }
                }
            }
        }
    }
    // 消除重复循环块：如大模型出现「AAA BBB AAA BBB」式的整块复读
    const lines = text.split("\n");
    if (lines.length >= 4) {
        const half = Math.floor(lines.length / 2);
        const firstHalf = lines.slice(0, half).join("\n").trim();
        const secondHalf = lines.slice(half).join("\n").trim();
        if (firstHalf && firstHalf === secondHalf) {
            return firstHalf;
        }
    }
    return text;
}

export function toModelMessages(messages: AgentMessage[]): AgentModelMessage[] {
    const result: AgentModelMessage[] = [];
    for (const message of messages) {
        if (message.role === "user") {
            result.push({ role: "user", content: message.text });
        } else if (message.role === "assistant") {
            const rawContent = message.raw ?? message.text;
            // 过滤纯生图总结套话，避免模型在下一次生成时复读上一轮回复
            if (isBoilerplateSummary(rawContent)) continue;
            result.push({ role: "assistant", content: rawContent });
        } else if (message.role === "tool") {
            result.push({ role: "user", content: message.text });
        }
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
 *
 * 本地意图（options.intent）在此处生效：
 * - direct 的生成/改图意图直接执行工具，不调用模型；
 * - 其余生成/改图意图首轮注入意图指令，模型仍未调用工具时兜底强制执行一次。
 */
export const REFUSAL_PATTERN =
    /(无法|不能|不支持|不具备|没法|没有|未连接|临时聊天|切换到普通|暂时无法|不可用).{0,20}(执行|调用|使用|连接|具备)?(工具|生图|批量生图|图片生成|生成图片|功能|入口)|(?:暂时无法调用|等额度恢复后|额度恢复后|额度已用尽|达到限制|达到上限|额度不足)|resets in \d+\s*(?:minutes?|hours?|seconds?)|limit resets in|reached your .* limit|cannot execute|unable to execute|can't execute|don't have (the )?(ability|access).{0,20}tool|not able to (execute|call).{0,20}tool/i;
const GENERATION_INTENT_PATTERN = /(生成|出图|画一|画个|画张|改图|修改|编辑|参考图|image|generate|edit|画布|节点|并排|排开)/i;
const CORRECTION_TEXT =
    "【系统纠错】你具备工具调用能力，工具由无限画布前端执行，绝对不要说「无法执行工具 / 后端不支持 / 临时聊天 / 未连接画布工具」。请直接按协议输出 ```tool 代码块（严格 JSON）。在画布中生成或排布图片时，调用 canvas_batch_generate_nodes（批量）或 canvas_create_image_node（单张）；在对话中生成调用 generate_image；修改已有图片调用 edit_image。";

function extractNumberedPrompts(text: string, count: number, basePrompt: string): Array<{ title: string; prompt: string }> {
    const cleanBase = basePrompt.replace(/[（(][^）)]+[）)]/g, "").trim();
    const lines = text.split("\n");
    const items: Array<{ title: string; prompt: string }> = [];
    const itemPattern =
        /^(?:[\d+一二三四五六七八九]+[\s.、|｜:：]+|[*•\-—~#]+\s*|[❤️💙💚💛💜🧡🤍🖤✨🎨📦🔍]+\s*)?(?:(?:方案|风格|图层|素材|项目|版本)?[\d+一二三四五六七八九]+[:：\s.、]?\s*)?[*]*([^*：:\n—\-]{2,20})[*]*\s*[：:—\-]\s*(.+)$/;

    for (const line of lines) {
        const trimmed = line.trim();
        const match = trimmed.match(itemPattern);
        if (match) {
            const rawTitle = match[1].replace(/^[\d+一二三四五六七八九]+[\s.、|｜]+/, "").trim();
            const detail = match[2].trim();
            if (rawTitle && detail && detail.length >= 4) {
                const prompt = cleanBase ? `${cleanBase}，${rawTitle}：${detail}` : `${rawTitle}：${detail}`;
                items.push({ title: rawTitle || `素材 ${items.length + 1}`, prompt });
            }
        }
        if (items.length >= count) break;
    }
    if (items.length >= 2) return items;

    // 如果文本中未提取到编号项，但用户提示词中包含括号分项（如「红色生命、蓝色魔法、绿色体力」）
    const parenMatch = basePrompt.match(/[（(]([^）)]+)[）)]/);
    if (parenMatch) {
        const parts = parenMatch[1].split(/[、,，\s/|｜]+/).map((s) => s.trim()).filter(Boolean);
        if (parts.length >= 2) {
            return parts.slice(0, count).map((part) => ({
                title: part,
                prompt: cleanBase ? `${cleanBase}，${part}：精致高光，细节清晰，独立单体` : part,
            }));
        }
    }

    const result: Array<{ title: string; prompt: string }> = [];
    const targetCount = Math.max(2, Math.min(8, count || 4));
    const prefix = cleanBase || basePrompt;
    for (let i = 0; i < targetCount; i += 1) {
        result.push({
            title: `方案 ${i + 1}`,
            prompt: prefix ? `${prefix}，方案 ${i + 1}` : `设计方案 ${i + 1}`,
        });
    }
    return result;
}

export async function runAgentTurn(options: AgentRuntimeOptions): Promise<AgentTurnResult> {
    const maxRounds = Math.max(1, options.maxRounds ?? 8);
    const lastUserText = [...options.messages].reverse().find((message) => message.role === "user")?.text ?? "";
    const lastAssistantText = [...options.messages].reverse().find((m) => m.role === "assistant" && m.text.trim())?.text;
    // 页面未显式传 intent 时，用最后一条 user 消息在本地自动识别：/chat 页面无需改动即可获得 direct 执行与兜底。
    const intent = options.intent ?? detectAgentIntent(lastUserText, { hasReferences: (options.references?.length ?? 0) > 0, history: options.messages });
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
        const defaultSize = options.buildContext().defaultSize;
        const size = inferImageSizeFromPrompt(prompt, defaultSize);
        const format = intent.format || (/动图|动态表情包|动态图|\bgif\b|会动的/i.test(prompt) ? "gif" : undefined);
        const background = intent.background || (/透明底|透明背景|透明图|透明png|png透明|transparent/i.test(prompt) ? "transparent" : undefined);
        const hasCanvasTools = options.tools.some((t) => t.name === "canvas_batch_generate_nodes");
        const isCanvasTarget = hasCanvasTools && (intent.isCanvas || options.buildContext().pageContext === "canvas");

        let call: AgentToolCall;
        if (isCanvasTarget) {
            const isBatch = Boolean(intent.decompose || (intent.batchCount && intent.batchCount > 1));
            if (isBatch) {
                const count = intent.batchCount || 4;
                const subItems = extractNumberedPrompts(prompt, count, prompt);
                const tasks = subItems.map((item) => ({
                    prompt: item.prompt,
                    title: item.title,
                    size: inferImageSizeFromPrompt(item.prompt, "1024x1024"),
                    ...(background ? { background } : {}),
                }));
                call = {
                    tool: "canvas_batch_generate_nodes",
                    arguments: { tasks, layout: intent.layout || "horizontal", run: true },
                };
            } else {
                call = {
                    tool: "canvas_create_image_node",
                    arguments: {
                        prompt,
                        size,
                        title: intent.usageScene ? `${intent.usageScene}` : "AI 生图节点",
                        ...(background ? { background } : {}),
                        run: true,
                    },
                };
            }
        } else {
            call = {
                tool: (intentTool || "generate_image") as "generate_image" | "edit_image",
                arguments: {
                    prompt,
                    size,
                    ...(format ? { format } : {}),
                    ...(background ? { background } : {}),
                },
            };
        }
        options.onEvent?.({ type: "tool-start", call });
        const result = await options.executeTool(call, { signal: options.signal, references: options.references });
        options.onEvent?.({ type: "tool-end", call, result });
        newMessages.push({ id: nanoid(), role: "tool", call, result, text: serializeToolResult(call, result), createdAt: Date.now() });
        return result;
    };

    if (options.signal?.aborted) return { messages: newMessages, aborted: true, roundLimitReached: false };
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
        pendingDirective = buildIntentDirective(options.locale, intent, options.buildContext(), options.tools);
    }

    for (let round = 0; round < maxRounds; round += 1) {
        if (options.signal?.aborted) return { messages: newMessages, aborted: true, roundLimitReached: false };
        const turn = await options.callModel({
            systemPrompt: buildSystemPrompt({ locale: options.locale, context: options.buildContext(), tools: options.tools }),
            messages: [...toModelMessages([...options.messages, ...newMessages]), ...modelOnlyMessages, ...(pendingDirective ? [{ role: "user" as const, content: pendingDirective }] : [])],
            tools: options.tools,
            signal: options.signal,
            onDelta: (text) => {
                // 首轮生图/改图意图下，模型在工具调用前输出的前置构思/寒暄不外溢流出，
                // 彻底避免「先出现文字回答 -> 突然消失卡顿等待出图 -> 出图后再出现文字」的时序倒错
                if (round === 0 && intentTool) return;
                const cleaned = stripEchoedPrefix(stripForStreaming(text), lastAssistantText, lastUserText);
                options.onEvent?.({ type: "assistant-stream", text: cleaned });
            },
        });
        pendingDirective = null;
        if (options.signal?.aborted) return { messages: newMessages, aborted: true, roundLimitReached: false };

        const parsed = parseAgentOutput(turn.content);
        const refusal = REFUSAL_PATTERN.test(parsed.displayText) || REFUSAL_PATTERN.test(turn.content);
        let cleanedDisplayText = stripEchoedPrefix(parsed.displayText, lastAssistantText, lastUserText);
        if (refusal) {
            // 剥离大模型推诿拒绝的陈述（如「临时聊天/无法调用工具/等额度恢复后/resets in 35 minutes」），避免残留在对话流中
            cleanedDisplayText = cleanedDisplayText
                .replace(/.*(?:临时聊天|切换到普通|无法调用|后端不支持|不能执行工具|等额度恢复后|resets in \d+|额度限制|此对话中不可用).*$/gm, "")
                .trim();
        }
        const invalid: Array<{ call: AgentToolCall; error: string }> = [
            ...(turn.toolCallErrors || []).map((item) => ({ call: { tool: item.tool, arguments: {} }, error: item.error })),
            ...parsed.invalidCalls,
        ];
        const calls = [...turn.toolCalls, ...parsed.toolCalls];
        if (calls.length) modelToolCallMade = true;

        newMessages.push({ id: nanoid(), role: "assistant", text: cleanedDisplayText, raw: turn.content, promptBlocks: parsed.promptBlocks, createdAt: Date.now() });

        for (const item of invalid) {
            const result = invalidResult(item.call.tool, item.error);
            newMessages.push({ id: nanoid(), role: "tool", call: item.call, result, text: serializeToolResult(item.call, result), createdAt: Date.now() });
        }
        if (!calls.length && !invalid.length) {
            if (!correctionUsed && refusal && (GENERATION_INTENT_PATTERN.test(lastUserText) || intentTool !== null)) {
                correctionUsed = true;
                options.onEvent?.({ type: "correction-start", reason: "refusal" });
                modelOnlyMessages.push({ role: "assistant", content: turn.content });
                modelOnlyMessages.push({ role: "user", content: CORRECTION_TEXT });
                continue;
            }
            // 确定性兜底：模型一次工具都没调用（或推诿拒绝）时，按本地意图或推诿修复强制执行一次生成/改图，再让模型总结。
            const effectiveIntentTool = intentTool || (refusal && (findLastGenerationPrompt(options.messages) || GENERATION_INTENT_PATTERN.test(lastUserText)) ? "generate_image" : null);
            if (!intentHandled && !modelToolCallMade && effectiveIntentTool) {
                const hasCanvasTools = options.tools.some((t) => t.name === "canvas_batch_generate_nodes");
                const isCanvasTarget = hasCanvasTools && (intent.isCanvas || options.buildContext().pageContext === "canvas");

                if (isCanvasTarget) {
                    intentHandled = true;
                    if (intent.decompose || (intent.batchCount && intent.batchCount > 1) || parsed.promptBlocks.length > 1) {
                        const count = intent.batchCount || (parsed.promptBlocks.length > 1 ? parsed.promptBlocks.length : 4);
                        const layout = intent.layout || "horizontal";
                        let tasks: Array<{ prompt: string; title: string; size: string; background?: "transparent" }>;
                        if (parsed.promptBlocks.length >= 2) {
                            tasks = parsed.promptBlocks.slice(0, count).map((p, idx) => ({
                                prompt: p,
                                title: `方案 ${idx + 1}`,
                                size: inferImageSizeFromPrompt(p, "1024x1024"),
                                ...(intent.background ? { background: intent.background } : {}),
                            }));
                        } else {
                            const subItems = extractNumberedPrompts(parsed.displayText, count, intent.prompt);
                            tasks = subItems.map((item) => ({
                                prompt: item.prompt,
                                title: item.title,
                                size: inferImageSizeFromPrompt(item.prompt, "1024x1024"),
                                ...(intent.background ? { background: intent.background } : {}),
                            }));
                        }
                        const call: AgentToolCall = {
                            tool: "canvas_batch_generate_nodes",
                            arguments: { tasks, layout, run: true },
                        };
                        options.onEvent?.({ type: "tool-start", call });
                        const result = await options.executeTool(call, { signal: options.signal, references: options.references });
                        options.onEvent?.({ type: "tool-end", call, result });
                        newMessages.push({ id: nanoid(), role: "tool", call, result, text: serializeToolResult(call, result), createdAt: Date.now() });
                        if (result.ok === false && result.code === "canceled") return { messages: newMessages, aborted: true, roundLimitReached: false };
                        continue;
                    } else {
                        const historyPrompt = findLastGenerationPrompt(options.messages);
                        const followUpMod = lastUserText && !REFERENCE_PROMPT_PATTERN.test(lastUserText) ? extractFollowUpModification(lastUserText) : "";
                        const candidatePrompt = parsed.promptBlocks[0] || intent.prompt.trim() || (historyPrompt ? (followUpMod ? `${historyPrompt}，${followUpMod}` : historyPrompt) : "");
                        const prompt = candidatePrompt.trim();
                        if (prompt) {
                            const size = inferImageSizeFromPrompt(prompt, options.buildContext().defaultSize);
                            const call: AgentToolCall = {
                                tool: "canvas_create_image_node",
                                arguments: {
                                    prompt,
                                    size,
                                    title: intent.usageScene ? `${intent.usageScene}` : "AI 生图节点",
                                    ...(intent.background ? { background: intent.background } : {}),
                                    run: true,
                                },
                            };
                            options.onEvent?.({ type: "tool-start", call });
                            const result = await options.executeTool(call, { signal: options.signal, references: options.references });
                            options.onEvent?.({ type: "tool-end", call, result });
                            newMessages.push({ id: nanoid(), role: "tool", call, result, text: serializeToolResult(call, result), createdAt: Date.now() });
                            if (result.ok === false && result.code === "canceled") return { messages: newMessages, aborted: true, roundLimitReached: false };
                            continue;
                        }
                    }
                } else {
                    intentHandled = true;
                    const historyPrompt = findLastGenerationPrompt(options.messages);
                    // 在普通对话模式下，如果是拆解或批量生成任务，并发执行多张 generate_image
                    const isBatchChat = (intent.decompose || (intent.batchCount && intent.batchCount > 1)) && intentTool === "generate_image";
                    if (isBatchChat) {
                        const count = intent.batchCount || (parsed.promptBlocks.length > 1 ? parsed.promptBlocks.length : 3);
                        let subPrompts: string[] = [];
                        if (parsed.promptBlocks.length >= 2) {
                            subPrompts = parsed.promptBlocks.slice(0, count);
                        } else {
                            const subItems = extractNumberedPrompts(parsed.displayText, count, intent.prompt);
                            subPrompts = subItems.map((item) => item.prompt);
                        }
                        if (subPrompts.length >= 1) {
                            for (const subPrompt of subPrompts) {
                                if (options.signal?.aborted) break;
                                await runIntentTool(subPrompt);
                            }
                            continue;
                        }
                    }

                    const followUpMod = lastUserText && !REFERENCE_PROMPT_PATTERN.test(lastUserText) ? extractFollowUpModification(lastUserText) : "";
                    const candidatePrompt = parsed.promptBlocks[0] || intent.prompt.trim() || (historyPrompt ? (followUpMod ? `${historyPrompt}，${followUpMod}` : historyPrompt) : "");
                    const prompt = candidatePrompt.trim();
                    const hasReferenceForEdit = intentTool !== "edit_image" || (options.references ?? []).some((reference) => reference.storageKey);
                    if (prompt && hasReferenceForEdit) {
                        const result = await runIntentTool(prompt);
                        if (result.ok === false && result.code === "canceled") return { messages: newMessages, aborted: true, roundLimitReached: false };
                        continue;
                    }
                }
            }
            ensureAssistantSummary(newMessages);
            return { messages: newMessages, aborted: false, roundLimitReached: false };
        }

        const hasCanvasTools = options.tools.some((t) => t.name === "canvas_batch_generate_nodes");
        const isCanvasTarget = hasCanvasTools && (intent.isCanvas || options.buildContext().pageContext === "canvas");
        const isBatchIntent = Boolean(intent.decompose || (intent.batchCount && intent.batchCount > 1));

        let effectiveCalls = calls.slice(0, 8);
        if (isCanvasTarget && isBatchIntent && effectiveCalls.length === 1 && effectiveCalls[0].tool === "canvas_create_image_node") {
            // 用户明确要求批量排布（如4张头像/成套图标），模型却误调了单节点工具，自动升级为 canvas_batch_generate_nodes
            const count = intent.batchCount || 4;
            const singlePrompt = String(effectiveCalls[0].arguments.prompt || intent.prompt || "").trim();
            const subItems = extractNumberedPrompts(parsed.displayText, count, singlePrompt);
            const tasks = subItems.map((item) => ({
                prompt: item.prompt,
                title: item.title,
                size: inferImageSizeFromPrompt(item.prompt, "1024x1024"),
                ...(intent.background ? { background: intent.background } : {}),
            }));
            effectiveCalls = [{
                tool: "canvas_batch_generate_nodes",
                arguments: { tasks, layout: intent.layout || "horizontal", run: true },
            }];
        }

        for (const call of effectiveCalls) {
            if (options.signal?.aborted) return { messages: newMessages, aborted: true, roundLimitReached: false };
            options.onEvent?.({ type: "tool-start", call });
            const result = await options.executeTool(call, { signal: options.signal, references: options.references });
            options.onEvent?.({ type: "tool-end", call, result });
            newMessages.push({ id: nanoid(), role: "tool", call, result, text: serializeToolResult(call, result), createdAt: Date.now() });
            if (result.ok === false && result.code === "canceled") return { messages: newMessages, aborted: true, roundLimitReached: false };
        }
    }
    return { messages: newMessages, aborted: false, roundLimitReached: true };
}

function ensureAssistantSummary(messages: AgentMessage[]) {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === "tool") {
        let summaryText = "已完成工具调用。";
        if (lastMsg.call.tool === "canvas_batch_generate_nodes") {
            summaryText = "已为您在画布上批量创建节点并排布，正在并行启动渲染。";
        } else if (lastMsg.call.tool === "canvas_create_image_node") {
            summaryText = "已为您在画布上创建生图节点并启动精细渲染。";
        } else if (lastMsg.call.tool === "generate_image") {
            summaryText = "图片生成已完成。";
        }
        messages.push({ id: nanoid(), role: "assistant", text: summaryText, promptBlocks: [], createdAt: Date.now() });
    }
}
