import { describe, expect, test } from "bun:test";

import { nativeToolCallsToAgent, parseAgentOutput, serializeToolResult, stripForStreaming, validateArguments } from "@/lib/conversation-agent/protocol";
import { buildIntentDirective } from "@/lib/conversation-agent/system-prompt";
import { detectAgentIntent } from "@/lib/conversation-agent/intent";

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

    test("意图指令对任务拆分与成套素材生成注入多步骤拆解要求", () => {
        const directiveZh = buildIntentDirective("zh", {
            kind: "generate_image",
            prompt: "生成海报素材，拆分任务为多次素材生成",
            explicit: true,
            direct: false,
        });
        expect(directiveZh).toContain("拆分任务/成套素材生成");
        expect(directiveZh).toContain("拆解为 2-3 个核心独立图层素材");

        const directiveEn = buildIntentDirective("en", {
            kind: "generate_image",
            prompt: "generate a poster asset suite with multiple split steps",
            explicit: true,
            direct: false,
        });
        expect(directiveEn).toContain("multi-step suite/split task");
        expect(directiveEn).toContain("decompose into 2-3 essential elements");
    });

    test("意图指令对明确生成透明底/PNG透明图片注入 background: transparent 指令要求", () => {
        const directiveZh = buildIntentDirective("zh", {
            kind: "generate_image",
            prompt: "生成png透明图片",
            background: "transparent",
            explicit: true,
            direct: false,
        });
        expect(directiveZh).toContain("PNG 透明图片/透明底");
        expect(directiveZh).toContain('"background": "transparent"');

        const directiveEn = buildIntentDirective("en", {
            kind: "generate_image",
            prompt: "generate a transparent png image",
            background: "transparent",
            explicit: true,
            direct: false,
        });
        expect(directiveEn).toContain("transparent PNG");
        expect(directiveEn).toContain('"background": "transparent"');
    });

    test("解析输出时提取 ChatGPT 富文本 AsyncImage 标签并转化为 promptBlocks", () => {
        const textWithAsyncImage = `好的，为你生成头像：
<AsyncImage query="赛博朋克霓虹猫咪头像，正面大特写" aspectRatio="1:1" />
<AsyncImage query="复古蒸汽波机械猫咪头像" aspectRatio="1:1" />
请查看以上预览。`;
        const result = parseAgentOutput(textWithAsyncImage);
        expect(result.promptBlocks).toHaveLength(2);
        expect(result.promptBlocks[0]).toBe("赛博朋克霓虹猫咪头像，正面大特写");
        expect(result.promptBlocks[1]).toBe("复古蒸汽波机械猫咪头像");
        // AsyncImage 标签应在展示文本中被清洗移除
        expect(result.displayText).not.toContain("<AsyncImage");
        expect(result.displayText).toContain("好的，为你生成头像：");
    });

    test("意图指令对画布多节点/并排生成注入 canvas_batch_generate_nodes 约束", () => {
        const directiveZh = buildIntentDirective("zh", {
            kind: "generate_image",
            prompt: "在画布上批量生成4张赛博朋克猫咪头像，并排排开",
            isCanvas: true,
            decompose: true,
            layout: "horizontal",
            batchCount: 4,
            explicit: true,
            direct: false,
        });
        expect(directiveZh).toContain("画布任务·强约束指令");
        expect(directiveZh).toContain("canvas_batch_generate_nodes");
        expect(directiveZh).toContain('"layout": "horizontal"');
    });

    test("普通对话 /chat 环境下提到「在画布上...」不派发画布工具指令，而是引导常规生图并在末尾提示", () => {
        const directiveChat = buildIntentDirective(
            "zh",
            {
                kind: "generate_image",
                prompt: "游戏魔法药水图标（红色生命、蓝色魔法、绿色体力）",
                isCanvas: true,
                decompose: true,
                background: "transparent",
                batchCount: 3,
                explicit: true,
                direct: false,
            },
            {
                imageModels: ["gpt-image-2"],
                defaultImageModel: "gpt-image-2",
                defaultSize: "1024x1024",
                defaultQuality: "auto",
                defaultCount: "1",
                pageContext: "chat",
                toolChannel: "text",
            },
            [
                { name: "generate_image", description: "生成图片", parameters: {} },
                { name: "apply_prompt", description: "填入工作台", parameters: {} },
            ],
        );
        expect(directiveChat).not.toContain("canvas_batch_generate_nodes");
        expect(directiveChat).toContain("generate_image");
        expect(directiveChat).toContain('"background": "transparent"');
        expect(directiveChat).toContain("前往「我的画布」自由排布");
    });

    test("解析输出支持围栏头部工具名声明与扁平参数结构（canvas_batch_generate_nodes / canvas_create_image_node）", () => {
        const textWithHeaderTool = `好的，正在为您批量生成：
\`\`\`tool canvas_batch_generate_nodes
{
  "tasks": [
    {"prompt": "赛博朋克霓虹猫咪头像", "title": "霓虹猫咪", "size": "1024x1024"},
    {"prompt": "赛博朋克机械猫咪头像", "title": "机械猫咪", "size": "1024x1024"}
  ],
  "layout": "horizontal",
  "run": true
}
\`\`\`
已全部提交画布排布。`;
        const result1 = parseAgentOutput(textWithHeaderTool);
        expect(result1.toolCalls).toHaveLength(1);
        expect(result1.toolCalls[0].tool).toBe("canvas_batch_generate_nodes");
        expect(Array.isArray((result1.toolCalls[0].arguments as { tasks?: unknown }).tasks)).toBe(true);
        expect(result1.displayText).not.toContain("```tool");
        expect(result1.displayText).toContain("已全部提交画布排布。");

        const textWithFlatArgs = `正在为您创建节点：
\`\`\`tool:canvas_create_image_node
{
  "prompt": "一只戴墨镜的搞怪柴犬",
  "size": "768x1024",
  "title": "柴犬立绘"
}
\`\`\``;
        const result2 = parseAgentOutput(textWithFlatArgs);
        expect(result2.toolCalls).toHaveLength(1);
        expect(result2.toolCalls[0].tool).toBe("canvas_create_image_node");
        expect((result2.toolCalls[0].arguments as { prompt?: string }).prompt).toBe("一只戴墨镜的搞怪柴犬");
        expect((result2.toolCalls[0].arguments as { size?: string }).size).toBe("768x1024");
    });

    test("会话上下文意图继承：延续上一轮动图提问与海报素材拆解", () => {
        const gifFollowUp = detectAgentIntent("邪魅坏笑：一看就没憋好事", {
            history: [
                { role: "user", text: "帮我做个猫咪动图" },
                { role: "assistant", text: "你想要单张魔性猫咪表情包，还是四格连续动作表情包？" },
            ],
        });
        expect(gifFollowUp.kind).toBe("generate_image");
        expect(gifFollowUp.format).toBe("gif");
        expect(gifFollowUp.usageScene).toBe("微信表情包");
        expect(gifFollowUp.prompt).toContain("邪魅坏笑");

        const posterAsset = detectAgentIntent("帮我生成海报素材");
        expect(posterAsset.kind).toBe("generate_image");
        expect(posterAsset.decompose).toBe(true);
        expect(posterAsset.prompt).toContain("海报设计素材");
    });

    test("裸 JSON 工具调用解析：ChatGPT 网页后端直接输出 JSON 时自动提取为 toolCalls 并清洗正文", () => {
        const raw = `{"size":"1536x864","n":1,"prompt":"一幅幽默、细节丰富的电影感写实插画：晚高峰拥挤的北京地铁车厢，车厢里挤满中国古典神话人物……"}这个创意很有趣，适合做成一张中国神话 × 北京早高峰的荒诞喜剧电影海报。`;
        const result = parseAgentOutput(raw);
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0].tool).toBe("generate_image");
        expect((result.toolCalls[0].arguments as { prompt?: string }).prompt).toContain("北京地铁车厢");
        expect((result.toolCalls[0].arguments as { size?: string }).size).toBe("1536x864");
        expect(result.displayText).toBe("这个创意很有趣，适合做成一张中国神话 × 北京早高峰的荒诞喜剧电影海报。");
    });

    test("延续上一轮生图意图继承：「再生成一个」与「换个姿势再来一个」准确继承历史提示词", () => {
        const history = [
            {
                role: "tool",
                text: "",
                call: {
                    tool: "generate_image",
                    arguments: { prompt: "复古1990s写真少女，瓷白皮肤，深棕色凌乱盘发，奶油色超大毛衣" },
                },
            },
        ];

        const followUp1 = detectAgentIntent("再生成一个", { history });
        expect(followUp1.kind).toBe("generate_image");
        expect(followUp1.prompt).toBe("复古1990s写真少女，瓷白皮肤，深棕色凌乱盘发，奶油色超大毛衣");

        const followUp2 = detectAgentIntent("换个姿势再来一个", { history });
        expect(followUp2.kind).toBe("generate_image");
        expect(followUp2.prompt).toBe("复古1990s写真少女，瓷白皮肤，深棕色凌乱盘发，奶油色超大毛衣，换个姿势");

        const followUp3 = detectAgentIntent("不改变她原来的脸，再来一张", { history });
        expect(followUp3.kind).toBe("generate_image");
        expect(followUp3.prompt).toBe("复古1990s写真少女，瓷白皮肤，深棕色凌乱盘发，奶油色超大毛衣，不改变她原来的脸");
    });

    test("长段叙事细节场景描述：无显式指令词也能准确识别为生图意图（如北京地铁神话人物）", () => {
        const text = "拥挤的北京地铁车厢，但乘客全是神话人物（孙悟空、猪八戒等）。车厢连接处的滚动屏显示红色字体：“前往西天取经的乘客请注意，前方到站：高老庄”。车门玻璃上贴着警告标示：“禁止在车厢内施展法术”。";
        const intent = detectAgentIntent(text);
        expect(intent.kind).toBe("generate_image");
        expect(intent.prompt).toBe(text);
    });
});
