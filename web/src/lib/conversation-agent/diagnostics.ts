/**
 * 生成/模型调用的轻量诊断日志（内存环形缓冲，最多保留 500 条，并持久化到 localforage 便于刷新后回溯）。
 * 目的：生成失败时能回溯「哪一步、哪个渠道/模型、什么错误、耗时多少」，支持 7 天失败率趋势与渠道健康检查；
 * 数据仅保存在本浏览器，不会上传。
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

const MAX_EVENTS = 500;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const STORAGE_KEY = "infinite-canvas.diagnostics.v1";
const isBrowser = typeof window !== "undefined";

let events: DiagnosticEvent[] = [];
let seq = 0;
let hydrated = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

const notify = () => {
    for (const listener of listeners) listener();
};

/** 页面启动时调用：从 localforage 恢复最近 7 天的诊断并按时间合并。 */
export async function hydrateDiagnostics(): Promise<void> {
    if (!isBrowser || hydrated) return;
    hydrated = true;
    try {
        const localforage = (await import("localforage")).default;
        const stored = await localforage.getItem<DiagnosticEvent[]>(STORAGE_KEY);
        if (Array.isArray(stored)) {
            const cutoff = Date.now() - RETENTION_MS;
            const merged = [...stored.filter((event) => event && typeof event.at === "number" && event.at > cutoff), ...events]
                .sort((a, b) => a.at - b.at)
                .slice(-MAX_EVENTS);
            events = merged;
            notify();
        }
    } catch {
        // 存储不可用时仅使用内存日志
    }
}

function schedulePersist() {
    if (!isBrowser) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
        persistTimer = null;
        void persistDiagnostics();
    }, 600);
}

async function persistDiagnostics() {
    try {
        const localforage = (await import("localforage")).default;
        const cutoff = Date.now() - RETENTION_MS;
        await localforage.setItem(STORAGE_KEY, events.filter((event) => event.at > cutoff).slice(-MAX_EVENTS));
    } catch {
        // 存储失败不影响内存日志
    }
}

export function recordDiagnostic(input: { category: DiagnosticCategory; level: DiagnosticLevel; message: string; detail?: Record<string, unknown> }): DiagnosticEvent {
    seq += 1;
    const event: DiagnosticEvent = {
        id: `diag_${Date.now().toString(36)}_${seq.toString(36)}`,
        at: Date.now(),
        ...input,
    };
    events = [...events.slice(-(MAX_EVENTS - 1)), event];
    notify();
    schedulePersist();
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
    schedulePersist();
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

const dayKeyOf = (timestamp: number) => {
    const date = new Date(timestamp);
    const month = `${date.getMonth() + 1}`.padStart(2, "0");
    const day = `${date.getDate()}`.padStart(2, "0");
    return `${month}-${day}`;
};

export type DiagnosticDayBucket = {
    day: string;
    attempts: number;
    failures: number;
    failureRate: number;
};

/** 最近 N 天的生成尝试/失败/失败率（只统计 generation 事件，按本地日期分桶）。 */
export function summarizeDiagnosticsByDay(items: DiagnosticEvent[] = events, days = 7, now = Date.now()): DiagnosticDayBucket[] {
    const buckets = new Map<string, { attempts: number; failures: number }>();
    for (let offset = days - 1; offset >= 0; offset -= 1) {
        const timestamp = now - offset * 24 * 60 * 60 * 1000;
        buckets.set(dayKeyOf(timestamp), { attempts: 0, failures: 0 });
    }
    for (const event of items) {
        if (event.category !== "generation") continue;
        if (event.level !== "info" && event.level !== "error") continue;
        const key = dayKeyOf(event.at);
        const bucket = buckets.get(key);
        if (!bucket) continue;
        bucket.attempts += 1;
        if (event.level === "error") bucket.failures += 1;
    }
    return [...buckets.entries()].map(([day, bucket]) => ({
        day,
        attempts: bucket.attempts,
        failures: bucket.failures,
        failureRate: bucket.attempts ? Math.round((bucket.failures / bucket.attempts) * 100) : 0,
    }));
}

export type DiagnosticChannelHealth = {
    channel: string;
    attempts: number;
    failures: number;
    failureRate: number;
    lastError: string | null;
    lastErrorAt: number | null;
    models: Array<{ model: string; attempts: number; failures: number }>;
};

/** 按渠道聚合最近诊断里的失败率与最后一条错误，用于渠道健康检查。 */
export function summarizeChannelHealth(items: DiagnosticEvent[] = events): DiagnosticChannelHealth[] {
    const groups = new Map<string, { attempts: number; failures: number; lastError: string | null; lastErrorAt: number | null; models: Map<string, { attempts: number; failures: number }> }>();
    const ensureGroup = (channel: string) => {
        let group = groups.get(channel);
        if (!group) {
            group = { attempts: 0, failures: 0, lastError: null, lastErrorAt: null, models: new Map() };
            groups.set(channel, group);
        }
        return group;
    };
    for (const event of items) {
        if (event.category !== "generation") continue;
        if (event.level !== "info" && event.level !== "error") continue;
        const rawModel = typeof event.detail?.model === "string" ? event.detail.model : "";
        const [channel, model] = rawModel.includes("::") ? rawModel.split("::", 2) : [rawModel ? "未标记渠道" : "未知渠道", rawModel || "未知模型"];
        const group = ensureGroup(channel || "未知渠道");
        group.attempts += 1;
        if (event.level === "error") {
            group.failures += 1;
            group.lastError = event.message;
            group.lastErrorAt = event.at;
        }
        const modelKey = model || "未知模型";
        const modelGroup = group.models.get(modelKey) ?? { attempts: 0, failures: 0 };
        modelGroup.attempts += 1;
        if (event.level === "error") modelGroup.failures += 1;
        group.models.set(modelKey, modelGroup);
    }
    return [...groups.entries()]
        .map(([channel, group]) => ({
            channel,
            attempts: group.attempts,
            failures: group.failures,
            failureRate: group.attempts ? Math.round((group.failures / group.attempts) * 100) : 0,
            lastError: group.lastError,
            lastErrorAt: group.lastErrorAt,
            models: [...group.models.entries()].map(([model, stats]) => ({ model, ...stats })),
        }))
        .sort((a, b) => b.attempts - a.attempts);
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
