import { describe, expect, test } from "bun:test";

import { CHAT_INTENT, detectAgentIntent, type AgentIntent } from "@/lib/conversation-agent/intent";
import { runAgentTurn, type AgentRuntimeOptions } from "@/lib/conversation-agent/runtime";
import type { AgentContextInput, AgentEvent, AgentImageRef, AgentMessage, AgentModelCall, AgentModelTurnResult, AgentToolCall, AgentToolExecutor, AgentToolResult } from "@/lib/conversation-agent/types";

const context: AgentContextInput = {
    imageModels: ["gpt-image-2"],
    defaultImageModel: "gpt-image-2",
    defaultSize: "1024x1024",
    defaultQuality: "auto",
    defaultCount: "1",
    toolChannel: "text",
};

const userMessage: AgentMessage = { id: "u1", role: "user", text: "帮我生成一张苹果图", createdAt: 0 };

/** 用户直接粘贴的完整生图提示词，用于验证「不传 intent 时运行时自动识别」。 */
const JK_PROMPT =
    "真实摄影风格的日系JK少女，站在樱花飘落的校园小路上，白色水手服搭配百褶裙，回眸看向镜头微笑，50mm镜头，浅景深，自然光从侧面照来，柔和的光斑背景，胶片质感，细节丰富，避免过度磨皮和塑料感，8K高清。";

const generatedImages: AgentImageRef[] = [{ id: "img_1", width: 1024, height: 1024, prompt: "苹果", model: "gpt-image-2" }];

const generateSuccess: AgentToolResult = { tool: "generate_image", ok: true, model: "gpt-image-2", size: "1024x1024", count: 1, images: generatedImages };
const editSuccess: AgentToolResult = { tool: "edit_image", ok: true, model: "gpt-image-2", size: "1024x1024", count: 1, images: generatedImages };

function turn(content: string, extra: Partial<AgentModelTurnResult> = {}): AgentModelTurnResult {
    return { content, toolCalls: [], ...extra };
}

function createRunner(options: {
    turns: AgentModelTurnResult[];
    toolResult?: AgentToolResult;
    events?: AgentEvent[];
    intent?: AgentIntent;
    references?: AgentImageRef[];
    messages?: AgentMessage[];
    context?: Partial<AgentContextInput>;
    tools?: AgentToolDefinition[];
}) {
    const calls: string[][] = [];
    const toolCalls: AgentToolCall[] = [];
    let index = 0;
    const callModel: AgentModelCall = async ({ messages }) => {
        calls.push(messages.map((message) => `${message.role}:${message.content}`));
        const next = options.turns[Math.min(index, options.turns.length - 1)];
        index += 1;
        return next;
    };
    const executeTool: AgentToolExecutor = async (call) => {
        toolCalls.push(call);
        if (options.toolResult) return options.toolResult;
        if (call.tool === "generate_image") return generateSuccess;
        if (call.tool === "edit_image") return editSuccess;
        if (call.tool === "canvas_batch_generate_nodes") {
            return {
                tool: "canvas_batch_generate_nodes",
                ok: true,
                count: (call.arguments.items as unknown[])?.length ?? 1,
                createdNodes: [],
                layout: (call.arguments.layout as string) ?? "horizontal",
            };
        }
        return { tool: "apply_prompt", ok: true, target: "image", prompt: "苹果" };
    };
    const runtimeOptions: AgentRuntimeOptions = {
        locale: "zh",
        messages: options.messages ?? [userMessage],
        tools: options.tools ?? [
            { name: "generate_image", description: "生成图片", parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } },
            { name: "apply_prompt", description: "填入工作台", parameters: { type: "object", properties: { target: { type: "string" }, prompt: { type: "string" } }, required: ["target", "prompt"] } },
        ],
        buildContext: () => ({ ...context, ...options.context }),
        callModel,
        executeTool,
        onEvent: (event) => options.events?.push(event),
        signal: new AbortController().signal,
        intent: options.intent,
        references: options.references,
    };
    return { run: () => runAgentTurn(runtimeOptions), calls, toolCalls };
}

