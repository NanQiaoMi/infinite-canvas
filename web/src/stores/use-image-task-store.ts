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
 * 渠道 baseUrl 与当前渠道不一致或提示词缺失的任务直接拒绝（返回原因，调用方标记失败并提示），
 * 避免用当前渠道去轮询别的渠道创建的 task_id，也避免空提示词任务恢复。
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
        if (normalizeChannelBaseUrl(task.baseUrl) !== currentBaseUrl) {
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
