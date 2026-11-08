import axios from "axios";

import i18n from "@/i18n";
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
    /** 服务端回显的任务提示词（可选）：用于校验 task_id 与本地的提示词归属是否一致。 */
    prompt?: string;
    /** 服务端回显的任务模型（可选）：用于校验 task_id 与本地渠道是否一致。 */
    model?: string;
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
    /** 轮询过程中校验任务归属；抛错即中止轮询（不取消服务端任务），由调用方提示失败。 */
    validate?: (task: ImageTaskResult) => void;
    /** abort 时是否同时取消服务端任务，默认 true；页面卸载等「只断开轮询、任务仍应可恢复」的场景传 false。 */
    cancelOnAbort?: boolean;
};

export type ImageTaskEchoExpectation = {
    prompt?: string;
    model?: string;
};

function aiHeaders(config: AiConfig) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
    };
}

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

function normalizeEchoPrompt(value: string) {
    return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeEchoModel(value: string) {
    return (value.split("::").pop() || value).trim().toLowerCase();
}

/**
 * 校验服务端回显的 prompt/model 与本地记录是否一致，避免 task_id 张冠李戴把别的任务结果挂到当前提示词上。
 * 服务端未回显对应字段时跳过（兼容不返回回显的队列服务）。
 */
export function readImageTaskEchoMismatch(task: ImageTaskResult, expected: ImageTaskEchoExpectation): string | null {
    const echoedPrompt = typeof task.prompt === "string" ? normalizeEchoPrompt(task.prompt) : "";
    const expectedPrompt = expected.prompt ? normalizeEchoPrompt(expected.prompt) : "";
    if (echoedPrompt && expectedPrompt && !echoedPrompt.includes(expectedPrompt) && !expectedPrompt.includes(echoedPrompt)) {
        return apiText("taskPromptMismatch", { defaultValue: "生成任务回显的提示词与本地记录不一致，已停止恢复以避免结果错配", taskId: task.task_id });
    }
    const echoedModel = typeof task.model === "string" ? normalizeEchoModel(task.model) : "";
    const expectedModel = expected.model ? normalizeEchoModel(expected.model) : "";
    if (echoedModel && expectedModel && echoedModel !== expectedModel) {
        return apiText("taskModelMismatch", { defaultValue: "生成任务回显的模型与本地记录不一致，已停止恢复以避免结果错配", taskId: task.task_id });
    }
    return null;
}

export function assertImageTaskEcho(task: ImageTaskResult, expected: ImageTaskEchoExpectation) {
    const mismatch = readImageTaskEchoMismatch(task, expected);
    if (mismatch) throw new Error(mismatch);
}

async function cancelTaskOnAbort(config: AiConfig, taskId: string, options?: PollImageTaskOptions) {
    if (options?.cancelOnAbort === false) return;
    cancelImageTask(config, taskId).catch(() => {});
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
            cancelTaskOnAbort(config, taskId, options);
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
                cancelTaskOnAbort(config, taskId, options);
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
        options?.validate?.(task);
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
