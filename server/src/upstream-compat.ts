import type { InternalChannel } from "./channels";
import { HttpError } from "./http";
import { log } from "./logger";

/**
 * 部分上游（ChatGPT2API）只提供 /api/image-tasks 异步任务协议，
 * 这里把画布依赖的 /v1/images/*、/v1/tasks/*、/v1/queue/status、/v1/models 适配成该协议，
 * 使不同上游对前端呈现一致的能力。
 */

type CompatResult = { url?: string; b64_json?: string; path?: string; revised_prompt?: string; width?: number; height?: number };

type CompatTask = {
    id: string;
    status: string;
    terminal: boolean;
    mode?: "generate" | "edit";
    model?: string;
    created_at?: string;
    duration_ms?: number | null;
    requested_count?: number;
    succeeded_count?: number;
    failed_count?: number;
    error_code?: string;
    public_error?: string;
    results?: CompatResult[];
};

const PATHS = {
    generate: /^\/v1\/images\/generations$/i,
    edit: /^\/v1\/images\/edits$/i,
    // 兼容上游 40581 的任务/队列别名，前端与脚本两种路径都能用。
    task: /^\/(?:v1\/(?:images\/)?|api\/)tasks\/([^/]+)$/i,
    queue: /^\/(?:v1|api)\/queue\/status$/i,
    models: /^\/v1\/models$/i,
    catalog: /^\/api\/model-catalog(?:\/refresh)?$/i,
    health: /^\/health$/i,
};

const TERMINAL_STATUS = new Set(["success", "partial_success", "failed", "text_review"]);

export function isCompatTarget(target: URL): boolean {
    return Object.values(PATHS).some((pattern) => pattern.test(target.pathname));
}

