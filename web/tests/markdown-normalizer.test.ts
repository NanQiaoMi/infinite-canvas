import { describe, expect, it } from "bun:test";
import { normalizeMarkdownForChat } from "../src/lib/conversation-agent/markdown-normalizer";

describe("normalizeMarkdownForChat - 聊天 Markdown 规范化", () => {
    it("剥离非代码块中偶发的 4 空格缩进，避免误触发 CommonMark 缩进代码块", () => {
        const input = [
            "比如，你可以直接对我说：",
            "",
            "    **生成一张动漫少女樱花主题壁纸**",
            "    动漫 · 唯美 · 竖屏",
            "",
            "    **做一张高级香水广告图**",
            "    商业摄影 · 极简 · 高级感",
            "",
            "你只需要告诉我我想画什么！",
        ].join("\n");

        const output = normalizeMarkdownForChat(input);
        expect(output).toContain("**生成一张动漫少女樱花主题壁纸**");
        expect(output).toContain("**做一张高级香水广告图**");
        expect(output).not.toContain("    **生成一张动漫少女樱花主题壁纸**");
    });

    it("修复粗体标记内侧的横向空格，确保 ** 能够正确闭合并被解析为粗体", () => {
        const input = "你可以输入 ** 生成一张赛博朋克夜景 ** 或者 **高级香水 ** 以及 ** 概念设计**。";
        const output = normalizeMarkdownForChat(input);
        expect(output).toBe("你可以输入 **生成一张赛博朋克夜景** 或者 **高级香水** 以及 **概念设计**。");
    });

    it("真实围栏代码块内部的缩进和内容必须完整保留，不受影响", () => {
        const input = [
            "以下是示例代码：",
            "```python",
            "    def calculate():",
            "        **not bold here**",
            "        return 42",
            "```",
            "    **这是外部的文本**",
        ].join("\n");

        const output = normalizeMarkdownForChat(input);
        expect(output).toContain("    def calculate():\n        **not bold here**\n        return 42");
        expect(output).toContain("**这是外部的文本**");
        expect(output).not.toContain("    **这是外部的文本**");
    });

    it("列表项的缩进归一化为 2 空格，避免触发 4 空格代码块", () => {
        const input = [
            "- 一级列表",
            "    - 二级列表内容",
            "    1. 数字子列表",
        ].join("\n");

        const output = normalizeMarkdownForChat(input);
        expect(output).toContain("  - 二级列表内容");
        expect(output).toContain("  1. 数字子列表");
    });

    it("空字符串或 null 保持健壮", () => {
        expect(normalizeMarkdownForChat("")).toBe("");
        // @ts-expect-error test null safety
        expect(normalizeMarkdownForChat(null)).toBe("");
    });
});
