import { describe, expect, test } from "bun:test";

import {
    clearDiagnostics,
    formatDiagnosticsReport,
    getDiagnosticEvents,
    recordDiagnostic,
    subscribeDiagnostics,
    summarizeChannelHealth,
    summarizeDiagnostics,
    summarizeDiagnosticsByDay,
    trackGenerationAttempt,
} from "@/lib/conversation-agent/diagnostics";

describe("生成诊断日志", () => {
    test("记录、汇总与报告格式", async () => {
        clearDiagnostics();
        recordDiagnostic({ category: "generation", level: "info", message: "generate succeeded", detail: { model: "gpt-image-2.5" } });
        recordDiagnostic({ category: "generation", level: "error", message: "generate failed: 503" });
        recordDiagnostic({ category: "model", level: "error", message: "model failed: timeout" });

        const events = getDiagnosticEvents();
        expect(events).toHaveLength(3);
        const summary = summarizeDiagnostics(events);
        expect(summary.attempts).toBe(2);
        expect(summary.successes).toBe(1);
        expect(summary.failures).toBe(1);
        expect(summary.modelErrors).toBe(1);
        expect(summary.lastFailureAt).toBeNumber();

        const report = formatDiagnosticsReport(events);
        expect(report).toContain("生成诊断报告");
        expect(report).toContain("generate failed: 503");
        expect(report).toContain("model failed: timeout");
    });

    test("trackGenerationAttempt 记录成功/失败/取消，并把错误继续抛出", async () => {
        clearDiagnostics();
        await trackGenerationAttempt("generate", { model: "m" }, async () => "ok");
        expect(getDiagnosticEvents()[0].level).toBe("info");

        await expect(
            trackGenerationAttempt("edit", { model: "m" }, async () => {
                throw new Error("fetch failed");
            }),
        ).rejects.toThrow("fetch failed");
        expect(getDiagnosticEvents()[1].level).toBe("error");
        expect(getDiagnosticEvents()[1].message).toContain("fetch failed");

        await expect(
            trackGenerationAttempt(
                "generate",
                { model: "m" },
                async () => {
                    throw new Error("aborted");
                },
                () => true,
            ),
        ).rejects.toThrow("aborted");
        expect(getDiagnosticEvents()[2].level).toBe("warn");
    });

    test("订阅通知、清空与环形缓冲上限", () => {
        clearDiagnostics();
        let notified = 0;
        const unsubscribe = subscribeDiagnostics(() => {
            notified += 1;
        });
        recordDiagnostic({ category: "generation", level: "info", message: "a" });
        recordDiagnostic({ category: "generation", level: "info", message: "b" });
        expect(notified).toBe(2);
        unsubscribe();

        for (let index = 0; index < 520; index += 1) {
            recordDiagnostic({ category: "generation", level: "info", message: `event-${index}` });
        }
        const events = getDiagnosticEvents();
        expect(events).toHaveLength(500);
        expect(events[events.length - 1].message).toBe("event-519");

        clearDiagnostics();
        expect(getDiagnosticEvents()).toHaveLength(0);
    });

    test("最近 7 天失败率按天分桶", () => {
        clearDiagnostics();
        const now = new Date("2026-11-08T12:00:00+08:00").getTime();
        recordDiagnostic({ category: "generation", level: "info", message: "ok-today" });
        recordDiagnostic({ category: "generation", level: "error", message: "fail-today" });
        recordDiagnostic({ category: "generation", level: "error", message: "fail-today-2" });
        const events = getDiagnosticEvents();
        const days = summarizeDiagnosticsByDay(events, 7, now);
        expect(days).toHaveLength(7);
        const today = days[days.length - 1];
        expect(today.attempts).toBe(3);
        expect(today.failures).toBe(2);
        expect(today.failureRate).toBe(67);
        expect(days[0].attempts).toBe(0);
    });

    test("渠道健康检查按渠道聚合失败率与最后错误", () => {
        clearDiagnostics();
        recordDiagnostic({ category: "generation", level: "info", message: "ok", detail: { model: "ch-a::img-1" } });
        recordDiagnostic({ category: "generation", level: "error", message: "fail 1", detail: { model: "ch-a::img-1" } });
        recordDiagnostic({ category: "generation", level: "error", message: "fail 2", detail: { model: "ch-a::img-2" } });
        recordDiagnostic({ category: "generation", level: "info", message: "ok", detail: { model: "ch-b::img-1" } });
        recordDiagnostic({ category: "model", level: "error", message: "model fail", detail: { model: "ch-a::text" } });

        const health = summarizeChannelHealth(getDiagnosticEvents());
        expect(health).toHaveLength(2);
        const channelA = health.find((row) => row.channel === "ch-a");
        expect(channelA?.attempts).toBe(3);
        expect(channelA?.failures).toBe(2);
        expect(channelA?.failureRate).toBe(67);
        expect(channelA?.lastError).toBe("fail 2");
        expect(channelA?.models.find((model) => model.model === "img-1")?.failures).toBe(1);
        const channelB = health.find((row) => row.channel === "ch-b");
        expect(channelB?.failures).toBe(0);
    });
});