function upstreamBase(channel: InternalChannel) {
    return channel.baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function authHeaders(channel: InternalChannel) {
    const headers = new Headers({ "content-type": "application/json" });
    if (channel.apiFormat === "gemini") headers.set("x-goog-api-key", channel.apiKey);
    else headers.set("authorization", `Bearer ${channel.apiKey}`);
    return headers;
}

function statusFor(task: CompatTask) {
    if (task.status === "queued") return "queued";
    if (TERMINAL_STATUS.has(task.status)) return task.status === "success" || task.status === "partial_success" ? "succeeded" : "failed";
    return "processing";
}

function progressFor(task: CompatTask) {
    if (task.terminal) return 1;
    const done = (task.succeeded_count || 0) + (task.failed_count || 0);
    const total = task.requested_count || 1;
    return Math.min(0.95, Math.max(0.05, done / total));
}

/** 上游返回的图片地址是内网直连地址，统一改写成经 /api/relay 取回，避免浏览器跨域与内网不可达。 */
function toRelayUrl(url: string) {
    if (!/^https?:\/\//i.test(url)) return url;
    return `/api/relay?url=${encodeURIComponent(url)}`;
}

function createdAtSeconds(value: string | undefined) {
    if (!value) return undefined;
    const parsed = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}

function toCanvasTask(task: CompatTask, prompt?: string) {
    const status = statusFor(task);
    return {
        task_id: task.id,
        status,
        queue_position: 0,
        estimated_wait_seconds: 0,
        progress: progressFor(task),
        created_at: createdAtSeconds(task.created_at),
        duration_seconds: Math.round((task.duration_ms || 0) / 1000),
        data: (task.results || []).map((item) => ({
            ...(item.b64_json ? { b64_json: item.b64_json } : {}),
            ...(item.url ? { url: toRelayUrl(item.url) } : {}),
        })),
        error: status === "failed" ? task.public_error || task.error_code || "图片生成失败" : null,
        ...(prompt ? { prompt } : {}),
        model: task.model,
    };
}

async function readTask(channel: InternalChannel, taskId: string, timeoutMs: number): Promise<CompatTask | null> {
    const response = await fetch(`${upstreamBase(channel)}/api/image-tasks?ids=${encodeURIComponent(taskId)}`, {
        headers: authHeaders(channel),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { items?: CompatTask[] };
    return data.items?.[0] ?? null;
}

/** 记录画布任务对应的提示词，用于任务轮询时回显，避免前端把结果错配到其它提示词。 */
const taskPrompts = new Map<string, string>();

function rememberPrompt(taskId: string, prompt: string) {
    taskPrompts.set(taskId, prompt);
    if (taskPrompts.size > 2000) {
        const oldest = taskPrompts.keys().next().value;
        if (oldest) taskPrompts.delete(oldest);
    }
}

function jsonResponse(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

/**
 * 处理只支持 /api/image-tasks 的上游：
 * 提交生成/改图任务、查询任务状态、返回队列水位、合并模型列表。
 * 返回 null 表示不是需要适配的请求，交回原有 relay 逻辑。
 */
export async function handleCompatRequest(channel: InternalChannel, req: Request, target: URL, bodyBytes: Uint8Array | null, timeoutMs: number): Promise<Response | null> {
    if (!isCompatTarget(target)) return null;
    if (!channel.apiKey) throw new HttpError(502, "channel_key_missing", "渠道未配置 API Key，请联系管理员");

    const method = req.method.toUpperCase();
    const base = upstreamBase(channel);
    const headers = authHeaders(channel);

    if (PATHS.health.test(target.pathname)) {
        // 上游没有 /health 时，用模型列表探测可用性，保证健康检查语义一致。
        let ok = false;
        try {
            const response = await fetch(`${base}/v1/models`, { headers, signal: AbortSignal.timeout(timeoutMs) });
            ok = response.ok;
        } catch {
            ok = false;
        }
        return jsonResponse({ status: ok ? "ok" : "error", accounts_total: channel.models.length, timestamp: Math.floor(Date.now() / 1000) }, ok ? 200 : 503);
    }

    if (PATHS.catalog.test(target.pathname)) {
        const chat = channel.models.filter((model) => model.capability === "text").map((model) => model.name);
        const image = channel.models.filter((model) => model.capability === "image").map((model) => model.name);
        return jsonResponse({
            object: "model_catalog",
            schema_version: 1,
            generated_at: new Date().toISOString(),
            revision: `channel_${channel.id}`,
            chat_models: chat,
            image_models: image,
            all_models: [...chat, ...image],
        });
    }

    if (PATHS.models.test(target.pathname)) {
        if (method !== "GET") return null;
        let upstreamIds: string[] = [];
        try {
            const response = await fetch(`${base}/v1/models`, { headers, signal: AbortSignal.timeout(timeoutMs) });
            const data = (await response.json()) as { data?: Array<{ id?: string }> };
            upstreamIds = (data.data || []).map((item) => item.id || "").filter(Boolean);
        } catch (error) {
            log.warn("compat models fetch failed", { error: String(error) });
        }
        // 上游只按账号套餐暴露部分模型，这里合并渠道里已配置的模型，保证「探索模型」看到完整清单。
        const ids = Array.from(new Set([...upstreamIds, ...channel.models.map((model) => model.name)]));
        return jsonResponse({ object: "list", data: ids.map((id) => ({ id, object: "model", created: 0, owned_by: "compat" })) });
    }

    if (PATHS.queue.test(target.pathname)) {
        try {
            const response = await fetch(`${base}/api/image-tasks`, { headers, signal: AbortSignal.timeout(timeoutMs) });
            if (!response.ok) throw new Error(`upstream ${response.status}`);
            const data = (await response.json()) as { items?: CompatTask[] };
            const items = data.items || [];
            const active = items.filter((task) => !task.terminal).length;
            const max = Math.max(4, active);
            return jsonResponse({ max_concurrency: max, active_tasks: active, queued_tasks: 0, available_slots: Math.max(0, max - active), total_processed: items.length, estimated_wait_per_task_seconds: 25 });
        } catch (error) {
            log.warn("compat queue status failed", { error: String(error) });
            return jsonResponse({ max_concurrency: 4, active_tasks: 0, queued_tasks: 0, available_slots: 4 });
        }
    }

    const taskMatch = target.pathname.match(PATHS.task);
    if (taskMatch) {
        const taskId = decodeURIComponent(taskMatch[1]);
        if (method === "GET") {
            const task = await readTask(channel, taskId, timeoutMs);
            if (!task) throw new HttpError(404, "task_not_found", "任务不存在或已过期");
            return jsonResponse(toCanvasTask(task, taskPrompts.get(taskId)));
        }
        if (method === "DELETE") return jsonResponse({ ok: true });
        throw new HttpError(405, "method_not_allowed", "不支持的任务操作");
    }

    if (method !== "POST") throw new HttpError(405, "method_not_allowed", "不支持的请求方法");
    const rawBody = bodyBytes ?? new Uint8Array(await req.arrayBuffer());
    if (!rawBody.byteLength) throw new HttpError(400, "empty_body", "请求体不能为空");

    // boundary 大小写敏感：只对类型做小写判断，转发时保留原始 content-type。
    const rawContentType = req.headers.get("content-type") || "";
    const contentType = rawContentType.toLowerCase();

    if (PATHS.edit.test(target.pathname)) {
        // 改图需要原始图片文件，直接把 multipart 原样透传给上游，避免重新解析破坏边界。
        const upstream = await fetch(`${base}/v1/images/edits`, {
            method: "POST",
            headers: new Headers({ authorization: `Bearer ${channel.apiKey}`, "content-type": rawContentType }),
            body: rawBody as unknown as BodyInit,
            signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await upstream.text();
        const upstreamType = upstream.headers.get("content-type") || "application/json";
        if (!upstream.ok) {
            log.warn("compat image edit failed", { status: upstream.status, type: upstreamType, bytes: rawBody.byteLength, body: text.slice(0, 200) });
        }
        if (upstream.ok && upstreamType.includes("application/json")) {
            try {
                const data = JSON.parse(text) as { data?: Array<Record<string, unknown>> };
                if (Array.isArray(data.data)) {
                    data.data = data.data.map((item) => (typeof item.url === "string" ? { ...item, url: toRelayUrl(item.url) } : item));
                    return new Response(JSON.stringify(data), { status: upstream.status, headers: { "content-type": upstreamType } });
                }
            } catch {
                // 非预期 JSON 时原样返回，交由前端提示。
            }
        }
        return new Response(text, { status: upstream.status, headers: { "content-type": upstreamType } });
    }

    if (!contentType.includes("application/json")) throw new HttpError(415, "unsupported_content_type", "仅支持 JSON 请求");
    const payload = JSON.parse(new TextDecoder().decode(rawBody)) as Record<string, unknown>;

    const prompt = String(payload.prompt || "").trim();
    if (!prompt) throw new HttpError(400, "missing_prompt", "缺少提示词");
    const taskPayload = {
        client_task_id: `canvas_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        prompt,
        model: String(payload.model || "gpt-image-2").trim(),
        n: Math.max(1, Math.min(15, Number(payload.n) || 1)),
        ...(payload.size ? { size: String(payload.size) } : {}),
        ...(payload.quality ? { quality: String(payload.quality) } : {}),
        ...(payload.output_format ? { output_format: String(payload.output_format) } : {}),
        ...(payload.frame_count ? { frame_count: Number(payload.frame_count) } : {}),
        ...(payload.frame_duration_ms ? { frame_duration_ms: Number(payload.frame_duration_ms) } : {}),
    };

    const upstream = await fetch(`${base}/api/image-tasks/generations`, {
        method: "POST",
        headers,
        body: JSON.stringify(taskPayload),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await upstream.text();
    if (!upstream.ok) {
        log.warn("compat image task create failed", { status: upstream.status, body: text.slice(0, 200) });
        return new Response(text, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") || "application/json" } });
    }
    const task = JSON.parse(text) as CompatTask;
    rememberPrompt(task.id, prompt);
    return jsonResponse(toCanvasTask(task, prompt), 202);
}
