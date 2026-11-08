import { create } from "zustand";

import type { AiConfig } from "@/stores/use-config-store";
import { fetchQueueStatus, cancelImageTask, type ImageTaskStatus, type QueueStatusResult } from "@/services/api/image-queue";
import type { ReferenceImage } from "@/types/image";

export type ImageTaskSource = "workbench" | "chat" | "canvas";

export interface PersistedImageTask {
    taskId: string;
    source: ImageTaskSource;
    prompt: string;
    model: string;
    /** 提交该任务时的 API 渠道 baseUrl 指纹；恢复时用来拒绝跨渠道复用 task_id。 */
    baseUrl?: string;
    size?: string;
    count?: number;
    createdAt: number;
    updatedAt: number;
    status: ImageTaskStatus;
    queuePosition?: number;
    estimatedWaitSeconds?: number;
    progress?: number;
    durationSeconds?: number;
    error?: string | null;
    slotIndex?: number;
    nodeId?: string;
    sessionId?: string;
    canvasProjectId?: string;
    resultDataUrl?: string;
}

export type WorkbenchRecoveryRejectionReason = "channel-mismatch" | "missing-prompt";

export type WorkbenchRecoveryPlanEntry = { task: PersistedImageTask; slotIndex: number };

export type WorkbenchRecoveryRejection = { task: PersistedImageTask; reason: WorkbenchRecoveryRejectionReason };

export type WorkbenchRecoveryPlan = { entries: WorkbenchRecoveryPlanEntry[]; rejected: WorkbenchRecoveryRejection[] };

