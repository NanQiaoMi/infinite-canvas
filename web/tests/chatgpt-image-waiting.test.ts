import { describe, expect, it } from "bun:test";

import { estimateProgress } from "../src/pages/chat/components/generation-waiting";

describe("ChatGPT 风格生图进度节奏 (estimateProgress)", () => {
    it("初期思考与概念阶段 (0-1s) 保持在 14% 以内", () => {
        expect(estimateProgress(0)).toBe(0);
        expect(estimateProgress(1)).toBe(14);
    });

    it("草图勾勒阶段 (4s 左右) 准确处于 39%~42%（契合 ChatGPT 参考截图）", () => {
        const progressAt4s = estimateProgress(4);
        expect(progressAt4s).toBeGreaterThanOrEqual(38);
        expect(progressAt4s).toBeLessThanOrEqual(44);
    });

    it("细节绘制阶段 (8s) 达到 70% 左右", () => {
        const progressAt8s = estimateProgress(8);
        expect(progressAt8s).toBe(70);
    });

    it("高精渲染阶段 (15s) 达到 90%", () => {
        const progressAt15s = estimateProgress(15);
        expect(progressAt15s).toBe(90);
    });

    it("超长等待时平缓封顶在 98% 以内，不提前溢出 100%", () => {
        expect(estimateProgress(25)).toBe(95);
        expect(estimateProgress(60)).toBeLessThanOrEqual(98);
    });

    it("支持多图并行时的微小交错偏移", () => {
        const first = estimateProgress(4, 0);
        const second = estimateProgress(4, 1);
        expect(first).toBeGreaterThan(second);
    });
});