describe("对话运行时", () => {
    test("文本工具协议：调用工具、回填结果、给出最终回答", async () => {
        const events: AgentEvent[] = [];
        const runner = createRunner({
            turns: [turn('好的，我来生成。\n```tool\n{"tool":"generate_image","arguments":{"prompt":"红苹果"}}\n```'), turn("已经生成完成。")],
            events,
        });
        const result = await runner.run();
        expect(result.messages.map((message) => message.role)).toEqual(["assistant", "tool", "assistant"]);
        expect(result.messages[0].role === "assistant" && result.messages[0].text).toBe("好的，我来生成。");
        expect(result.messages[1].role === "tool" && result.messages[1].result.ok).toBe(true);
        expect(result.messages[2].role === "assistant" && result.messages[2].text).toBe("已经生成完成。");
        expect(runner.calls).toHaveLength(2);
        expect(runner.calls[1].some((entry) => entry.startsWith("user:<tool_result"))).toBe(true);
        expect(events.some((event) => event.type === "tool-start")).toBe(true);
        expect(events.some((event) => event.type === "tool-end")).toBe(true);
    });

    test("原生 function call 优先执行", async () => {
        const runner = createRunner({
            turns: [
                turn("", { toolCalls: [{ tool: "apply_prompt", arguments: { target: "image", prompt: "苹果" } }] }),
                turn("已填入工作台。"),
            ],
            toolResult: { tool: "apply_prompt", ok: true, target: "image", prompt: "苹果" },
        });
        const result = await runner.run();
        expect(result.messages.map((message) => message.role)).toEqual(["assistant", "tool", "assistant"]);
        expect(result.messages[1].role === "tool" && result.messages[1].result.ok).toBe(true);
    });

    test("非法工具块回填错误后模型可继续回答", async () => {
        // 显式 CHAT_INTENT：本用例只验证协议错误回填，不希望自动意图在第二轮触发兜底
        const runner = createRunner({ turns: [turn('```tool\n{"tool":"generate_image", oops}\n```'), turn("抱歉，我重新说明。")], intent: CHAT_INTENT });
        const result = await runner.run();
        expect(result.messages).toHaveLength(3);
        expect(result.messages[1].role === "tool" && result.messages[1].result.ok).toBe(false);
        expect(result.messages[2].role === "assistant" && result.messages[2].text).toBe("抱歉，我重新说明。");
    });

    test("模型声称无法执行工具时自动纠错并继续调用", async () => {
        const modelMessages: string[][] = [];
        const turns: AgentModelTurnResult[] = [
            turn("当前后端暂不支持直接执行图片生成工具，无法在这里实际生成图片。"),
            turn('```tool\n{"tool":"generate_image","arguments":{"prompt":"苹果"}}\n```'),
            turn("已经生成完成。"),
        ];
        let index = 0;
        const events: AgentEvent[] = [];
        const result = await runAgentTurn({
            locale: "zh",
            messages: [{ id: "u1", role: "user", text: "生成一张苹果图片", createdAt: 0 }],
            tools: [],
            buildContext: () => context,
            callModel: async ({ messages }) => {
                modelMessages.push(messages.map((message) => `${message.role}:${message.content}`));
                const next = turns[Math.min(index, turns.length - 1)];
                index += 1;
                return next;
            },
            executeTool: async () => ({
                tool: "generate_image",
                ok: true,
                model: "gpt-image-2",
                size: "1024x1024",
                count: 1,
                images: [{ id: "img_1", width: 1024, height: 1024, prompt: "苹果", model: "gpt-image-2" }],
            }),
            onEvent: (event) => events.push(event),
            signal: new AbortController().signal,
        });
        expect(modelMessages).toHaveLength(3);
        expect(modelMessages[2].some((entry) => entry.includes("系统纠错"))).toBe(true);
        expect(events.some((event) => event.type === "correction-start")).toBe(true);
        expect(result.messages.map((message) => message.role)).toEqual(["assistant", "assistant", "tool", "assistant"]);
        expect(result.messages[2].role === "tool" && result.messages[2].result.ok).toBe(true);
    });

    test("工具调用轮次过多时停止", async () => {
        const options: AgentRuntimeOptions = {
            locale: "zh",
            messages: [userMessage],
            tools: [],
            buildContext: () => context,
            callModel: async () => turn('```tool\n{"tool":"apply_prompt","arguments":{"target":"image","prompt":"x"}}\n```'),
            executeTool: async (call) => ({ tool: call.tool, ok: true, target: "image", prompt: "x" }),
            signal: new AbortController().signal,
            maxRounds: 2,
        };
        const result = await runAgentTurn(options);
        expect(result.roundLimitReached).toBe(true);
        expect(result.messages.filter((message) => message.role === "assistant")).toHaveLength(2);
    });

    test("direct 意图直接执行工具，不调用模型", async () => {
        const events: AgentEvent[] = [];
        const runner = createRunner({
            turns: [turn("模型不应该被调用")],
            events,
            intent: { kind: "generate_image", prompt: "一只红色苹果，白色背景，棚拍质感", explicit: true, direct: true },
        });
        const result = await runner.run();
        expect(runner.calls).toHaveLength(0);
        expect(runner.toolCalls).toHaveLength(1);
        expect(runner.toolCalls[0].tool).toBe("generate_image");
        expect(runner.toolCalls[0].arguments.prompt).toBe("一只红色苹果，白色背景，棚拍质感");
        expect(result.messages.map((message) => message.role)).toEqual(["tool"]);
        expect(result.messages[0].role === "tool" && result.messages[0].result.ok).toBe(true);
        expect(result.directToolResult).toEqual(generateSuccess);
        expect(events.map((event) => event.type)).toEqual(["tool-start", "tool-end"]);
    });

    test("direct 改图意图带参考图直接执行 edit_image", async () => {
        const references: AgentImageRef[] = [{ id: "ref_1", storageKey: "key_1", width: 512, height: 512, prompt: "", model: "gpt-image-2" }];
        const runner = createRunner({
            turns: [turn("模型不应该被调用")],
            references,
            intent: { kind: "edit_image", prompt: "把背景改成深蓝色", explicit: true, direct: true },
        });
        const result = await runner.run();
        expect(runner.calls).toHaveLength(0);
        expect(runner.toolCalls[0].tool).toBe("edit_image");
        expect(result.directToolResult).toEqual(editSuccess);
        expect(result.messages.map((message) => message.role)).toEqual(["tool"]);
    });

    test("direct 执行失败时继续交给模型解释，且不重复注入意图指令", async () => {
        const runner = createRunner({
            turns: [turn("生成失败了，可能是今日额度用完了。")],
            toolResult: { tool: "generate_image", ok: false, code: "quota_exceeded", error: "额度不足" },
            intent: { kind: "generate_image", prompt: "红苹果", explicit: true, direct: true },
        });
        const result = await runner.run();
        expect(runner.calls).toHaveLength(1);
        expect(result.messages.map((message) => message.role)).toEqual(["tool", "assistant"]);
        expect(result.directToolResult).toBeUndefined();
        expect(runner.calls[0].some((entry) => entry.includes("意图路由"))).toBe(false);
    });

    test("模型首轮只回文字时兜底执行 generate_image", async () => {
        const intent = detectAgentIntent("帮我生成一张赛博朋克海报", { hasReferences: false });
        expect(intent.direct).toBe(false);
        const runner = createRunner({
            turns: [turn("这个需求可以这样做：先确定主体，再补充镜头和光线……"), turn("已经生成完成。")],
            intent,
        });
        const result = await runner.run();
        expect(runner.calls).toHaveLength(2);
        // 首个模型请求包含意图指令
        expect(runner.calls[0].some((entry) => entry.includes("意图路由"))).toBe(true);
        // 兜底执行一次生成，然后让模型总结
        expect(runner.toolCalls).toHaveLength(1);
        expect(runner.toolCalls[0].tool).toBe("generate_image");
        expect(runner.toolCalls[0].arguments.prompt).toBe("赛博朋克海报");
        expect(result.messages.map((message) => message.role)).toEqual(["assistant", "tool", "assistant"]);
        expect(result.messages[1].role === "tool" && result.messages[1].result.ok).toBe(true);
        expect(result.directToolResult).toBeUndefined();
        // 意图指令只注入首轮：兜底生成后的总结轮不再包含意图指令，且工具只执行一次
        expect(runner.calls[1].some((entry) => entry.includes("意图路由"))).toBe(false);
        expect(runner.toolCalls).toHaveLength(1);
    });

    test("模型首轮已调用工具后，总结轮不再注入意图指令", async () => {
        const intent = detectAgentIntent("帮我生成一张赛博朋克海报", { hasReferences: false });
        const runner = createRunner({
            turns: [turn('```tool\n{"tool":"generate_image","arguments":{"prompt":"赛博朋克海报"}}\n```'), turn("已经生成完成。")],
            intent,
        });
        const result = await runner.run();
        expect(runner.calls).toHaveLength(2);
        expect(runner.calls[0].some((entry) => entry.includes("意图路由"))).toBe(true);
        expect(runner.calls[1].some((entry) => entry.includes("意图路由"))).toBe(false);
        expect(runner.toolCalls).toHaveLength(1);
        expect(result.messages.map((message) => message.role)).toEqual(["assistant", "tool", "assistant"]);
    });

    test("指代型生成请求用历史提示词卡片兜底", async () => {
        const promptBlock = "一只红苹果，白色背景，棚拍质感，柔和阴影，8K 高清";
        const messages: AgentMessage[] = [
            { id: "u1", role: "user", text: "帮我写一个苹果的提示词", createdAt: 0 },
            { id: "a1", role: "assistant", text: "给你：", promptBlocks: [promptBlock], createdAt: 0 },
            { id: "u2", role: "user", text: "用这个提示词生成图片", createdAt: 0 },
        ];
        const intent = detectAgentIntent("用这个提示词生成图片", { hasReferences: false });
        expect(intent.kind).toBe("generate_image");
        expect(intent.prompt).toBe("");
        const runner = createRunner({ turns: [turn("好的，我来生成。"), turn("已经生成完成。")], intent, messages });
        const result = await runner.run();
        expect(runner.toolCalls).toHaveLength(1);
        expect(runner.toolCalls[0].arguments.prompt).toBe(promptBlock);
        expect(result.messages.map((message) => message.role)).toEqual(["assistant", "tool", "assistant"]);
    });

    test("没有可用提示词时不做兜底，直接返回模型文字", async () => {
        const runner = createRunner({
            turns: [turn("请问你希望生成什么画面？")],
            intent: { kind: "generate_image", prompt: "", explicit: true, direct: false },
        });
        const result = await runner.run();
        expect(runner.calls).toHaveLength(1);
        expect(runner.toolCalls).toHaveLength(0);
        expect(result.messages.map((message) => message.role)).toEqual(["assistant"]);
        expect(result.messages[0].role === "assistant" && result.messages[0].text).toBe("请问你希望生成什么画面？");
    });

    test("帮助类提问按聊天处理，不注入意图指令也不执行工具", async () => {
        const intent = detectAgentIntent("如何生成图片？", { hasReferences: false });
        expect(intent.kind).toBe("chat");
        const runner = createRunner({ turns: [turn("在输入框里描述画面并发送，就会生成图片。")], intent });
        const result = await runner.run();
        expect(runner.calls).toHaveLength(1);
        expect(runner.calls[0].some((entry) => entry.includes("意图路由"))).toBe(false);
        expect(runner.toolCalls).toHaveLength(0);
        expect(result.messages.map((message) => message.role)).toEqual(["assistant"]);
    });

    test("不传 intent 时完整 JK 提示词自动直接出图，不调用模型", async () => {
        const runner = createRunner({
            turns: [turn("模型不应该被调用")],
            messages: [{ id: "u1", role: "user", text: JK_PROMPT, createdAt: 0 }],
        });
        const result = await runner.run();
        expect(runner.calls).toHaveLength(0);
        expect(runner.toolCalls).toHaveLength(1);
        expect(runner.toolCalls[0].tool).toBe("generate_image");
        expect(runner.toolCalls[0].arguments.prompt).toBe(JK_PROMPT);
        expect(result.messages.map((message) => message.role)).toEqual(["tool"]);
        expect(result.directToolResult?.ok).toBe(true);
    });

    test("不传 intent 时帮助提问正常走模型且不注入意图指令", async () => {
        for (const text of ["如何生成图片？", "生图工作台怎么用？"]) {
            const runner = createRunner({
                turns: [turn("在输入框里描述画面并发送即可。")],
                messages: [{ id: "u1", role: "user", text, createdAt: 0 }],
            });
            const result = await runner.run();
            expect(runner.calls).toHaveLength(1);
            expect(runner.calls[0].some((entry) => entry.includes("意图路由"))).toBe(false);
            expect(runner.toolCalls).toHaveLength(0);
            expect(result.messages.map((message) => message.role)).toEqual(["assistant"]);
        }
    });

    test("不传 intent 时模糊生成请求注入意图指令并在模型不调工具时兜底", async () => {
        const runner = createRunner({
            turns: [turn("这个需求可以这样做：先确定主体，再补充镜头和光线……"), turn("已经生成完成。")],
            messages: [{ id: "u1", role: "user", text: "帮我生成一张赛博朋克海报", createdAt: 0 }],
        });
        const result = await runner.run();
        expect(runner.calls).toHaveLength(2);
        expect(runner.calls[0].some((entry) => entry.includes("意图路由"))).toBe(true);
        expect(runner.toolCalls).toHaveLength(1);
        expect(runner.toolCalls[0].tool).toBe("generate_image");
        expect(runner.toolCalls[0].arguments.prompt).toBe("赛博朋克海报");
        expect(result.messages.map((message) => message.role)).toEqual(["assistant", "tool", "assistant"]);
        expect(result.directToolResult).toBeUndefined();
    });

    test("显式 intent 优先：传 chat 时完整提示词也不会自动生成", async () => {
        const runner = createRunner({
            turns: [turn("这是一段不错的提示词。")],
            messages: [{ id: "u1", role: "user", text: JK_PROMPT, createdAt: 0 }],
            intent: CHAT_INTENT,
        });
        const result = await runner.run();
        expect(runner.calls).toHaveLength(1);
        expect(runner.calls[0].some((entry) => entry.includes("意图路由"))).toBe(false);
        expect(runner.toolCalls).toHaveLength(0);
        expect(result.messages.map((message) => message.role)).toEqual(["assistant"]);
    });

    test("动图生成请求直连执行时自动带上 format: gif", async () => {
        const runner = createRunner({
            turns: [],
            messages: [{ id: "u1", role: "user", text: "生成一个猫咪动图：邪魅坏笑的橘猫，眼睛微微眯起，魔性表情", createdAt: 0 }],
        });
        const result = await runner.run();
        expect(runner.calls).toHaveLength(0);
        expect(runner.toolCalls).toHaveLength(1);
        expect(runner.toolCalls[0].tool).toBe("generate_image");
        expect(runner.toolCalls[0].arguments.format).toBe("gif");
        expect(result.directToolResult?.ok).toBe(true);
    });

    test("透明PNG生成请求直连执行时自动带上 background: transparent", async () => {
        const runner = createRunner({
            turns: [],
            messages: [{ id: "u1", role: "user", text: "生成png透明图片：一个红苹果，高光通透，单体居中", createdAt: 0 }],
        });
        const result = await runner.run();
        expect(runner.calls).toHaveLength(0);
        expect(runner.toolCalls).toHaveLength(1);
        expect(runner.toolCalls[0].tool).toBe("generate_image");
        expect(runner.toolCalls[0].arguments.background).toBe("transparent");
        expect(result.directToolResult?.ok).toBe(true);
    });

    test("画布批量生成指令识别出 isCanvas、layout 与数量", () => {
        const intent = detectAgentIntent("在画布上批量生成4张不同风格的赛博朋克猫咪头像，并排排开");
        expect(intent.isCanvas).toBe(true);
        expect(intent.decompose).toBe(true);
        expect(intent.layout).toBe("horizontal");
        expect(intent.batchCount).toBe(4);
    });

    test("画布模式下模型未调工具且输出多个编号提示词时兜底调度 canvas_batch_generate_nodes", async () => {
        const text = "在画布上批量生成4张不同风格的赛博朋克猫咪头像，并排排开";
        const intent = detectAgentIntent(text);
        const runner = createRunner({
            messages: [{ id: "u1", role: "user", text, createdAt: 0 }],
            turns: [
                turn(`好的，为你规划4个不同风格的头像：
1. 霓虹复古赛博猫咪头像，机械义眼，雨夜反光
2. 废土机甲赛博猫咪头像，战损金属外壳
3. 故障艺术电绘赛博猫咪头像，多重色彩偏移
4. 暗黑极简线条赛博猫咪头像，金色发光轮廓`),
                turn("已经在画布上成功生成4张头像节点。"),
            ],
            intent,
            context: { pageContext: "canvas", toolChannel: "text" },
            tools: [
                { name: "generate_image", description: "生成图片", parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } },
                { name: "canvas_batch_generate_nodes", description: "批量生成节点", parameters: { type: "object", properties: { tasks: { type: "array" } }, required: ["tasks"] } },
            ],
        });
        const result = await runner.run();
        expect(runner.toolCalls).toHaveLength(1);
        expect(runner.toolCalls[0].tool).toBe("canvas_batch_generate_nodes");
        expect((runner.toolCalls[0].arguments as { tasks: unknown[] }).tasks).toHaveLength(4);
        expect(runner.toolCalls[0].arguments.layout).toBe("horizontal");
        expect(result.messages.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"]);
    });

    test("复杂复合指令准确提取提示词、背景模式与套数数量", () => {
        const text = "在画布上生成一套 3 个透明底游戏魔法药水图标（红色生命、蓝色魔法、绿色体力）";
        const intent = detectAgentIntent(text);
        expect(intent.prompt).toBe("游戏魔法药水图标（红色生命、蓝色魔法、绿色体力）");
        expect(intent.background).toBe("transparent");
        expect(intent.batchCount).toBe(3);
        expect(intent.decompose).toBe(true);
    });

    test("普通对话 /chat 下拆解多素材请求在兜底时为每款素材调用 generate_image 并传入 transparent", async () => {
        const text = "在画布上生成一套 3 个透明底游戏魔法药水图标（红色生命、蓝色魔法、绿色体力）";
        const intent = detectAgentIntent(text);
        const runner = createRunner({
            messages: [{ id: "u1", role: "user", text, createdAt: 0 }],
            turns: [
                turn(`这套游戏魔法药水图标将采用统一的奇幻 RPG 道具设计语言：
红色生命药水：红宝石色药液，生命恢复符文。
蓝色魔法药水：幽蓝色药液，魔力流动与星芒特效。
绿色体力药水：翠绿色药液，自然藤蔓与能量光效。
统一采用 1:1 图标构图、透明背景。`),
                turn("已经为你全部生成完成！"),
            ],
            intent,
            context: { pageContext: "chat", toolChannel: "text" },
            tools: [
                { name: "generate_image", description: "生成图片", parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } },
                { name: "apply_prompt", description: "填入工作台", parameters: { type: "object", properties: { target: { type: "string" }, prompt: { type: "string" } }, required: ["target", "prompt"] } },
            ],
        });
        const result = await runner.run();
        expect(runner.toolCalls).toHaveLength(3);
        expect(runner.toolCalls.every((c) => c.tool === "generate_image")).toBe(true);
        expect(runner.toolCalls.every((c) => c.arguments.background === "transparent")).toBe(true);
        // 提示词必须准确包含对应药水，绝不能是 "，风格方案 1" 这种错词
        expect(runner.toolCalls[0].arguments.prompt).toContain("红色生命药水");
        expect(runner.toolCalls[0].arguments.prompt).not.toContain("风格方案");
        expect(runner.toolCalls[1].arguments.prompt).toContain("蓝色魔法药水");
        expect(runner.toolCalls[2].arguments.prompt).toContain("绿色体力药水");
        expect(result.messages.map((m) => m.role)).toEqual(["assistant", "tool", "tool", "tool", "assistant"]);
    });

    test("isBoilerplateSummary 正确识别后置生图套话与固定确认短语", async () => {
        const { isBoilerplateSummary } = await import("@/lib/conversation-agent/runtime");
        expect(isBoilerplateSummary("已完成工具调用。")).toBe(true);
        expect(isBoilerplateSummary("图片生成已完成。")).toBe(true);
        expect(isBoilerplateSummary("任务已完成。")).toBe(true);
        expect(isBoilerplateSummary("生成成功")).toBe(true);
        expect(isBoilerplateSummary("已为您在画布上创建生图节点并启动精细渲染。")).toBe(true);
        expect(isBoilerplateSummary("已为您在画布上批量创建节点并排布，正在并行启动渲染。")).toBe(true);
        expect(isBoilerplateSummary("已完成画布操作指令。")).toBe(true);
        expect(isBoilerplateSummary("已生成一张竖版海报素材，尺寸为 1086 x 1448，使用 GPT Image 2.6")).toBe(true);
        expect(isBoilerplateSummary("生成成功\n\n已为您生成一张图片，尺寸为 1024x1024。")).toBe(true);

        // 真实构思、分析或回答必须保留，不被误判为套话
        expect(isBoilerplateSummary("好的，为您构思如下画面：一只可爱的橘猫坐在阳光下……")).toBe(false);
        expect(isBoilerplateSummary("这套游戏魔法药水图标将采用统一的奇幻 RPG 道具设计语言")).toBe(false);
        expect(isBoilerplateSummary("在输入框里描述画面并发送，就会生成图片。")).toBe(false);
    });

    test("stripEchoedPrefix 正确剥离大模型复读上一轮回答的前缀", async () => {
        const { stripEchoedPrefix } = await import("@/lib/conversation-agent/runtime");
        const prev = "已生成一张竖版海报素材，尺寸为 1086 x 1448，使用 GPT Image 2.6";
        const currentWithEcho = "已生成一张竖版海报素材，尺寸为 1086 x 1448，使用 GPT Image 2.6。现在为您构思赛博朋克猫咪头像：";
        expect(stripEchoedPrefix(currentWithEcho, prev)).toBe("现在为您构思赛博朋克猫咪头像：");

        // 首句匹配测试
        const prevFirstSentence = "已生成一张竖版海报素材，采用冷色系。";
        const currentEchoFirst = "已生成一张竖版海报素材，采用冷色系。好的，为你绘制新的猫咪。";
        expect(stripEchoedPrefix(currentEchoFirst, prevFirstSentence)).toBe("好的，为你绘制新的猫咪。");

        // 多行前置换行复读命中测试（如上一轮先说生成成功，第二句才是海报素材，当前轮直接从第二句复读）
        const prevMultiLine = "生成成功\n\n已生成一张竖版海报素材，尺寸为 1086 x 1448，使用 GPT Image 2.6。";
        const currEchoSecond = "已生成一张竖版海报素材，尺寸为 1086 x 1448，使用 GPT Image 2.6。正在为您画一只可爱的猫咪。";
        expect(stripEchoedPrefix(currEchoSecond, prevMultiLine)).toBe("正在为您画一只可爱的猫咪。");

        // 无复读时原样返回
        const normalText = "好的，为您构思如下画面：";
        expect(stripEchoedPrefix(normalText, prev)).toBe(normalText);
    });

    test("formatSessionTitle 智能提炼会话标题并平滑省略", async () => {
        const { formatSessionTitle } = await import("@/stores/use-conversation-agent-store");
        expect(formatSessionTitle("在画布上批量生成4张不同风格的赛博朋克猫咪头像，并排排开")).toBe("4张不同风格的赛博朋克猫咪头像，并排...");
        expect(formatSessionTitle("生成png透明图片：一个红苹果")).toBe("一个红苹果");
        expect(formatSessionTitle("帮我生成海报素材")).toBe("海报素材");
        expect(formatSessionTitle("你好你能干什么")).toBe("你好你能干什么");
    });

    test("toModelMessages 自动剔除历史中的生图套话总结，防止模型在下一轮复读", async () => {
        const { toModelMessages } = await import("@/lib/conversation-agent/runtime");
        const history: AgentMessage[] = [
            { id: "u1", role: "user", text: "帮我生成海报素材", createdAt: 1 },
            { id: "a1", role: "assistant", text: "好的，为您构思如下海报画面……", promptBlocks: [], createdAt: 2 },
            { id: "t1", role: "tool", text: "<tool_result>ok</tool_result>", call: { tool: "generate_image", arguments: {} }, result: { tool: "generate_image", ok: true }, createdAt: 3 },
            { id: "a2", role: "assistant", text: "已生成一张竖版海报素材，尺寸为 1086 x 1448，使用 GPT Image 2.6", promptBlocks: [], createdAt: 4 },
            { id: "u2", role: "user", text: "换成赛博朋克风格", createdAt: 5 },
        ];
        const modelMsgs = toModelMessages(history);
        // a2 必须被过滤掉，不能传给大模型；a1（构思）必须保留
        expect(modelMsgs.some((m) => m.content.includes("已生成一张竖版海报素材"))).toBe(false);
        expect(modelMsgs.some((m) => m.content.includes("好的，为您构思如下海报画面"))).toBe(true);
        expect(modelMsgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "user"]);
    });

    test("模型推诿「临时聊天/无法调用工具」时自动拦截并完成确定性生图兜底，剔除推诿文字", async () => {
        const { runAgentTurn } = await import("@/lib/conversation-agent/runtime");
        const executedTools: string[] = [];
        const result = await runAgentTurn({
            locale: "zh-CN",
            messages: [
                { id: "u1", role: "user", text: "画一只可爱的柴犬", createdAt: 1 },
                {
                    id: "t1",
                    role: "tool",
                    call: { tool: "generate_image", arguments: { prompt: "一只活泼可爱的赤色柴犬" } },
                    result: { tool: "generate_image", ok: true, images: [], count: 1, size: "1024x1024" },
                    text: "<tool_result>ok</tool_result>",
                    createdAt: 2,
                },
                { id: "u2", role: "user", text: "再生成一个", createdAt: 3 },
            ],
            tools: [
                {
                    name: "generate_image",
                    description: "生成图片",
                    parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
                },
            ],
            buildContext: () => ({ defaultSize: "1024x1024", pageContext: "chat", imageModels: [] }),
            callModel: async () => ({
                content: "目前你使用的是临时聊天，请切换到普通聊天使用图片生成工具。",
                toolCalls: [],
            }),
            executeTool: async (call) => {
                executedTools.push(call.tool);
                return { tool: call.tool, ok: true, images: [], count: 1, size: "1024x1024" };
            },
            signal: new AbortController().signal,
        });

        // 验证工具被自动兜底触发执行，且继承了上一轮的柴犬提示词
        expect(executedTools).toContain("generate_image");
        // 验证模型推诿的拒绝陈述已被剥离，不会把「临时聊天」展示给用户
        const assistantMsgs = result.messages.filter((m) => m.role === "assistant");
        expect(assistantMsgs.every((m) => !m.text.includes("临时聊天"))).toBe(true);
    });

    test("上游额度借口（resets in 35 minutes / 这次暂时无法调用）自动拦截并执行生图兜底，消除复读循环", async () => {
        const { runAgentTurn, isBoilerplateSummary, stripEchoedPrefix } = await import("@/lib/conversation-agent/runtime");

        // 1. 验证总结卡片与额度推诿借口被判定为 boilerplate
        expect(
            isBoilerplateSummary("🐈 已生成一只可爱的橘白小猫！采用写实摄影风格，方形构图，阳光草地背景。尺寸 1254 × 1254，模型 GPT Image 2.6。"),
        ).toBe(true);
        expect(isBoilerplateSummary("这次暂时无法调用图片生成工具。等额度恢复后，可以生成一只双爪合十的猫。")).toBe(true);
        expect(isBoilerplateSummary("It resets in 35 minutes.")).toBe(true);

        // 2. 验证复读清洗
        expect(stripEchoedPrefix("要双爪合十求抱抱 这是一只可爱小猫", undefined, "要双爪合十求抱抱")).toBe("这是一只可爱小猫");

        // 3. 验证端到端运行
        const executedCalls: any[] = [];
        const result = await runAgentTurn({
            locale: "zh-CN",
            messages: [
                { id: "u1", role: "user", text: "画一只可爱的橘白小猫", createdAt: 1 },
                {
                    id: "a1",
                    role: "assistant",
                    text: "🐈 已生成一只可爱的橘白小猫！你还可以尝试更可爱！摸摸」或者「双爪合十求抱抱」！",
                    promptBlocks: ["一只可爱的橘白小猫，阳光草地背景，柔软毛发"],
                    createdAt: 2,
                },
                { id: "u2", role: "user", text: "要双爪合十求抱抱", createdAt: 3 },
            ],
            tools: [
                {
                    name: "generate_image",
                    description: "生成图片",
                    parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
                },
            ],
            buildContext: () => ({ defaultSize: "1024x1024", pageContext: "chat", imageModels: [] }),
            callModel: async () => ({
                content:
                    "这次暂时无法调用图片生成工具。等额度恢复后，可以生成一只双爪合十、眼巴巴望着镜头、奶声奶气求抱抱的胖橘猫。🐈💕 It resets in 35 minutes.",
                toolCalls: [],
            }),
            executeTool: async (call) => {
                executedCalls.push(call);
                return { tool: call.tool, ok: true, images: [], count: 1, size: "1024x1024" };
            },
            signal: new AbortController().signal,
        });

        // 确认工具成功执行，且带上了双爪合十求抱抱
        expect(executedCalls.length).toBeGreaterThan(0);
        expect(executedCalls[0].arguments.prompt).toContain("双爪合十求抱抱");
        // 确认上游推诿文本已被清洗
        const assistantTexts = result.messages.filter((m) => m.role === "assistant").map((m) => m.text);
        expect(assistantTexts.some((t) => t.includes("resets in") || t.includes("暂时无法调用"))).toBe(false);
    });

    test("在画布环境（pageContext: canvas）下，高置信度意图直连下发 canvas_create_image_node 或 canvas_batch_generate_nodes", async () => {
        const { runAgentTurn } = await import("@/lib/conversation-agent/runtime");
        const executedTools: string[] = [];
        await runAgentTurn({
            locale: "zh-CN",
            messages: [{ id: "u1", role: "user", text: "生成图片：一个红苹果，高光", createdAt: 1 }],
            tools: [
                {
                    name: "canvas_create_image_node",
                    description: "在画布上创建图片节点",
                    parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
                },
                {
                    name: "canvas_batch_generate_nodes",
                    description: "在画布上批量创建图片节点",
                    parameters: { type: "object", properties: { tasks: { type: "array" } }, required: ["tasks"] },
                },
            ],
            buildContext: () => ({ defaultSize: "1024x1024", pageContext: "canvas", imageModels: [] }),
            callModel: async () => ({ content: "已生成", toolCalls: [] }),
            executeTool: async (call) => {
                executedTools.push(call.tool);
                return { tool: call.tool, ok: true, nodeId: "n1", title: "测试", prompt: "苹果", size: "1024x1024", position: { x: 0, y: 0 } };
            },
            signal: new AbortController().signal,
        });

        expect(executedTools).toContain("canvas_create_image_node");
    });

    test("extractNumberedPrompts 解析规格清单（主角/风格/比例/五种状态）时不会提取元标签，而是组合出完整状态提示词", async () => {
        const { extractNumberedPrompts } = await import("@/lib/conversation-agent/runtime");
        const modelSpecText = `统一设定：
主角：圆滚滚、肉嘟嘟的大橘猫。
风格：Q版萌系、粗黑描边、夸张表情。
比例：每张 1:1。
五种状态：求抱抱、委屈哭哭、疯狂贴贴、求亲亲、翻肚皮撒娇。
目前请切换到普通聊天使用图片生成，继续沿用这套完整的五张设计要求。`;

        const prompts = extractNumberedPrompts(modelSpecText, 5, "再生成一次，共5张");
        expect(prompts).toHaveLength(5);
        // 不应包含「主角」、「风格」、「比例」等标签名作为提示词
        for (const p of prompts) {
            expect(p.prompt).not.toMatch(/^(?:主角|风格|比例|五种状态|统一设定)/);
            expect(p.prompt).not.toContain("一次，共5张");
        }
        // 应包含五种不同状态
        expect(prompts[0].prompt).toContain("求抱抱");
        expect(prompts[1].prompt).toContain("委屈哭哭");
        expect(prompts[2].prompt).toContain("疯狂贴贴");
        expect(prompts[3].prompt).toContain("求亲亲");
        expect(prompts[4].prompt).toContain("翻肚皮撒娇");
    });

    test("当上一轮助手已提供 promptBlocks 且用户要求「生成三张设计稿」时，运行时直接继承历史 promptBlocks 出图", async () => {
        const { runAgentTurn } = await import("@/lib/conversation-agent/runtime");
        const executedPrompts: string[] = [];
        const result = await runAgentTurn({
            locale: "zh-CN",
            messages: [
                { id: "u1", role: "user", text: "帮我构思三个界面设计方案", createdAt: 1 },
                {
                    id: "a1",
                    role: "assistant",
                    text: "为你构思了三个方案：\n1. 移动端极简设计\n2. AI 聊天 Web 应用\n3. 现代电商桌面端",
                    promptBlocks: [
                        "modern mobile app UI design clean aesthetic",
                        "modern AI chat web application UI design",
                        "modern ecommerce website UI design desktop",
                    ],
                    createdAt: 2,
                },
                { id: "u2", role: "user", text: "生成三张设计稿", createdAt: 3 },
            ],
            tools: [
                {
                    name: "generate_image",
                    description: "生成图片",
                    parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
                },
            ],
            buildContext: () => ({ defaultSize: "1024x1024", pageContext: "chat", imageModels: [] }),
            callModel: async () => ({
                content: "好的，马上为你生成三张设计稿！",
                toolCalls: [],
            }),
            executeTool: async (call) => {
                executedPrompts.push(String(call.arguments.prompt || ""));
                return { tool: call.tool, ok: true, images: [], count: 1, size: "1024x1024" };
            },
            signal: new AbortController().signal,
        });

        expect(executedPrompts).toHaveLength(3);
        // 验证执行的提示词继承了上一轮的 3 个 promptBlocks，而不是泛泛的「设计稿，方案 1」
        expect(executedPrompts[0]).toBe("modern mobile app UI design clean aesthetic");
        expect(executedPrompts[1]).toBe("modern AI chat web application UI design");
        expect(executedPrompts[2]).toBe("modern ecommerce website UI design desktop");
    });

    test("生成5张图片时，完成后熔断刹车生效，杜绝大模型在下一轮复读生图工具造成循环失控", async () => {
        const { runAgentTurn } = await import("@/lib/conversation-agent/runtime");
        let rounds = 0;
        let toolExecutions = 0;
        const result = await runAgentTurn({
            locale: "zh-CN",
            messages: [{ id: "u1", role: "user", text: "生成5张可爱猫咪图", createdAt: 1 }],
            tools: [
                {
                    name: "generate_image",
                    description: "生成图片",
                    parameters: { type: "object", properties: { prompt: { type: "string" }, count: { type: "integer" } }, required: ["prompt"] },
                },
            ],
            buildContext: () => ({ defaultSize: "1024x1024", pageContext: "chat", imageModels: [] }),
            callModel: async () => {
                rounds += 1;
                if (rounds === 1) {
                    return {
                        content: "好的，马上生成5张可爱猫咪图！",
                        toolCalls: [
                            {
                                tool: "generate_image",
                                arguments: { prompt: "可爱猫咪图，日系治愈插画", count: 5 },
                            },
                        ],
                    };
                }
                // 模拟大模型在第二轮失控，试图再次调用 generate_image
                return {
                    content: "继续为您生成更多：",
                    toolCalls: [
                        {
                            tool: "generate_image",
                            arguments: { prompt: "另一只可爱猫咪", count: 1 },
                        },
                    ],
                };
            },
            executeTool: async (call) => {
                toolExecutions += typeof call.arguments.count === "number" ? call.arguments.count : 1;
                return { tool: call.tool, ok: true, images: [], count: 5, size: "1024x1024" };
            },
            signal: new AbortController().signal,
        });

        // 验证：第一轮执行了 5 张，第二轮触发熔断刹车，不再执行多余生图
        expect(toolExecutions).toBe(5);
        expect(rounds).toBe(2);
        expect(result.roundLimitReached).toBe(false);
    });

    test("在普通对话 /chat 页面下大模型误调 canvas_batch_generate_nodes 时，自动解包降级为 generate_image，避免报错死循环", async () => {
        const { runAgentTurn } = await import("@/lib/conversation-agent/runtime");
        const executedTools: string[] = [];
        const result = await runAgentTurn({
            locale: "zh-CN",
            messages: [{ id: "u1", role: "user", text: "在画布上批量生成4张不同风格的赛博朋克猫咪头像，并排排开", createdAt: 1 }],
            tools: [
                {
                    name: "generate_image",
                    description: "生成图片",
                    parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
                },
            ],
            buildContext: () => ({ defaultSize: "1024x1024", pageContext: "chat", imageModels: [] }),
            callModel: async () => ({
                content: "马上为您在画布上排布生成！",
                toolCalls: [
                    {
                        tool: "canvas_batch_generate_nodes",
                        arguments: {
                            tasks: [
                                { prompt: "赛博猫咪 1", title: "方案 1", size: "1024x1024" },
                                { prompt: "赛博猫咪 2", title: "方案 2", size: "1024x1024" },
                                { prompt: "赛博猫咪 3", title: "方案 3", size: "1024x1024" },
                                { prompt: "赛博猫咪 4", title: "方案 4", size: "1024x1024" },
                            ],
                            layout: "horizontal",
                            run: true,
                        },
                    },
                ],
            }),
            executeTool: async (call) => {
                executedTools.push(call.tool);
                return { tool: call.tool, ok: true, images: [], count: 1, size: "1024x1024" };
            },
            signal: new AbortController().signal,
        });

        // 验证：canvas_batch_generate_nodes 被自动降级并解包为 4 个 generate_image 调用
        expect(executedTools.length).toBe(4);
        expect(executedTools.every((t) => t === "generate_image")).toBe(true);
        expect(result.roundLimitReached).toBe(false);
    });
});