function normalizeChannelBaseUrl(baseUrl: string | undefined) {
    return (baseUrl || "").trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * 规划刷新/重进工作台后的恢复：只恢复 workbench 来源、仍在排队/生成中的任务；
 * 渠道 baseUrl 与当前渠道都不为空且不一致、或提示词缺失的任务直接拒绝（返回原因，调用方标记失败并提示），
 * 避免用当前渠道去轮询别的渠道创建的 task_id，也避免空提示词任务恢复；无指纹的旧任务按同渠道放行。
 * 恢复顺序按持久化的 slotIndex 归位（无 slotIndex 的按创建时间补位，冲突时顺延），保持与原批次的槽位一致。
 */
export function planWorkbenchRecovery(tasks: PersistedImageTask[], current: { baseUrl?: string }): WorkbenchRecoveryPlan {
    const currentBaseUrl = normalizeChannelBaseUrl(current.baseUrl);
    const pending = tasks
        .filter((task) => task.source === "workbench" && (task.status === "queued" || task.status === "processing"))
        .sort((left, right) => (left.slotIndex ?? Number.MAX_SAFE_INTEGER) - (right.slotIndex ?? Number.MAX_SAFE_INTEGER) || left.createdAt - right.createdAt);
    const entries: WorkbenchRecoveryPlanEntry[] = [];
    const rejected: WorkbenchRecoveryRejection[] = [];
    const usedSlots = new Set<number>();
    pending.forEach((task) => {
        if (!task.prompt.trim()) {
            rejected.push({ task, reason: "missing-prompt" });
            return;
        }
        // 旧持久化任务可能没有渠道指纹（本次修复前写入）：仅在两边都有指纹且不一致时拒绝，
        // 无指纹任务按同渠道放行，避免升级后把可恢复的旧任务误判为跨渠道丢弃。
        const taskBaseUrl = normalizeChannelBaseUrl(task.baseUrl);
        if (taskBaseUrl && currentBaseUrl && taskBaseUrl !== currentBaseUrl) {
            rejected.push({ task, reason: "channel-mismatch" });
            return;
        }
        let slotIndex = typeof task.slotIndex === "number" && task.slotIndex >= 0 ? task.slotIndex : entries.length;
        while (usedSlots.has(slotIndex)) slotIndex += 1;
        usedSlots.add(slotIndex);
        entries.push({ task, slotIndex });
    });
    entries.sort((left, right) => left.slotIndex - right.slotIndex);
    return { entries, rejected };
}

export type WorkbenchRecoverySlot =
    | { kind: "task"; slotIndex: number; task: PersistedImageTask }
    | { kind: "skipped"; slotIndex: number };

/**
 * 把恢复计划映射回持久化的绝对槽位：结果数组按最大 slotIndex 补齐，空槽用 skipped 占位，
 * 保证刷新/重进后每个任务仍落在它原来的格子里，而不是被压缩到前几个下标。
 */
export function buildRecoverySlots(entries: WorkbenchRecoveryPlanEntry[]): WorkbenchRecoverySlot[] {
    if (!entries.length) return [];
    const maxSlotIndex = Math.max(...entries.map((entry) => entry.slotIndex));
    const slots: WorkbenchRecoverySlot[] = Array.from({ length: maxSlotIndex + 1 }, (_, slotIndex) => ({ kind: "skipped", slotIndex }));
    entries.forEach((entry) => {
        slots[entry.slotIndex] = { kind: "task", slotIndex: entry.slotIndex, task: entry.task };
    });
    return slots;
}

export type RetrySlotSnapshot = { prompt: string; references: ReferenceImage[] };

/**
 * 失败卡片"重试"只使用该槽位自己的提示词/参考图快照，绝不回落到输入框当前提示词，
 * 避免用户改完提示词后把新提示词补进旧批次造成同一网格混排两套提示词。
 */
export function resolveRetrySlotSnapshot(slot: { prompt?: string; references?: ReferenceImage[] } | undefined): RetrySlotSnapshot | null {
    const prompt = typeof slot?.prompt === "string" ? slot.prompt.trim() : "";
    if (!prompt) return null;
    return { prompt, references: slot?.references ? [...slot.references] : [] };
}

const BATCH_PLAN_STORAGE_KEY = "infinite-canvas:pending_image_batch_plan";

/** 批次计划的最长有效期：超过仍未恢复完成的计划视为过期，避免旧提示词被延迟补提交。 */
export const BATCH_PLAN_TTL_MS = 15 * 60 * 1000;

export type PersistedBatchPlan = {
    batchId: string;
    prompt: string;
    model: string;
    size?: string;
    quality?: string;
    count: number;
    createdAt: number;
    /** slotIndex -> 已提交的 taskId；刷新后据此续轮询，未提交的槽位据此补提交。 */
    submitted: Record<string, string>;
};

function getLocalStorage(): Storage | null {
    try {
        return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
        return null;
    }
}

function readBatchPlanRaw(): PersistedBatchPlan | null {
    const storage = getLocalStorage();
    if (!storage) return null;
    try {
        const raw = storage.getItem(BATCH_PLAN_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as PersistedBatchPlan;
        if (!parsed || typeof parsed !== "object") return null;
        if (typeof parsed.batchId !== "string" || !parsed.batchId) return null;
        if (typeof parsed.prompt !== "string" || !parsed.prompt.trim()) return null;
        if (typeof parsed.count !== "number" || parsed.count < 1 || parsed.count > 10) return null;
        if (typeof parsed.createdAt !== "number") return null;
        if (!parsed.submitted || typeof parsed.submitted !== "object") parsed.submitted = {};
        return parsed;
    } catch {
        return null;
    }
}

/** 读取仍可恢复的批次计划：仅保留 TTL 内、提示词完整的计划。 */
export function readResumableBatchPlan(now = Date.now()): PersistedBatchPlan | null {
    const plan = readBatchPlanRaw();
    if (!plan) return null;
    if (now - plan.createdAt > BATCH_PLAN_TTL_MS) return null;
    return plan;
}

/**
 * 批次开始时持久化完整计划（仅在无参考图的纯文生图批次启用，参考图编辑批次不持久化），
 * 这样刷新时除已提交任务外，尚未提交的槽位也能按原提示词补提交。
 * 隐私模式或存储配额不足时静默失败，不影响正常生成。
 */
export function saveBatchPlan(plan: Omit<PersistedBatchPlan, "submitted" | "createdAt"> & { createdAt?: number }): string {
    const payload: PersistedBatchPlan = { ...plan, createdAt: plan.createdAt ?? Date.now(), submitted: {} };
    try {
        getLocalStorage()?.setItem(BATCH_PLAN_STORAGE_KEY, JSON.stringify(payload));
    } catch {
        // ignore storage errors
    }
    return payload.batchId;
}

/** 记录某槽位已提交的 taskId，供刷新后恢复轮询。 */
export function markBatchPlanSlotSubmitted(batchId: string, slotIndex: number, taskId: string): void {
    const plan = readBatchPlanRaw();
    if (!plan || plan.batchId !== batchId) return;
    plan.submitted[String(slotIndex)] = taskId;
    try {
        getLocalStorage()?.setItem(BATCH_PLAN_STORAGE_KEY, JSON.stringify(plan));
    } catch {
        // ignore storage errors
    }
}

/** 批次正常结束或确认完成后清理计划；页面卸载中断时保留，供下次进入时继续恢复。 */
export function clearBatchPlan(batchId: string): void {
    const plan = readBatchPlanRaw();
    if (!plan || plan.batchId !== batchId) return;
    try {
        getLocalStorage()?.removeItem(BATCH_PLAN_STORAGE_KEY);
    } catch {
        // ignore storage errors
    }
}

export type BatchResumeEntry = { slotIndex: number; prompt: string; model: string; taskId?: string };

export type BatchResumePlan = { entries: BatchResumeEntry[]; count: number };

/**
 * 根据持久化批次计划 + 已持久化的活跃任务，推导刷新后需要恢复/补提交的全部槽位：
 * 有活跃任务的槽位按其 task_id 续轮询；没有任务但计划里记录过 task_id 的槽位也继续轮询；
 * 两者都没有的槽位按批次提示词重新提交，从而补齐刷新前尚未提交的排队槽位。
 */
export function resolveBatchResumePlan(plan: PersistedBatchPlan, tasks: PersistedImageTask[], options?: { baseUrl?: string }): BatchResumePlan {
    const currentBaseUrl = normalizeChannelBaseUrl(options?.baseUrl);
    const activeBySlot = new Map<number, PersistedImageTask>();
    for (const task of tasks) {
        if (task.source !== "workbench") continue;
        if (task.status !== "queued" && task.status !== "processing") continue;
        if (typeof task.slotIndex !== "number" || task.slotIndex < 0 || task.slotIndex >= plan.count) continue;
        if (activeBySlot.has(task.slotIndex)) continue;
        activeBySlot.set(task.slotIndex, task);
    }
    const entries: BatchResumeEntry[] = [];
    for (let slotIndex = 0; slotIndex < plan.count; slotIndex += 1) {
        const active = activeBySlot.get(slotIndex);
        if (active) {
            const taskBaseUrl = normalizeChannelBaseUrl(active.baseUrl);
            if (taskBaseUrl && currentBaseUrl && taskBaseUrl !== currentBaseUrl) continue;
            entries.push({ slotIndex, prompt: active.prompt, model: active.model, taskId: active.taskId });
            continue;
        }
        const submittedTaskId = plan.submitted[String(slotIndex)];
        entries.push({ slotIndex, prompt: plan.prompt, model: plan.model, ...(submittedTaskId ? { taskId: submittedTaskId } : {}) });
    }
    return { entries, count: plan.count };
}

const STORAGE_KEY = "infinite-canvas:active_image_tasks";

function loadFromStorage(): Record<string, PersistedImageTask> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
            const now = Date.now();
            const validEntries = Object.entries(parsed).filter(([, item]) => {
                const task = item as PersistedImageTask;
                // 仅保留未完成或 15 分钟以内创建的任务
                return (
                    task &&
                    task.taskId &&
                    (task.status === "queued" || task.status === "processing") &&
                    now - (task.createdAt || 0) < 15 * 60 * 1000
                );
            });
            return Object.fromEntries(validEntries) as Record<string, PersistedImageTask>;
        }
    } catch {
        // ignore JSON parse error
    }
    return {};
}

