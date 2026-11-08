/**
 * 生成/模型调用的轻量诊断日志（内存环形缓冲，最多保留 120 条）。
 * 目的：生成失败时能回溯「哪一步、哪个模型、什么错误、耗时多少」，
 * 并可一键复制成报告粘贴给开发者，降低排查成本；不会上传任何数据。
 */
export type DiagnosticCategory = "generation" | "model";
export type DiagnosticLevel = "info" | "warn" | "error";

export type DiagnosticEvent = {
    id: string;
    at: number;
    category: DiagnosticCategory;
    level: DiagnosticLevel;
    message: string;
    detail?: Record<string, unknown>;
};

const MAX_EVENTS = 120;
let events: DiagnosticEvent[] = [];
let seq = 0;
const listeners = new Set<() => void>();

const notify = () => {
    for (const listener of listeners) listener();
};

export function recordDiagnostic(input: { category: DiagnosticCategory; level: DiagnosticLevel; message: string; detail?: Record<string, unknown> }): DiagnosticEvent {
    seq += 1;
    const event: DiagnosticEvent = {
        id: `diag_${Date.now().toString(36)}_${seq.toString(36)}`,
        at: Date.now(),
        ...input,
    };
    events = [...events.slice(-(MAX_EVENTS - 1)), event];
    notify();
    return event;
}

export function getDiagnosticEvents(): DiagnosticEvent[] {
    return events;
}

export function subscribeDiagnostics(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function clearDiagnostics() {
    events = [];
    notify();
}

export type DiagnosticSummary = {
    total: number;
    attempts: number;
    successes: number;
    failures: number;
    canceled: number;
    modelErrors: number;
    lastFailureAt: number | null;
};

export function summarizeDiagnostics(items: DiagnosticEvent[] = events): DiagnosticSummary {
    const generation = items.filter((event) => event.category === "generation");
    const failures = generation.filter((event) => event.level === "error");
    return {
        total: items.length,
        attempts: generation.length,
        successes: generation.filter((event) => event.level === "info").length,
        failures: failures.length,
        canceled: generation.filter((event) => event.level === "warn").length,
        modelErrors: items.filter((event) => event.category === "model" && event.level === "error").length,
        lastFailureAt: failures.length ? failures[failures.length - 1].at : null,
    };
}

export function formatDiagnosticsReport(items: DiagnosticEvent[] = events): string {
    const summary = summarizeDiagnostics(items);
    const lines = items.map((event) => {
        const time = new Date(event.at).toLocaleString();
        const detail = event.detail && Object.keys(event.detail).length ? ` | ${JSON.stringify(event.detail)}` : "";
        return `[${time}] ${event.level.toUpperCase()} ${event.category}: ${event.message}${detail}`;
    });
    return [
        `# 生成诊断报告`,
        `生成尝试 ${summary.attempts} 次，成功 ${summary.successes}，失败 ${summary.failures}，取消 ${summary.canceled}，模型错误 ${summary.modelErrors}`,
        ...lines,
    ].join("\n");
}

/** 统一包裹底层生图请求：成功/失败/取消都会记录一条诊断（含模型、尺寸、耗时）。 */
export async function trackGenerationAttempt<T>(
    kind: "generate" | "edit",
    meta: Record<string, unknown>,
    run: () => Promise<T>,
    isCanceled: () => boolean = () => false,
): Promise<T> {
    const startedAt = Date.now();
    try {
        const result = await run();
        recordDiagnostic({ category: "generation", level: "info", message: `${kind} succeeded`, detail: { ...meta, durationMs: Date.now() - startedAt } });
        return result;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const canceled = isCanceled();
        recordDiagnostic({
            category: "generation",
            level: canceled ? "warn" : "error",
            message: `${kind} failed: ${message}`,
            detail: { ...meta, durationMs: Date.now() - startedAt, ...(canceled ? { canceled: true } : {}) },
        });
        throw error;
    }
}
