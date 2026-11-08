import { nanoid } from "nanoid";

import { inferImageSizeFromPrompt } from "./aspect-ratio";
import { detectAgentIntent, extractFollowUpModification, findLastGenerationPrompt, FOLLOW_UP_PATTERN, REFERENCE_PROMPT_PATTERN, type AgentIntent } from "./intent";
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
    if (/^(?:生成成功|已成功生成|创作完成|生成完毕)/i.test(clean)) {
        if (/画幅|尺寸|模型|GPT\s*Image|构图|像素|风格|背景|细节|继续生成/i.test(clean)) return true;
    }
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
function getCorrectionText(isCanvas: boolean): string {
    return isCanvas
        ? "【系统纠错】你具备工具调用能力，工具由无限画布前端执行，绝对不要说「无法执行工具 / 处于临时聊天」。请直接按协议输出 ```tool 代码块（严格 JSON）。在画布中生成或排布图片时，调用 canvas_batch_generate_nodes（批量）或 canvas_create_image_node（单张）。"
        : "【系统纠错】你具备工具调用能力，工具由无限画布前端执行，绝对不要说「无法执行工具 / 处于临时聊天」。当前处于 AI 对话页面，请直接按协议输出 ```tool 代码块调用 generate_image（支持 count 参数最多 12 张）或 edit_image，严禁调用 canvas_* 画布工具。";
}

const META_LABEL_PATTERN =
    /^(?:主角|主体|角色|风格|画风|比例|尺寸|画幅|设定|统一设定|种状态|状态|动作|表情|数量|模型|格式|背景|环境|特点|要求|说明|提示词|方案名称|设计要求|五种状态|四种状态|三种状态|不同状态)$/i;

const DIVERSE_DESIGN_THEMES = [
    {
        title: "极简现代",
        style: "极简现代设计风格，大面积纯净留白与优雅排版空间，清晰视觉层级，柔和自然漫反射采光，高级克制莫兰迪色调，精致超清细节",
    },
    {
        title: "潮流视觉",
        style: "现代潮流视觉风格，前卫大胆的构图张力与空间层次对比，立体光影，鲜明视觉焦点，高质感材质细节，现代设计美学",
    },
    {
        title: "质感光影",
        style: "高端商业质感风格，电影级平衡布光与细腻材质纹理，典雅大气的视觉平衡构图，大师级色彩搭配，超清画质",
    },
    {
        title: "创意插画",
        style: "艺术插画视觉风格，流线型几何构图与灵动光效，丰富视觉肌理，优雅和谐的色彩氛围，精致层次感",
    },
    {
        title: "未来科技",
        style: "轻科技未来主义风格，通透半透明材质与细腻微光，纯净科技感背景，未来设计美学，超精细渲染",
    },
    {
        title: "复古人文",
        style: "复古人文美学风格，胶片质感与自然暖调光晕，温润纸质肌理，经典优雅排版空间，浓郁艺术氛围",
    },
];