function saveToStorage(tasks: Record<string, PersistedImageTask>) {
    try {
        const activeOnly = Object.fromEntries(
            Object.entries(tasks).filter(([, task]) => task.status === "queued" || task.status === "processing"),
        );
        if (Object.keys(activeOnly).length === 0) {
            localStorage.removeItem(STORAGE_KEY);
        } else {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(activeOnly));
        }
    } catch {
        // ignore storage quota error
    }
}

interface ImageTaskState {
    activeTasks: Record<string, PersistedImageTask>;
    queueStatus: QueueStatusResult | null;
    registerActiveTask: (task: Omit<PersistedImageTask, "updatedAt">) => void;
    updateActiveTask: (taskId: string, patch: Partial<PersistedImageTask>) => void;
    completeActiveTask: (taskId: string, status: "succeeded" | "failed" | "cancelled", error?: string, resultDataUrl?: string) => void;
    removeActiveTask: (taskId: string) => void;
    cancelTask: (config: AiConfig, taskId: string) => Promise<boolean>;
    getTasksBySource: (source: ImageTaskSource) => PersistedImageTask[];
    getTask: (taskId: string) => PersistedImageTask | undefined;
    setQueueStatus: (status: QueueStatusResult | null) => void;
    refreshQueueStatus: (config: AiConfig) => Promise<QueueStatusResult | null>;
}

