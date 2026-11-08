import { describe, expect, it } from "bun:test";
import { splitCountIntoChunks } from "../src/services/api/image";
import { detectAgentIntent, stripInstructionPrefix } from "../src/lib/conversation-agent/intent";
import type { ConversationMessage } from "../src/lib/conversation-agent/types";

describe("生图并发批次切分与超限自适应 (splitCountIntoChunks)", () => {
    it("小于等于 0 时返回空数组", () => {
        expect(splitCountIntoChunks(0)).toEqual([]);
        expect(splitCountIntoChunks(-2)).toEqual([]);
    });

    it("单张或小于上限（<=4）时保持单批次", () => {
        expect(splitCountIntoChunks(1)).toEqual([1]);
        expect(splitCountIntoChunks(2)).toEqual([2]);
        expect(splitCountIntoChunks(3)).toEqual([3]);
        expect(splitCountIntoChunks(4)).toEqual([4]);
    });

    it("超过 4 张时自动切分为不超过 4 的子批次，并在并发执行时汇总", () => {
        expect(splitCountIntoChunks(5)).toEqual([4, 1]);
        expect(splitCountIntoChunks(6)).toEqual([4, 2]);
        expect(splitCountIntoChunks(7)).toEqual([4, 3]);
        expect(splitCountIntoChunks(8)).toEqual([4, 4]);
        expect(splitCountIntoChunks(9)).toEqual([4, 4, 1]);
        expect(splitCountIntoChunks(12)).toEqual([4, 4, 4]);
    });

    it("支持自定义 maxChunk 阈值", () => {
        expect(splitCountIntoChunks(6, 3)).toEqual([3, 3]);
        expect(splitCountIntoChunks(7, 2)).toEqual([2, 2, 2, 1]);
    });
});

describe("提示词前缀清理与名词后缀保护 (stripInstructionPrefix)", () => {
    it("正确保护以「画」结尾的名词，不被错误截断", () => {
        expect(stripInstructionPrefix("拼贴画")).toBe("拼贴画");
        expect(stripInstructionPrefix("生成拼贴画")).toBe("拼贴画");
        expect(stripInstructionPrefix("治愈系日系插画")).toBe("治愈系日系插画");
        expect(stripInstructionPrefix("请帮我画一幅敦煌壁画")).toBe("敦煌壁画");
        expect(stripInstructionPrefix("生成一张水彩画")).toBe("水彩画");
        expect(stripInstructionPrefix("来一幅油画")).toBe("油画");
    });

    it("正常清理普通指令动词与张数", () => {
        expect(stripInstructionPrefix("帮我生成8张橘猫表情包")).toBe("橘猫表情包");
        expect(stripInstructionPrefix("制作一组可爱头像，共4张")).toBe("可爱头像");
    });
});

describe("智能场景识别中避免负面提示词反向污染 (detectUsageScene)", () => {
    it("正面需求中包含 LOGO 时正常识别为 Logo/图标设计", () => {
        const intent = detectAgentIntent("帮我设计一个精品咖啡店的简约极简LOGO");
        expect(intent.usageScene).toBe("Logo/图标设计");
    });

    it("负面提示词中包含 LOGO、文字、拼贴画等词汇时，不产生场景误判", () => {
        const prompt = `[整体风格]
1:1 正方形构图，超写实韩式成年女性室内人像摄影，清冷温柔气质。
[面部特征]
一位 23-25 岁的绝美东亚成年女性，精致小巧的鹅蛋脸。
[负面提示词]
避免文字、水印、LOGO、拼贴画、畸形肢体、低画质。`;
        const intent = detectAgentIntent(prompt);
        // 确保不会因为负面提示词中的 LOGO 被错误识别为 Logo/图标设计
        expect(intent.usageScene).not.toBe("Logo/图标设计");
        expect(intent.usageScene).not.toBe("电商商品白底图");
    });
});

describe("后续追问中「横屏/竖屏」与多张生图的上下文继承与画幅锁定", () => {
    const portraitPrompt = "超写实韩式成年女性室内人像摄影，清冷温柔气质，奶油白现代客厅，乌黑及腰长发。";
    const history = [
        {
            id: "msg-1",
            role: "user",
            text: "生成一张清冷温柔韩式女性人像",
        },
        {
            id: "msg-2",
            role: "assistant",
            text: "已为您生成",
            call: {
                tool: "generate_image",
                arguments: {
                    prompt: portraitPrompt,
                    size: "1024x1024",
                },
            },
        },
    ];

    it("输入「生成8张横屏的」时：正确继承前序提示词，提取 8 张并锁定 16:9 尺寸 (1536x864)", () => {
        const intent = detectAgentIntent("生成8张横屏的", { history });
        expect(intent.kind).toBe("generate_image");
        expect(intent.batchCount).toBe(8);
        expect(intent.size).toBe("1536x864");
        // 提示词必须继承上一轮真实画面内容，而不是变成「横屏的」
        expect(intent.prompt).toContain("超写实韩式成年女性室内人像摄影");
    });

    it("输入「来4张竖屏的」时：正确继承前序提示词，提取 4 张并锁定 9:16 尺寸 (864x1536)", () => {
        const intent = detectAgentIntent("来4张竖屏的", { history });
        expect(intent.kind).toBe("generate_image");
        expect(intent.batchCount).toBe(4);
        expect(intent.size).toBe("864x1536");
        expect(intent.prompt).toContain("超写实韩式成年女性室内人像摄影");
    });

    it("支持 toolCalls 结构与 assistant promptBlocks 历史的精准回溯", () => {
        const historyWithToolCalls = [
            {
                id: "msg-1",
                role: "user",
                text: "画一只可爱的胖橘猫",
            },
            {
                id: "msg-2",
                role: "assistant",
                text: "正在出图",
                toolCalls: [
                    {
                        name: "generate_image",
                        arguments: {
                            prompt: "一只圆滚滚的可爱胖橘猫，粉嫩肉垫，双爪合十",
                            size: "1024x1024",
                        },
                    },
                ],
            },
        ];
        const intent = detectAgentIntent("生成8张横屏的", { history: historyWithToolCalls });
        expect(intent.batchCount).toBe(8);
        expect(intent.size).toBe("1536x864");
        expect(intent.prompt).toContain("一只圆滚滚的可爱胖橘猫");
    });
});