export function extractNumberedPrompts(
    text: string,
    count: number,
    basePrompt: string,
): Array<{ title: string; prompt: string; size?: string }> {
    const cleanBase = basePrompt
        .replace(/[（(][^）)]+[）)]/g, "")
        .replace(/(?:再|重新)?(?:生成|画|来|做)?一?次/g, "")
        .replace(/(?:共|一共|总共)?\s*\d+\s*[张幅个套组次]/g, "")
        .replace(/^[，,。.!！、：:\s]+|[，,。.!！、：:\s]+$/g, "")
        .trim();

    const lines = text.split("\n");
    let detectedSubject = "";
    let detectedStyle = "";

    // 1. 优先检查文本中是否有枚举的状态行（如「五种状态：求抱抱、委屈哭哭、疯狂贴贴、求亲亲、翻肚皮撒娇」）
    for (const line of lines) {
        const trimmed = line.trim();
        const m = trimmed.match(/^[*•\-—~#\s]*([^*：:\n—\-]{2,20})[*]*\s*[：:—\-]\s*(.+)$/);
        if (m) {
            const label = m[1].trim();
            const val = m[2].trim();
            if (/主角|主体|角色/i.test(label)) detectedSubject = val.replace(/[。！!]$/, "");
            if (/风格|画风/i.test(label)) detectedStyle = val.replace(/[。！!]$/, "");
            if (/状态|动作|表情/i.test(label)) {
                const subStates = val.split(/[、，,；;]+/).map((s) => s.trim().replace(/[。！!]$/, "")).filter(Boolean);
                if (subStates.length >= 2) {
                    const subject = cleanBase || detectedSubject || "主体";
                    return subStates.slice(0, count).map((state) => ({
                        title: state,
                        prompt: `${subject}，${state}${detectedStyle ? `，${detectedStyle}` : "，生动细腻，主体居中"}`,
                        size: inferImageSizeFromPrompt(`${subject}，${state}`, "1024x1024"),
                    }));
                }
            }
        }
    }

    // 2. 检查是否有英文/中文编号括号分项，如 (1) ...; (2) ...; (3) ...
    const numParenMatches = [...text.matchAll(/\(([1-8一二三四五六七八])\)\s*([^;；\n]+)/g)];
    if (numParenMatches.length >= 2) {
        const subject = cleanBase || detectedSubject || "主体";
        return numParenMatches.slice(0, count).map((m, idx) => {
            const detail = m[2].trim().replace(/[。！!]$/, "");
            return {
                title: `方案 ${idx + 1}`,
                prompt: `${subject}，${detail}`,
                size: inferImageSizeFromPrompt(`${subject}，${detail}`, "1536x864"),
            };
        });
    }

    // 3. 逐行匹配常规列表项（如 1. 红色生命药水：...），排除元数据键名（如主角、风格、比例等）
    const items: Array<{ title: string; prompt: string; size?: string }> = [];
    const itemPattern =
        /^(?:[\d+一二三四五六七八九]+[\s.、|｜:：]+|[*•\-—~#]+\s*|[❤️💙💚💛💜🧡🤍🖤✨🎨📦🔍]+\s*)?(?:(?:方案|风格|图层|素材|项目|版本)?[\d+一二三四五六七八九]+[:：\s.、]?\s*)?[*]*([^*：:\n—\-]{2,20})[*]*\s*[：:—\-]\s*(.+)$/;

    for (const line of lines) {
        const trimmed = line.trim();
        const match = trimmed.match(itemPattern);
        if (match) {
            const rawTitle = match[1].replace(/^[\d+一二三四五六七八九]+[\s.、|｜]+/, "").trim();
            const detail = match[2].trim();
            if (rawTitle && detail && detail.length >= 4 && !META_LABEL_PATTERN.test(rawTitle)) {
                const prompt = cleanBase ? `${cleanBase}，${rawTitle}：${detail}` : `${rawTitle}：${detail}`;
                items.push({
                    title: rawTitle || `素材 ${items.length + 1}`,
                    prompt,
                    size: inferImageSizeFromPrompt(prompt, "1536x864"),
                });
            }
        }
        if (items.length >= count) break;
    }
    if (items.length >= 2) return items;

    // 4. 如果文本中未提取到编号项，但用户提示词中包含括号分项（如「红色生命、蓝色魔法、绿色体力」）
    const parenMatch = basePrompt.match(/[（(]([^）)]+)[）)]/);
    if (parenMatch) {
        const parts = parenMatch[1].split(/[、,，\s/|｜]+/).map((s) => s.trim()).filter(Boolean);
        if (parts.length >= 2) {
            return parts.slice(0, count).map((part) => ({
                title: part,
                prompt: cleanBase ? `${cleanBase}，${part}：精致高光，细节清晰，独立单体` : part,
                size: inferImageSizeFromPrompt(part, "1024x1024"),
            }));
        }
    }

    // 5. 智能创意分流：结合业务用途与多样化设计主题输出高质量方案，彻底告别死板的「设计稿，方案 1」
    const result: Array<{ title: string; prompt: string; size?: string }> = [];
    const targetCount = Math.max(2, Math.min(8, count || 4));
    const prefix = cleanBase || basePrompt;
    for (let i = 0; i < targetCount; i += 1) {
        const theme = DIVERSE_DESIGN_THEMES[i % DIVERSE_DESIGN_THEMES.length];
        const title = `方案 ${i + 1} · ${theme.title}`;
        const prompt = prefix ? `${prefix}，${theme.style}` : `创意视觉设计，${theme.style}`;
        const size = inferImageSizeFromPrompt(prefix || prompt, "1536x864");
        result.push({ title, prompt, size });
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

    let totalImagesGenerated = 0;
    const countImagesFromToolResult = (result: AgentToolResult): number => {
        if (!result.ok) return 0;
        if (result.tool === "generate_image" || result.tool === "edit_image") {
            return typeof result.count === "number" ? result.count : (Array.isArray(result.images) ? result.images.length : 1);
        }
        if (result.tool === "canvas_batch_generate_nodes") {
            return typeof result.count === "number" ? result.count : (Array.isArray(result.nodes) ? result.nodes.length : 1);
        }
        if (result.tool === "canvas_create_image_node") {
            return 1;
        }
        return 0;
    };
    const requestedImageCount = intent.batchCount || (intentTool ? 1 : 0);

    const runIntentTool = async (prompt: string, customSize?: string, customTitle?: string, customCount?: number) => {
        const defaultSize = options.buildContext().defaultSize;
        const size = customSize || intent.size || inferImageSizeFromPrompt(prompt, defaultSize);
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
                    size: item.size || inferImageSizeFromPrompt(item.prompt, "1024x1024"),
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
                        title: customTitle || (intent.usageScene ? `${intent.usageScene}` : "AI 生图节点"),
                        ...(background ? { background } : {}),
                        run: true,
                    },
                };
            }
        } else {
            const toolCount = typeof customCount === "number" && customCount > 0
                ? customCount
                : (intent.batchCount && intent.batchCount > 0 ? intent.batchCount : 1);
            call = {
                tool: (intentTool || "generate_image") as "generate_image" | "edit_image",
                arguments: {
                    prompt,
                    size,
                    count: toolCount,
                    ...(customTitle ? { title: customTitle } : {}),
                    ...(format ? { format } : {}),
                    ...(background ? { background } : {}),
                },
            };
        }
        options.onEvent?.({ type: "tool-start", call });
        const result = await options.executeTool(call, { signal: options.signal, references: options.references });
        options.onEvent?.({ type: "tool-end", call, result });
        totalImagesGenerated += countImagesFromToolResult(result);
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
        // 清理夹杂在文本回复中的裸露 JSON 块（如 {"size":"1024x1024","n":5,"prompt":"..."}）
        cleanedDisplayText = cleanedDisplayText
            .replace(/\{[^{}\n]*"size"[^{}\n]*"prompt"[^{}\n]*\}/g, "")
            .replace(/\{[^{}\n]*"prompt"[^{}\n]*"size"[^{}\n]*\}/g, "")
            .trim();
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

        if (
            totalImagesGenerated >= requestedImageCount &&
            requestedImageCount > 0 &&
            calls.some((c) => c.tool === "generate_image" || c.tool === "edit_image" || c.tool === "canvas_batch_generate_nodes" || c.tool === "canvas_create_image_node")
        ) {
            // 所有请求的图片已全部生成完毕，大模型违规再次发起生图工具调用，触发熔断，停止生成多余图片并直接总结
            ensureAssistantSummary(newMessages);
            return { messages: newMessages, aborted: false, roundLimitReached: false };
        }

        newMessages.push({ id: nanoid(), role: "assistant", text: cleanedDisplayText, raw: turn.content, promptBlocks: parsed.promptBlocks, createdAt: Date.now() });

        for (const item of invalid) {
            const result = invalidResult(item.call.tool, item.error);
            newMessages.push({ id: nanoid(), role: "tool", call: item.call, result, text: serializeToolResult(item.call, result), createdAt: Date.now() });
        }
        if (!calls.length && !invalid.length) {
            const hasCanvasTools = options.tools.some((t) => t.name === "canvas_batch_generate_nodes");
            const isCanvasTarget = hasCanvasTools && (intent.isCanvas || options.buildContext().pageContext === "canvas");
            if (!correctionUsed && refusal && (GENERATION_INTENT_PATTERN.test(lastUserText) || intentTool !== null)) {
                correctionUsed = true;
                options.onEvent?.({ type: "correction-start", reason: "refusal" });
                modelOnlyMessages.push({ role: "assistant", content: turn.content });
                modelOnlyMessages.push({ role: "user", content: getCorrectionText(isCanvasTarget) });
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
                        const prevAssistant = [...options.messages].reverse().find(
                            (m): m is Extract<AgentMessage, { role: "assistant" }> =>
                                m.role === "assistant" && Array.isArray(m.promptBlocks) && m.promptBlocks.length >= 2,
                        );
                        const historyPromptBlocks = prevAssistant?.promptBlocks;
                        let tasks: Array<{ prompt: string; title: string; size: string; background?: "transparent" }>;
                        if (parsed.promptBlocks.length >= 2) {
                            tasks = parsed.promptBlocks.slice(0, count).map((p: string, idx: number) => ({
                                prompt: p,
                                title: `方案 ${idx + 1}`,
                                size: inferImageSizeFromPrompt(p, "1024x1024"),
                                ...(intent.background === "transparent" ? { background: "transparent" as const } : {}),
                            }));
                        } else if (historyPromptBlocks && historyPromptBlocks.length >= 2) {
                            tasks = historyPromptBlocks.slice(0, count).map((p: string, idx: number) => ({
                                prompt: p,
                                title: `方案 ${idx + 1}`,
                                size: inferImageSizeFromPrompt(p, "1024x1024"),
                                ...(intent.background === "transparent" ? { background: "transparent" as const } : {}),
                            }));
                        } else {
                            const subItems = extractNumberedPrompts(parsed.displayText, count, intent.prompt);
                            tasks = subItems.map((item) => ({
                                prompt: item.prompt,
                                title: item.title,
                                size: inferImageSizeFromPrompt(item.prompt, "1024x1024"),
                                ...(intent.background === "transparent" ? { background: "transparent" as const } : {}),
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
                        const isFollowUpOrRef = Boolean(FOLLOW_UP_PATTERN.test(lastUserText) || REFERENCE_PROMPT_PATTERN.test(lastUserText));
                        const followUpMod = lastUserText && !REFERENCE_PROMPT_PATTERN.test(lastUserText) ? extractFollowUpModification(lastUserText) : "";
                        const candidatePrompt = parsed.promptBlocks[0] || intent.prompt.trim() || (isFollowUpOrRef && historyPrompt ? (followUpMod ? `${historyPrompt}，${followUpMod}` : historyPrompt) : "");
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
                        const prevAssistant = [...options.messages].reverse().find(
                            (m): m is Extract<AgentMessage, { role: "assistant" }> =>
                                m.role === "assistant" && Array.isArray(m.promptBlocks) && m.promptBlocks.length >= 2,
                        );
                        const historyPromptBlocks = prevAssistant?.promptBlocks;
                        let subTasks: Array<{ prompt: string; title?: string; size?: string }> = [];
                        if (parsed.promptBlocks.length >= 2) {
                            subTasks = parsed.promptBlocks.slice(0, count).map((p, idx) => ({
                                prompt: p,
                                title: `方案 ${idx + 1}`,
                                size: inferImageSizeFromPrompt(p, options.buildContext().defaultSize),
                            }));
                        } else if (historyPromptBlocks && historyPromptBlocks.length >= 2) {
                            subTasks = historyPromptBlocks.slice(0, count).map((p, idx) => ({
                                prompt: p,
                                title: `方案 ${idx + 1}`,
                                size: inferImageSizeFromPrompt(p, options.buildContext().defaultSize),
                            }));
                        } else {
                            subTasks = extractNumberedPrompts(parsed.displayText, count, intent.prompt);
                        }
                        if (subTasks.length >= 1) {
                            await Promise.all(
                                subTasks.map(async (task) => {
                                    if (options.signal?.aborted) return;
                                    await runIntentTool(task.prompt, task.size, task.title, 1);
                                }),
                            );
                            modelOnlyMessages.push({
                                role: "user",
                                content: `【系统提示】所有要求的 ${subTasks.length} 款设计方案图片已全部生成完毕并展示在界面中。请在本轮直接给出最终交付总结与设计说明，绝对不要再次调用任何生图工具！`,
                            });
                            continue;
                        }
                    }

                    const isFollowUpOrRef = Boolean(FOLLOW_UP_PATTERN.test(lastUserText) || REFERENCE_PROMPT_PATTERN.test(lastUserText));
                    const followUpMod = lastUserText && !REFERENCE_PROMPT_PATTERN.test(lastUserText) ? extractFollowUpModification(lastUserText) : "";
                    const candidatePrompt = parsed.promptBlocks[0] || intent.prompt.trim() || (isFollowUpOrRef && historyPrompt ? (followUpMod ? `${historyPrompt}，${followUpMod}` : historyPrompt) : "");
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
        } else if (!isCanvasTarget) {
            // 在普通对话模式下，如果大模型误调用了 canvas_* 工具，自动解包并降级为 generate_image，彻底避免 execution_failed 错误与恶性重试循环
            effectiveCalls = effectiveCalls.flatMap((call) => {
                if (call.tool === "canvas_batch_generate_nodes") {
                    const tasks = Array.isArray(call.arguments?.tasks) ? (call.arguments.tasks as Array<{ prompt?: string; size?: string; background?: string }>) : [];
                    if (tasks.length > 0) {
                        return tasks.map((task) => ({
                            tool: "generate_image" as const,
                            arguments: {
                                prompt: String(task.prompt || "").trim(),
                                size: task.size || "1024x1024",
                                count: 1,
                                ...(task.background ? { background: task.background } : {}),
                            },
                        }));
                    }
                } else if (call.tool === "canvas_create_image_node") {
                    return [{
                        tool: "generate_image" as const,
                        arguments: {
                            prompt: String(call.arguments?.prompt || "").trim(),
                            size: String(call.arguments?.size || "1024x1024").trim(),
                            count: 1,
                            ...(call.arguments?.background ? { background: call.arguments.background } : {}),
                        },
                    }];
                }
                return [call];
            });
        }

        const isAllImageCalls = effectiveCalls.every((c) => c.tool === "generate_image" || c.tool === "edit_image");
        if (isAllImageCalls && effectiveCalls.length > 1) {
            effectiveCalls.forEach((call) => options.onEvent?.({ type: "tool-start", call }));
            const executedResults = await Promise.all(
                effectiveCalls.map(async (call) => {
                    const result = await options.executeTool(call, { signal: options.signal, references: options.references });
                    options.onEvent?.({ type: "tool-end", call, result });
                    return { call, result };
                }),
            );
            for (const item of executedResults) {
                totalImagesGenerated += countImagesFromToolResult(item.result);
                newMessages.push({ id: nanoid(), role: "tool", call: item.call, result: item.result, text: serializeToolResult(item.call, item.result), createdAt: Date.now() });
                if (item.result.ok === false && item.result.code === "canceled") return { messages: newMessages, aborted: true, roundLimitReached: false };
            }
        } else {
            for (const call of effectiveCalls) {
                if (options.signal?.aborted) return { messages: newMessages, aborted: true, roundLimitReached: false };
                options.onEvent?.({ type: "tool-start", call });
                const result = await options.executeTool(call, { signal: options.signal, references: options.references });
                options.onEvent?.({ type: "tool-end", call, result });
                totalImagesGenerated += countImagesFromToolResult(result);
                newMessages.push({ id: nanoid(), role: "tool", call, result, text: serializeToolResult(call, result), createdAt: Date.now() });
                if (result.ok === false && result.code === "canceled") return { messages: newMessages, aborted: true, roundLimitReached: false };
            }
        }

        if (totalImagesGenerated >= requestedImageCount && requestedImageCount > 0) {
            modelOnlyMessages.push({
                role: "user",
                content: `【系统提示】用户要求的全部图片已成功生成完毕（共 ${totalImagesGenerated} 张）。请在此轮直接输出最终交付总结与设计说明，绝对不要再次调用任何生图工具！`,
            });
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
