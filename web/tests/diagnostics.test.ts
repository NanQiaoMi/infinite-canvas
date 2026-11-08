import { describe, expect, test } from "bun:test";

import {
    clearDiagnostics,
    formatDiagnosticsReport,
    getDiagnosticEvents,
    recordDiagnostic,
    subscribeDiagnostics,
    summarizeDiagnostics,
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

        for (let index = 0; index < 130; index += 1) {
            recordDiagnostic({ category: "generation", level: "info", message: `event-${index}` });
        }
        const events = getDiagnosticEvents();
        expect(events).toHaveLength(120);
        expect(events[events.length - 1].message).toBe("event-129");

        clearDiagnostics();
        expect(getDiagnosticEvents()).toHaveLength(0);
    });
});
