import { describe, expect, it } from "bun:test";
import { inferImageSizeFromPrompt } from "../src/lib/conversation-agent/aspect-ratio";
import { formatAgentToolStepLabel, getInitialUnderstandStepLabel } from "../src/lib/conversation-agent/formatters";
import { extractNumberedPrompts } from "../src/lib/conversation-agent/runtime";
import type { AgentToolCall } from "../src/lib/conversation-agent/types";

describe("动态意图理解、视觉构图与参数返回 (AI-driven Composition & Intent)", () => {
    it("getInitialUnderstandStepLabel 彻底消除死板的括号标签（如【海报设计/视觉封面】）", () => {
        const posterLabel = getInitialUnderstandStepLabel("生成一张海报", {
            kind: "generate_image",
            prompt: "海报",
            explicit: true,
            direct: false,
            usageScene: "海报设计/视觉封面",
        });
        expect(posterLabel).not.toContain("【");
        expect(posterLabel).not.toContain("】");
        expect(posterLabel).not.toContain("[海报设计/视觉封面]");
        expect(posterLabel).toContain("分析业务用途与视觉定位");

        const batchLabel = getInitialUnderstandStepLabel("生成三张设计稿", {
            kind: "generate_image",
            prompt: "设计稿",
            explicit: true,
            direct: false,
            batchCount: 3,
        });
        expect(batchLabel).not.toContain("【");
        expect(batchLabel).toContain("分析创作需求 · 规划多方案构思与视觉参数");

        const canvasDecomposeLabel = getInitialUnderstandStepLabel("在画布上拆解任务", {
            kind: "generate_image",
            prompt: "任务",
            explicit: true,
            direct: false,
            isCanvas: true,
            decompose: true,
        });
        expect(canvasDecomposeLabel).toBe("规划画布布局 · 拆解多节点排布");
    });

    it("多方案设计（如「生成三张设计稿」）fallback 智能扩展为差异化独立创意，彻底告别死板的「设计稿，方案 1」", () => {
        const schemes = extractNumberedPrompts("", 3, "设计稿");
        expect(schemes.length).toBe(3);

        // 每个方案拥有不同的设计定位与标题
        expect(schemes[0].title).toContain("极简现代");
        expect(schemes[1].title).toContain("潮流视觉");
        expect(schemes[2].title).toContain("质感光影");

        // 绝不输出简陋无意义的死板提示词
        for (const scheme of schemes) {
            expect(scheme.prompt).not.toBe("设计稿，方案 1");
            expect(scheme.prompt).not.toBe("设计稿，方案 2");
            expect(scheme.prompt).not.toBe("设计稿，方案 3");
            expect(scheme.prompt.length).toBeGreaterThan(25);
            // 契合设计稿的画幅（16:9 宽屏）
            expect(scheme.size).toBe("1536x864");
        }
    });

    it("formatAgentToolStepLabel 携带 scheme title 时优雅渲染方案主题与画幅规格", () => {
        const call: AgentToolCall = {
            tool: "generate_image",
            arguments: {
                prompt: "现代极简网页设计稿，深灰与米白高雅配色，大尺寸卡片布局，通透毛玻璃质感",
                title: "方案 1 · 极简现代",
                size: "1536x864",
                count: 1,
            },
        };
        const label = formatAgentToolStepLabel(call);
        expect(label).toContain("方案 1 · 极简现代");
        expect(label).toContain("1536x864");
        expect(label).toContain("现代极简网页设计稿");
    });

    it("智能画幅推断：设计稿 / 网页设计智能适配为 16:9 (1536x864)", () => {
        expect(inferImageSizeFromPrompt("生成三张现代设计稿")).toBe("1536x864");
        expect(inferImageSizeFromPrompt("网页设计桌面端稿件")).toBe("1536x864");
    });
});