export const useImageTaskStore = create<ImageTaskState>((set, get) => ({
    activeTasks: loadFromStorage(),
    queueStatus: null,

    registerActiveTask: (task) => {
        set((state) => {
            const nextTasks = {
                ...state.activeTasks,
                [task.taskId]: {
                    ...task,
                    updatedAt: Date.now(),
                },
            };
            saveToStorage(nextTasks);
            return { activeTasks: nextTasks };
        });
    },

    updateActiveTask: (taskId, patch) => {
        set((state) => {
            const current = state.activeTasks[taskId];
            if (!current) return state;
            const nextTasks = {
                ...state.activeTasks,
                [taskId]: {
                    ...current,
                    ...patch,
                    updatedAt: Date.now(),
                },
            };
            saveToStorage(nextTasks);
            return { activeTasks: nextTasks };
        });
    },

    completeActiveTask: (taskId, status, error, resultDataUrl) => {
        set((state) => {
            const current = state.activeTasks[taskId];
            if (!current) return state;
            const nextTasks = {
                ...state.activeTasks,
                [taskId]: {
                    ...current,
                    status,
                    ...(error ? { error } : {}),
                    ...(resultDataUrl ? { resultDataUrl } : {}),
                    updatedAt: Date.now(),
                },
            };
            saveToStorage(nextTasks);
            return { activeTasks: nextTasks };
        });
    },

    removeActiveTask: (taskId) => {
        set((state) => {
            if (!(taskId in state.activeTasks)) return state;
            const nextTasks = { ...state.activeTasks };
            delete nextTasks[taskId];
            saveToStorage(nextTasks);
            return { activeTasks: nextTasks };
        });
    },

    cancelTask: async (config, taskId) => {
        get().completeActiveTask(taskId, "cancelled");
        return await cancelImageTask(config, taskId);
    },

    getTasksBySource: (source) => {
        const tasks = Object.values(get().activeTasks);
        return tasks.filter((t) => t.source === source);
    },

    getTask: (taskId) => {
        return get().activeTasks[taskId];
    },

    setQueueStatus: (status) => {
        set({ queueStatus: status });
    },

    refreshQueueStatus: async (config) => {
        const status = await fetchQueueStatus(config);
        set({ queueStatus: status });
        return status;
    },
}));
