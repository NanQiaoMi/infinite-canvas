import { describe, expect, it } from "bun:test";

import { calculateStreamStep } from "../src/pages/chat/components/smooth-stream-text";

describe("平滑流式输出步长计算 (calculateStreamStep)", () => {
    it("无剩余字符时步长为 0", () => {
        const result = calculateStreamStep(0, true, 30);
        expect(result.stepChars).toBe(0);
        expect(result.skipFrame).toBe(false);
    });

    it("运行结束后快速收尾 (isRun = false)", () => {
        const result = calculateStreamStep(20, false, 16);
        expect(result.stepChars).toBeGreaterThanOrEqual(5);
        expect(result.skipFrame).toBe(false);

        const smallRemain = calculateStreamStep(2, false, 16);
        expect(smallRemain.stepChars).toBe(3);
    });

    it("大段内容涌入时动态加速追赶 (remaining > 80)", () => {
        const result = calculateStreamStep(150, true, 16);
        expect(result.stepChars).toBe(30);
        expect(result.skipFrame).toBe(false);
    });

    it("中等差额平滑追赶 (25 < remaining <= 80)", () => {
        const result = calculateStreamStep(49, true, 16);
        expect(result.stepChars).toBe(7);
        expect(result.skipFrame).toBe(false);
    });

    it("小幅超前时根据帧间隔微调 (6 < remaining <= 25)", () => {
        const slowFrame = calculateStreamStep(10, true, 28);
        expect(slowFrame.stepChars).toBe(2);

        const fastFrame = calculateStreamStep(10, true, 16);
        expect(fastFrame.stepChars).toBe(1);
    });

    it("匀速微量输出时跳过微小时间片 (remaining <= 6)", () => {
        const tooFast = calculateStreamStep(4, true, 10);
        expect(tooFast.skipFrame).toBe(true);

        const onTime = calculateStreamStep(4, true, 22);
        expect(onTime.skipFrame).toBe(false);
        expect(onTime.stepChars).toBe(1);
    });
});
