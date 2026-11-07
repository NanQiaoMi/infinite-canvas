import { describe, expect, test } from "bun:test";

import { nativeToolCallsToAgent, parseAgentOutput, serializeToolResult, stripForStreaming, validateArguments } from "@/lib/conversation-agent/protocol";
import { buildIntentDirective } from "@/lib/conversation-agent/system-prompt";

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

    test("剔除 ChatGPT 富文本组件标签，保留代码块内容", () => {
        const raw = [
            '看图：<AsyncImageGroup query={["cyberpunk city"]} aspectRatio="16:9" layout="bento"/>',
            '',
            '<text color="secondary" size="xs">蓝紫色调</text>',
            '',
            '```js',
            'const tag = "<text>";',
            '```',
        ].join("\n");
        const parsed = parseAgentOutput(raw);
        expect(parsed.displayText).not.toContain("<AsyncImageGroup");
        expect(parsed.displayText).not.toContain('<text color=');
        expect(parsed.displayText).toContain("蓝紫色调");
        expect(parsed.displayText).toContain('<text>');
        expect(stripForStreaming('<text color="secondary">冷色调</text>正文')).toBe("冷色调正文");
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

    test("edit_image 结果序列化使用实际工具名", () => {
        const text = serializeToolResult(
            { tool: "edit_image", arguments: { prompt: "改背景" } },
            {
                tool: "edit_image",
                ok: true,
                model: "gpt-image-2",
                size: "1024x1024",
                count: 1,
                images: [{ id: "img_2", storageKey: "secret-key", width: 1024, height: 1024, prompt: "改背景", model: "gpt-image-2" }],
            },
        );
        expect(text).toContain('<tool_result name="edit_image" status="ok">');
        expect(text).not.toContain("secret-key");
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

    test("意图指令对素材/免抠元素注入纯白背景与禁棋盘格防伪透明底规则", () => {
        const directiveZh = buildIntentDirective("zh", {
            kind: "generate_image",
            prompt: "帮我生成海报素材",
            explicit: true,
            direct: false,
        });
        expect(directiveZh).toContain("设计素材/免抠元素");
        expect(directiveZh).toContain("严禁包含 \"transparent background/透明底\"");
        expect(directiveZh).toContain("纯白背景");

        const directiveEn = buildIntentDirective("en", {
            kind: "generate_image",
            prompt: "generate cutout asset for poster",
            explicit: true,
            direct: false,
        });
        expect(directiveEn).toContain("isolated asset/cutout");
        expect(directiveEn).toContain("never include \"transparent background\"");
        expect(directiveEn).toContain("solid pure white background");
    });
});
