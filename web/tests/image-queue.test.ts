const storeMap = new Map<string, string>();
if (typeof globalThis.localStorage === "undefined") {
    (globalThis as any).localStorage = {
        getItem: (k: string) => storeMap.get(k) ?? null,
        setItem: (k: string, v: string) => storeMap.set(k, String(v)),
        removeItem: (k: string) => storeMap.delete(k),
        clear: () => storeMap.clear(),
        key: (i: number) => Array.from(storeMap.keys())[i] ?? null,
        get length() { return storeMap.size; },
    };
}

import { describe, expect, it, mock } from "bun:test";
import axios from "axios";

import { pollImageTask, cancelImageTask, fetchQueueStatus, type ImageTaskResult } from "../src/services/api/image-queue";
import { useImageTaskStore } from "../src/stores/use-image-task-store";
import type { AiConfig } from "../src/stores/use-config-store";

const mockConfig: AiConfig = {
    provider: "openai",
    model: "gpt-image-2",
    imageModel: "gpt-image-2",
    textModel: "gpt-4o",
    videoModel: "luma",
    audioModel: "tts-1",
    apiKey: "test-key",
    baseUrl: "https://api.openai.com/v1",
    apiFormat: "openai",
    systemPrompt: "",
    count: "1",
    size: "1024x1024",
    quality: "standard",
    proxyEnabled: false,
    proxyUrl: "",
    customHeaders: {},
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1.0",
    imageFormat: "png",
    videoQuality: "720p",
    videoDuration: "5",
    videoFps: "30",
    videoSeconds: "5",
    videoSize: "1280x720",
    videoMode: "text2video",
    videoWatermark: false,
    vquality: "standard",
    videoGenerateAudio: false,
    gifFrames: "9",
    gifFrameDuration: "200",
    thinkingEffort: "medium",
    reasoningEffort: "medium",
    nodeRegenerateBehavior: "overwrite",
};

