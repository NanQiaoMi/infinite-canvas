import { create } from "zustand";

import type { AiConfig } from "@/stores/use-config-store";
import { fetchQueueStatus, cancelImageTask, type ImageTaskStatus, type QueueStatusResult } from "@/services/api/image-queue";

export type ImageTaskSource = "workbench" | "chat" | "canvas";

export interface PersistedImageTask {
    taskId: string;
    source: ImageTaskSource;
    prompt: string;
    model: string;
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
