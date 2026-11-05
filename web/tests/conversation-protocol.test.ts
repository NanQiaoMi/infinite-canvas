import { describe, expect, test } from "bun:test";

import { nativeToolCallsToAgent, parseAgentOutput, serializeToolResult, stripForStreaming, validateArguments } from "@/lib/conversation-agent/protocol";

describe("对话输出协议", () => {
    test("普通文本不产生工具调用", () => {
        const parsed = parseAgentOutput("这是一段普通回复。");
        expect(parsed.toolCalls).toEqual([]);
        expect(parsed.promptBlocks).toEqual([]);
        expect(parsed.displayText).toBe("这是一段普通回复。");
    });

    test("解析多个工具块并保留正文", () => {
        const raw = [
            "我先帮你生成图片。",
            "```tool",
            '{"tool":"generate_image","arguments":{"prompt":"红苹果","count":1}}',
            "```",
            "```tool",
            '{"tool":"apply_prompt","arguments":{"target":"image","prompt":"红苹果"}}',
            "```",
            "完成后继续说明。",
        ].join("\n");
        const parsed = parseAgentOutput(raw);
        expect(parsed.toolCalls).toEqual([
            { tool: "generate_image", arguments: { prompt: "红苹果", count: 1 } },
            { tool: "apply_prompt", arguments: { target: "image", prompt: "红苹果" } },
        ]);
        expect(parsed.displayText).toContain("我先帮你生成图片。");
        expect(parsed.displayText).not.toContain("```");
        expect(parsed.invalidCalls).toEqual([]);
    });

    test("提取提示词卡片", () => {
        const parsed = parseAgentOutput("给你两个版本：\n```prompt\n一只红苹果，白色背景\n```\n```prompt\ncinematic apple\n```");
        expect(parsed.promptBlocks).toEqual(["一只红苹果，白色背景", "cinematic apple"]);
        expect(parsed.displayText).toBe("给你两个版本：");
    });

    test("非法 JSON 进入 invalidCalls", () => {
        const parsed = parseAgentOutput('```tool\n{"tool":"generate_image", broken}\n```');
        expect(parsed.toolCalls).toEqual([]);
        expect(parsed.invalidCalls).toHaveLength(1);
        expect(parsed.invalidCalls[0].error).toContain("JSON");
    });

    test("流式时屏蔽已闭合与未闭合的工具块", () => {
        expect(stripForStreaming("正文\n```tool\n{\"tool\":\"a\"}\n```\n后续")).toBe("正文\n\n后续");
        expect(stripForStreaming("正文\n```tool\n{\"tool\":\"generate_image\",\"arguments\":{\"prompt\":\"半")).toBe("正文");
        expect(stripForStreaming("正常 ```代码``` 不受影响")).toBe("正常 ```代码``` 不受影响");
    });

    test("原生工具调用转换", () => {
        const converted = nativeToolCallsToAgent([
            { name: "generate_image", arguments: '{"prompt":"猫"}' },
            { name: "broken", arguments: "{not json" },
            { name: "", arguments: "{}" },
        ]);
        expect(converted.calls).toEqual([{ tool: "generate_image", arguments: { prompt: "猫" } }]);
        expect(converted.errors).toHaveLength(2);
    });

    test("参数校验：必填、类型、范围、枚举", () => {
        const schema = {
            type: "object",
            properties: {
                prompt: { type: "string" },
                count: { type: "integer", minimum: 1, maximum: 4 },
                quality: { type: "string", enum: ["low", "high"] },
            },
            required: ["prompt"],
        };
        expect(validateArguments(schema, { prompt: "ok", count: 2 }).ok).toBe(true);
        expect(validateArguments(schema, {}).ok).toBe(false);
        expect(validateArguments(schema, { prompt: 1 }).ok).toBe(false);
        expect(validateArguments(schema, { prompt: "ok", count: 9 }).ok).toBe(false);
        expect(validateArguments(schema, { prompt: "ok", quality: "ultra" }).ok).toBe(false);
    });

    test("工具结果序列化不包含本地 storageKey", () => {
        const text = serializeToolResult(
            { tool: "generate_image", arguments: {} },
            {
                tool: "generate_image",
                ok: true,
                model: "gpt-image-2",
                size: "1024x1024",
                count: 1,
                images: [{ id: "img_1", storageKey: "secret-key", width: 1024, height: 1024, prompt: "苹果", model: "gpt-image-2" }],
            },
        );
        expect(text).toContain('<tool_result name="generate_image" status="ok">');
        expect(text).toContain('"id":"img_1"');
        expect(text).not.toContain("secret-key");
    });
});
