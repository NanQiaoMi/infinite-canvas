import { describe, expect, test } from "bun:test";

import { isRetryableGenerationError, MAX_GENERATION_ATTEMPTS, pickFallbackImageModel, runWithGenerationRetry } from "@/lib/conversation-agent/generation-retry";

describe("生成任务重试策略", () => {
    test("网络/超时/上游 5xx 错误可重试，参数与额度错误不重试", () => {
        expect(isRetryableGenerationError(new Error("fetch failed"))).toBe(true);
        expect(isRetryableGenerationError(new Error("请求超时：模型长时间无响应"))).toBe(true);
        expect(isRetryableGenerationError("503 Service Unavailable")).toBe(true);
        expect(isRetryableGenerationError("task_interrupted")).toBe(true);
        expect(isRetryableGenerationError("invalid args: prompt is required")).toBe(false);
        expect(isRetryableGenerationError("额度不足")).toBe(false);
        expect(isRetryableGenerationError("canceled")).toBe(false);
    });

    test("可恢复错误自动重试一次后成功", async () => {
        let calls = 0;
        const result = await runWithGenerationRetry(async () => {
            calls += 1;
            if (calls === 1) throw new Error("fetch failed");
            return "ok";
        }, new AbortController().signal, 1);
        expect(result).toBe("ok");
        expect(calls).toBe(2);
        expect(MAX_GENERATION_ATTEMPTS).toBe(2);
    });

    test("重试次数用尽后抛出最后一次错误", async () => {
        let calls = 0;
        await expect(
            runWithGenerationRetry(async () => {
                calls += 1;
                throw new Error("503 Service Unavailable");
            }, new AbortController().signal, 1),
        ).rejects.toThrow("503");
        expect(calls).toBe(MAX_GENERATION_ATTEMPTS);
    });

    test("确定性错误与已取消任务不重试", async () => {
        let invalidCalls = 0;
        await expect(
            runWithGenerationRetry(async () => {
                invalidCalls += 1;
                throw new Error("prompt is required");
            }, new AbortController().signal, 1),
        ).rejects.toThrow("prompt is required");
        expect(invalidCalls).toBe(1);

        const controller = new AbortController();
        controller.abort();
        let canceledCalls = 0;
        await expect(
            runWithGenerationRetry(async () => {
                canceledCalls += 1;
                throw new Error("fetch failed");
            }, controller.signal, 1),
        ).rejects.toThrow("fetch failed");
        expect(canceledCalls).toBe(1);
    });

    test("降级模型选择：排除当前模型，GIF 只降级到 2.6 系列", () => {
        expect(pickFallbackImageModel(["ch::a", "ch::b", "ch::gpt-image-2.6"], "ch::a", false)).toBe("ch::b");
        expect(pickFallbackImageModel(["ch::a"], "ch::a", false)).toBeNull();
        expect(pickFallbackImageModel(["ch::a", "ch::b"], "ch::a", true)).toBeNull();
        expect(pickFallbackImageModel(["ch::a", "ch::gpt-image-2.6"], "ch::a", true)).toBe("ch::gpt-image-2.6");
    });
});
