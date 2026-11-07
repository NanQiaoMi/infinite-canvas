import axios from "axios";

import { buildApiUrl, type AiConfig } from "@/stores/use-config-store";
import { readAxiosError } from "@/services/api/image";

export type ImageTaskStatus = "queued" | "processing" | "succeeded" | "failed" | "cancelled";

export interface ImageTaskResult {
    task_id: string;
    status: ImageTaskStatus;
    queue_position: number;
    estimated_wait_seconds: number;
    progress: number;
    created_at?: number;
    duration_seconds: number;
    data?: Array<{ url?: string; b64_json?: string }>;
    error?: string | null;
}

export interface QueueStatusResult {
    max_concurrency: number;
    active_tasks: number;
    queued_tasks: number;
    available_slots: number;
}

export type PollImageTaskOptions = {
    signal?: AbortSignal;
    onProgress?: (task: ImageTaskResult) => void;
    pollIntervalMs?: number;
    maxConsecutiveErrors?: number;
};

function aiHeaders(config: AiConfig) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
    };
}

/**
 * 轮询图片任务状态直到成功、失败或取消
 */
export async function pollImageTask(
    config: AiConfig,
    taskId: string,
    options?: PollImageTaskOptions,
): Promise<ImageTaskResult> {
    const pollInterval = options?.pollIntervalMs ?? 1800;
    const maxErrors = options?.maxConsecutiveErrors ?? 3;
    let consecutiveErrors = 0;

    while (true) {
        if (options?.signal?.aborted) {
            cancelImageTask(config, taskId).catch(() => {});
            const abortError = new Error("任务已取消");
            abortError.name = "AbortError";
            throw abortError;
        }

        let response: { data: ImageTaskResult };
        try {
            const targetUrl = buildApiUrl(config.baseUrl, `/tasks/${encodeURIComponent(taskId)}`);
            response = await axios.get<ImageTaskResult>(targetUrl, {
                headers: aiHeaders(config),
                signal: options?.signal,
                timeout: 10000,
            });
            consecutiveErrors = 0;
        } catch (error) {
            if (options?.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
                cancelImageTask(config, taskId).catch(() => {});
                throw error;
            }

            // 若返回 4xx 确定性客户端错误，直接抛出，不进行退避重试
            if (axios.isAxiosError(error) && error.response && error.response.status >= 400 && error.response.status < 500) {
                throw new Error(readAxiosError(error, "获取图片生成任务状态失败"));
            }

            consecutiveErrors += 1;
            if (consecutiveErrors > maxErrors) {
                throw new Error(`连接生成队列异常，已连续重试 ${maxErrors} 次: ${error instanceof Error ? error.message : String(error)}`);
            }

            // 遇到临时网络抖动，执行退避重试
            const backoffMs = options?.pollIntervalMs && options.pollIntervalMs < 100 ? 5 : Math.min(4000, 1000 * consecutiveErrors);
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            continue;
        }

        const task = response.data;
        options?.onProgress?.(task);

        if (task.status === "succeeded") {
            return task;
        }
        if (task.status === "failed") {
            throw new Error(task.error || "图片生成失败");
        }
        if (task.status === "cancelled") {
            throw new Error("任务已在服务端取消");
        }

        await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
}

/**
 * 用户主动取消排队任务，释放排队槽位
 */
export async function cancelImageTask(config: AiConfig, taskId: string): Promise<boolean> {
    if (!taskId) return false;
    try {
        const targetUrl = buildApiUrl(config.baseUrl, `/tasks/${encodeURIComponent(taskId)}`);
        await axios.delete(targetUrl, {
            headers: aiHeaders(config),
            timeout: 5000,
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * 获取全局生成队列水位
 */
export async function fetchQueueStatus(config: AiConfig, signal?: AbortSignal): Promise<QueueStatusResult | null> {
    try {
        const targetUrl = buildApiUrl(config.baseUrl, "/queue/status");
        const response = await axios.get<QueueStatusResult>(targetUrl, {
            headers: aiHeaders(config),
            signal,
            timeout: 5000,
        });
        if (response.data && typeof response.data === "object" && "max_concurrency" in response.data) {
            return response.data;
        }
        return null;
    } catch {
        return null;
    }
}
