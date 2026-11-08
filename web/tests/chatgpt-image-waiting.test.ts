import { describe, expect, it } from "bun:test";

import { resolveWaitingProgress } from "../src/pages/chat/components/generation-waiting";

describe("生图等待进度只用真实数据 (resolveWaitingProgress)", () => {
    it("服务端有真实进度时直接换算为百分比", () => {
        expect(resolveWaitingProgress(0.42, 30)).toEqual({ kind: "percent", value: 42 });
        expect(resolveWaitingProgress(0.1, 2)).toEqual({ kind: "percent", value: 10 });
    });

    it("真实进度做 1~99 的边界收敛，避免长时间停留 0% 或提前 100%", () => {
        expect(resolveWaitingProgress(0, 30)).toEqual({ kind: "percent", value: 1 });
        expect(resolveWaitingProgress(1, 50)).toEqual({ kind: "percent", value: 99 });
        expect(resolveWaitingProgress(0.999, 50)).toEqual({ kind: "percent", value: 99 });
    });

    it("没有真实进度时退回真实已用时（秒），不模拟插值", () => {
        expect(resolveWaitingProgress(undefined, 12.8)).toEqual({ kind: "elapsed", value: 12 });
        expect(resolveWaitingProgress(undefined, 0)).toEqual({ kind: "elapsed", value: 0 });
    });

    it("非法进度值同样退回真实已用时，且不允许负数", () => {
        expect(resolveWaitingProgress(Number.NaN, 5)).toEqual({ kind: "elapsed", value: 5 });
        expect(resolveWaitingProgress(undefined, -3)).toEqual({ kind: "elapsed", value: 0 });
    });
});
