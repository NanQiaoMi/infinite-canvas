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
        return { tool: "apply_prompt", ok: true, target: "image", prompt: "苹果" };
    };
    const runtimeOptions: AgentRuntimeOptions = {
        locale: "zh",
        messages: options.messages ?? [userMessage],
        tools: [
            { name: "generate_image", description: "生成图片", parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } },
            { name: "apply_prompt", description: "填入工作台", parameters: { type: "object", properties: { target: { type: "string" }, prompt: { type: "string" } }, required: ["target", "prompt"] } },
        ],
        buildContext: () => context,
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
});