describe("异步生成任务队列与轮询机制 (image-queue)", () => {
    it("正常完成排队轮询生命周期 (queued -> processing -> succeeded)", async () => {
        let callCount = 0;
        const progressSnapshots: ImageTaskResult[] = [];

        const originalGet = axios.get;
        axios.get = mock(async () => {
            callCount += 1;
            if (callCount === 1) {
                return {
                    status: 200,
                    data: {
                        task_id: "task_123",
                        status: "queued",
                        queue_position: 2,
                        estimated_wait_seconds: 40,
                        progress: 0.0,
                        duration_seconds: 1.0,
                    },
                };
            }
            if (callCount === 2) {
                return {
                    status: 200,
                    data: {
                        task_id: "task_123",
                        status: "processing",
                        queue_position: 0,
                        estimated_wait_seconds: 20,
                        progress: 0.65,
                        duration_seconds: 5.0,
                    },
                };
            }
            return {
                status: 200,
                data: {
                    task_id: "task_123",
                    status: "succeeded",
                    queue_position: 0,
                    estimated_wait_seconds: 0,
                    progress: 1.0,
                    duration_seconds: 9.2,
                    data: [{ url: "https://example.com/cat.png" }],
                },
            };
        }) as unknown as typeof axios.get;

        try {
            const finalTask = await pollImageTask(mockConfig, "task_123", {
                pollIntervalMs: 10,
                onProgress: (task) => progressSnapshots.push(task),
            });

            expect(finalTask.status).toBe("succeeded");
            expect(finalTask.data?.[0]?.url).toBe("https://example.com/cat.png");
            expect(progressSnapshots.length).toBe(3);
            expect(progressSnapshots[0].status).toBe("queued");
            expect(progressSnapshots[0].queue_position).toBe(2);
            expect(progressSnapshots[1].status).toBe("processing");
            expect(progressSnapshots[1].progress).toBe(0.65);
            expect(progressSnapshots[2].status).toBe("succeeded");
        } finally {
            axios.get = originalGet;
        }
    });

    it("当服务端返回 failed 时及时停止轮询并抛出错误原因", async () => {
        const originalGet = axios.get;
        axios.get = mock(async () => {
            return {
                status: 200,
                data: {
                    task_id: "task_failed",
                    status: "failed",
                    error: "提示词触发安全审查过滤",
                },
            };
        }) as unknown as typeof axios.get;

        try {
            await expect(
                pollImageTask(mockConfig, "task_failed", { pollIntervalMs: 10 }),
            ).rejects.toThrow("提示词触发安全审查过滤");
        } finally {
            axios.get = originalGet;
        }
    });

    it("发生临时网络异常时采用退避重试 (Backoff) 并在恢复后继续完成", async () => {
        let callCount = 0;
        const originalGet = axios.get;
        axios.get = mock(async () => {
            callCount += 1;
            if (callCount <= 2) {
                throw new Error("Network Error (ECONNRESET)");
            }
            return {
                status: 200,
                data: {
                    task_id: "task_network_retry",
                    status: "succeeded",
                    progress: 1.0,
                    data: [{ url: "https://example.com/retry-success.png" }],
                },
            };
        }) as unknown as typeof axios.get;

        try {
            const result = await pollImageTask(mockConfig, "task_network_retry", {
                pollIntervalMs: 10,
                maxConsecutiveErrors: 3,
            });
            expect(result.status).toBe("succeeded");
            expect(callCount).toBe(3);
        } finally {
            axios.get = originalGet;
        }
    });

    it("当 AbortSignal 中止时停止轮询并调用 DELETE /v1/tasks/{id} 取消排队", async () => {
        let deletedTaskId = "";
        const originalGet = axios.get;
        const originalDelete = axios.delete;

        axios.get = mock(async () => {
            return {
                status: 200,
                data: {
                    task_id: "task_to_cancel",
                    status: "queued",
                    queue_position: 5,
                    estimated_wait_seconds: 90,
                },
            };
        }) as unknown as typeof axios.get;

        axios.delete = mock(async (url: string) => {
            deletedTaskId = url;
            return { status: 200, data: { ok: true } };
        }) as unknown as typeof axios.delete;

        const controller = new AbortController();
        try {
            const promise = pollImageTask(mockConfig, "task_to_cancel", {
                signal: controller.signal,
                pollIntervalMs: 20,
            });

            // 触发取消
            setTimeout(() => controller.abort(), 10);
            await expect(promise).rejects.toThrow("任务已取消");
            expect(deletedTaskId).toContain("task_to_cancel");
        } finally {
            axios.get = originalGet;
            axios.delete = originalDelete;
        }
    });

    it("获取全局队列水位 (fetchQueueStatus)", async () => {
        const originalGet = axios.get;
        axios.get = mock(async () => {
            return {
                status: 200,
                data: {
                    max_concurrency: 4,
                    active_tasks: 2,
                    queued_tasks: 1,
                    available_slots: 2,
                },
            };
        }) as unknown as typeof axios.get;

        try {
            const status = await fetchQueueStatus(mockConfig);
            expect(status).not.toBeNull();
            expect(status?.max_concurrency).toBe(4);
            expect(status?.active_tasks).toBe(2);
            expect(status?.queued_tasks).toBe(1);
        } finally {
            axios.get = originalGet;
        }
    });
});

describe("图片任务状态管理与刷新恢复 (useImageTaskStore)", () => {
    it("正确注册、更新任务，并按 source 区分检索", () => {
        const store = useImageTaskStore.getState();

        store.registerActiveTask({
            taskId: "task_bench_01",
            source: "workbench",
            prompt: "可爱胖橘猫",
            model: "gpt-image-2",
            createdAt: Date.now(),
            status: "queued",
            queuePosition: 3,
            estimatedWaitSeconds: 60,
            slotIndex: 0,
        });

        store.registerActiveTask({
            taskId: "task_chat_01",
            source: "chat",
            prompt: "赛博朋克城市",
            model: "gpt-image-2",
            createdAt: Date.now(),
            status: "processing",
            progress: 0.4,
            sessionId: "session_123",
        });

        const workbenchTasks = store.getTasksBySource("workbench");
        const chatTasks = store.getTasksBySource("chat");

        expect(workbenchTasks.some((t) => t.taskId === "task_bench_01")).toBe(true);
        expect(chatTasks.some((t) => t.taskId === "task_chat_01")).toBe(true);

        // 更新进度
        store.updateActiveTask("task_bench_01", {
            status: "processing",
            progress: 0.8,
            queuePosition: 0,
        });

        const updated = store.getTask("task_bench_01");
        expect(updated?.status).toBe("processing");
        expect(updated?.progress).toBe(0.8);

        // 完成任务
        store.completeActiveTask("task_bench_01", "succeeded", undefined, "https://example.com/res.png");
        expect(store.getTask("task_bench_01")?.status).toBe("succeeded");

        // 清理测试任务
        store.removeActiveTask("task_bench_01");
        store.removeActiveTask("task_chat_01");
    });
});
