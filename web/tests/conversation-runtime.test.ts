import { describe, expect, test } from "bun:test";

import { runAgentTurn, type AgentRuntimeOptions } from "@/lib/conversation-agent/runtime";
import type { AgentContextInput, AgentEvent, AgentMessage, AgentModelCall, AgentModelTurnResult, AgentToolExecutor, AgentToolResult } from "@/lib/conversation-agent/types";

const context: AgentContextInput = {
    imageModels: ["gpt-image-2"],
    defaultImageModel: "gpt-image-2",
    defaultSize: "1024x1024",
    defaultQuality: "auto",
    defaultCount: "1",
    toolChannel: "text",
};

const userMessage: AgentMessage = { id: "u1", role: "user", text: "帮我生成一张苹果图", createdAt: 0 };

function turn(content: string, extra: Partial<AgentModelTurnResult> = {}): AgentModelTurnResult {
    return { content, toolCalls: [], ...extra };
}

function createRunner(options: { turns: AgentModelTurnResult[]; toolResult?: AgentToolResult; events?: AgentEvent[] }) {
    const calls: string[][] = [];
    let index = 0;
    const callModel: AgentModelCall = async ({ messages }) => {
        calls.push(messages.map((message) => `${message.role}:${message.content}`));
        const next = options.turns[Math.min(index, options.turns.length - 1)];
        index += 1;
        return next;
    };
    const executeTool: AgentToolExecutor = async (call) =>
        options.toolResult ??
        (call.tool === "generate_image"
            ? { tool: "generate_image", ok: true, model: "gpt-image-2", size: "1024x1024", count: 1, images: [{ id: "img_1", width: 1024, height: 1024, prompt: "苹果", model: "gpt-image-2" }] }
            : { tool: "apply_prompt", ok: true, target: "image", prompt: "苹果" });
    const runtimeOptions: AgentRuntimeOptions = {
        locale: "zh",
        messages: [userMessage],
        tools: [
            { name: "generate_image", description: "生成图片", parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } },
            { name: "apply_prompt", description: "填入工作台", parameters: { type: "object", properties: { target: { type: "string" }, prompt: { type: "string" } }, required: ["target", "prompt"] } },
        ],
        buildContext: () => context,
        callModel,
        executeTool,
        onEvent: (event) => options.events?.push(event),
        signal: new AbortController().signal,
    };
    return { run: () => runAgentTurn(runtimeOptions), calls };
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
        const runner = createRunner({ turns: [turn('```tool\n{"tool":"generate_image", oops}\n```'), turn("抱歉，我重新说明。")] });
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
            signal: new AbortController().signal,
        });
        expect(modelMessages).toHaveLength(3);
        expect(modelMessages[2].some((entry) => entry.includes("系统纠错"))).toBe(true);
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
});
