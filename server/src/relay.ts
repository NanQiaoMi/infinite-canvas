import type { Database } from "bun:sqlite";

import { findChannelForTarget, listChannels, type InternalChannel } from "./channels";
import type { ServerConfig } from "./config";
import { HttpError, errorResponse, readBody, type RequestContext } from "./http";
import { getClientFromRequest } from "./identity";
import { log } from "./logger";
import { quotaStatusFor, reserveQuota, settleQuota, type ReserveFailure } from "./quota";
import { assertPublicHost, isUrlUnderBase, type RateLimiter } from "./security";
import type { Capability, ClientRecord, QuotaPolicy, QuotaStatus } from "./types";

const CAPABILITY_LABELS: Record<Capability, string> = {
    image: "图片",
    video: "视频",
    text: "文本",
    audio: "音频",
};

const HOP_BY_HOP_HEADERS = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "http2-settings",
]);

const STRIP_REQUEST_HEADERS = new Set([
    ...HOP_BY_HOP_HEADERS,
    "host",
    "cookie",
    "authorization",
    "x-goog-api-key",
    "x-api-key",
    "content-length",
    "origin",
    "referer",
    "accept-encoding",
    "x-forwarded-for",
    "x-forwarded-proto",
    "x-forwarded-host",
    "x-real-ip",
]);

const PASSTHROUGH_RESPONSE_HEADERS = ["content-type", "content-disposition", "cache-control", "etag", "last-modified", "accept-ranges", "content-range", "content-language"];

const MEDIA_MAX_BYTES = 512 * 1024 * 1024;
const MEDIA_REDIRECT_LIMIT = 3;

export type RelayDeps = {
    db: Database;
    config: ServerConfig;
    getQuotaPolicy: () => QuotaPolicy;
    relayLimiter: RateLimiter;
    /** 管理员会话在服务端模式下可豁免额度（可配置）。 */
    isAdminRequest: (req: Request) => boolean;
};

type RequestInfo = { capability: Capability; units: number; model: string };

export function createRelayHandler(deps: RelayDeps) {
    return async (req: Request, ctx: RequestContext): Promise<Response> => {
        const rawTarget = ctx.url.searchParams.get("url");
        if (!rawTarget) throw new HttpError(400, "relay_missing_url", "缺少 url 参数");
        let target: URL;
        try {
            target = new URL(rawTarget);
        } catch {
            throw new HttpError(400, "relay_invalid_url", "目标地址不合法");
        }
        if (target.protocol !== "http:" && target.protocol !== "https:") throw new HttpError(400, "relay_invalid_protocol", "仅支持 http(s) 目标地址");
        if (target.username || target.password) throw new HttpError(400, "relay_invalid_url", "目标地址不合法");

        const method = req.method.toUpperCase();
        if (method === "CONNECT" || method === "TRACE") throw new HttpError(405, "method_not_allowed", "不支持的请求方法");

        const channels = listChannels(deps.db, deps.config.secret);
        const channel = findChannelForTarget(channels, target);
        if (!channel) return handleMediaRelay(deps, req, ctx, target, method);
        if (!channel.apiKey) throw new HttpError(502, "channel_key_missing", "渠道未配置 API Key，请联系管理员");

        const client = getClientFromRequest(deps.db, deps.config.secret, req.headers.get("cookie"));
        if (!client) throw new HttpError(401, "session_required", "会话已失效，请刷新页面后重试");
        if (client.blocked) throw new HttpError(403, "client_blocked", "当前访问已被管理员封禁");
        if (!deps.relayLimiter.hit(client.id)) throw new HttpError(429, "rate_limited", "请求过于频繁，请稍后再试");

        const hasBody = method === "POST" || method === "PUT" || method === "PATCH";
        const bodyBytes = hasBody ? await readBody(req, deps.config.maxBodyBytes) : null;
        const info = await parseRequestInfo(method, target, bodyBytes, req.headers.get("content-type"), channel);

        if (info.model && channel.models.length > 0 && !channel.models.some((model) => model.name === info.model)) {
            throw new HttpError(400, "model_not_available", `模型 ${info.model} 未在渠道中配置`);
        }

        const policy = deps.getQuotaPolicy();
        const adminExempt = policy.adminExempt && deps.isAdminRequest(req);
        let eventId: number | null = null;
        if (info.units > 0 && !adminExempt) {
            const reservation = reserveQuota(deps.db, policy, client, ctx.ip, info.capability, info.units, {
                model: info.model,
                endpoint: target.pathname,
            });
            if (!reservation.ok) return quotaExceededResponse(deps, policy, client, info.capability, reservation.failure);
            eventId = reservation.eventId;
        }

        let upstream: Response;
        try {
            upstream = await fetchUpstream(req, target, channel, method, bodyBytes, deps.config);
        } catch (error) {
            if (eventId !== null) settleQuota(deps.db, eventId, policy.refundOnFailure ? "released" : "committed", null);
            if (error instanceof HttpError) throw error;
            if (req.signal.aborted) return new Response(null, { status: 499 });
            const message = error instanceof Error ? error.message : "unknown error";
            log.warn("upstream request failed", { endpoint: target.pathname, message });
            throw new HttpError(502, "upstream_unreachable", `上游接口不可达：${message}`);
        }

        const success = upstream.status >= 200 && upstream.status < 300;
        if (eventId !== null) {
            settleQuota(deps.db, eventId, success ? "committed" : policy.refundOnFailure ? "released" : "committed", upstream.status);
        }

        const headers = new Headers();
        for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
            const value = upstream.headers.get(name);
            if (value) headers.set(name, value);
        }
        const status = quotaStatusFor(deps.db, policy, client, undefined, adminExempt);
        for (const [name, value] of quotaHeaderEntries(status, info.capability)) headers.set(name, value);

        if (upstream.status === 204 || upstream.status === 304 || !upstream.body) {
            return new Response(null, { status: upstream.status, headers });
        }
        const body = upstream.body;
        req.signal.addEventListener("abort", () => void body.cancel().catch(() => undefined), { once: true });
        return new Response(body, { status: upstream.status, headers });
    };
}

async function parseRequestInfo(method: string, target: URL, bodyBytes: Uint8Array | null, contentType: string | null, channel: InternalChannel): Promise<RequestInfo> {
    const path = target.pathname.toLowerCase();
    const counted = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    let model = "";
    let requestedCount = 1;
    let modalities: string[] = [];

    if (bodyBytes && bodyBytes.byteLength > 0 && contentType) {
        const normalizedType = contentType.toLowerCase();
        try {
            if (normalizedType.includes("application/json")) {
                const data = JSON.parse(new TextDecoder().decode(bodyBytes)) as Record<string, unknown>;
                if (data && typeof data === "object") {
                    if (typeof data.model === "string") model = data.model;
                    const countValue = data.n ?? data.count ?? data.num_images;
                    if (countValue !== undefined) requestedCount = Number(countValue) || 1;
                    const generationConfig = (data.generationConfig ?? data.generation_config) as Record<string, unknown> | undefined;
                    const modality = generationConfig?.responseModalities ?? generationConfig?.response_modalities;
                    if (Array.isArray(modality)) modalities = modality.map(String);
                }
            } else if (normalizedType.includes("multipart/form-data") || normalizedType.includes("application/x-www-form-urlencoded")) {
                const form = await new Request("http://internal.local/relay", { method: "POST", headers: { "content-type": contentType }, body: bodyBytes }).formData();
                const modelValue = form.get("model");
                if (typeof modelValue === "string") model = modelValue;
                const countValue = form.get("n");
                if (countValue !== null) requestedCount = Number(countValue) || 1;
            }
        } catch {
            // 请求体解析失败时交由上游返回原始错误；额度按默认单位计。
        }
    }

    if (!model) {
        const match = target.pathname.match(/\/models\/([^/:]+)/i);
        if (match) model = decodeURIComponent(match[1]);
    }
    model = model.replace(/^models\//i, "").trim();
    const knownCapability = channel.models.find((item) => item.name === model)?.capability;

    let capability: Capability = "text";
    if (path.endsWith("/images/generations") || path.endsWith("/images/edits")) capability = "image";
    else if (path.endsWith("/videos") && counted) capability = "video";
    else if (path.endsWith("/audio/speech")) capability = "audio";
    else if (path.endsWith("/responses") || path.endsWith("/chat/completions")) capability = "text";
    else if (path.includes(":predictlongrunning")) capability = "video";
    else if (path.includes(":generatecontent") || path.includes(":streamgeneratecontent")) {
        capability = modalities.some((value) => value.toUpperCase().includes("AUDIO")) ? "audio" : (knownCapability ?? "text");
    } else if (knownCapability) {
        capability = knownCapability;
    }

    let units = 1;
    if (!counted) units = 0;
    else if (capability === "image") units = Math.max(1, Math.min(15, Math.floor(Math.abs(requestedCount) || 1)));
    return { capability, units, model };
}

function buildUpstreamHeaders(req: Request, channel: InternalChannel): Headers {
    const headers = new Headers();
    req.headers.forEach((value, key) => {
        const name = key.toLowerCase();
        if (STRIP_REQUEST_HEADERS.has(name)) return;
        headers.set(name, value);
    });
    if (channel.apiFormat === "gemini") headers.set("x-goog-api-key", channel.apiKey);
    else headers.set("authorization", `Bearer ${channel.apiKey}`);
    return headers;
}

async function fetchUpstream(req: Request, target: URL, channel: InternalChannel, method: string, bodyBytes: Uint8Array | null, config: ServerConfig, redirects = 3): Promise<Response> {
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("client_aborted"));
    req.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("upstream_timeout")), config.relayTimeoutMs);
    try {
        const headers = buildUpstreamHeaders(req, channel);
        const response = await fetch(target.toString(), {
            method,
            headers,
            body: method === "GET" || method === "HEAD" ? undefined : bodyBytes ?? undefined,
            redirect: "manual",
            signal: controller.signal,
        });
        if (response.status >= 300 && response.status < 400 && redirects > 0) {
            const location = response.headers.get("location");
            if (location) {
                const next = new URL(location, target);
                const nextKey = `${next.origin}${next.pathname}`;
                if (!isUrlUnderBase(nextKey, channel.baseUrl)) throw new HttpError(502, "upstream_redirect_rejected", "上游重定向到未授权地址");
                await response.body?.cancel().catch(() => undefined);
                return await fetchUpstream(req, next, channel, method, bodyBytes, config, redirects - 1);
            }
        }
        return response;
    } finally {
        clearTimeout(timer);
        req.signal.removeEventListener("abort", abort);
    }
}

async function handleMediaRelay(deps: RelayDeps, req: Request, ctx: RequestContext, target: URL, method: string): Promise<Response> {
    if (method !== "GET" && method !== "HEAD") throw new HttpError(403, "relay_target_not_allowed", "该地址不在管理员配置的渠道范围内");

    const client = getClientFromRequest(deps.db, deps.config.secret, req.headers.get("cookie"));
    if (!client) throw new HttpError(401, "session_required", "会话已失效，请刷新页面后重试");
    if (client.blocked) throw new HttpError(403, "client_blocked", "当前访问已被管理员封禁");
    if (!deps.relayLimiter.hit(client.id)) throw new HttpError(429, "rate_limited", "请求过于频繁，请稍后再试");

    const channels = listChannels(deps.db, deps.config.secret, { includeDisabled: true });
    const trustedChannel = channels.find((channel) => channel.enabled && new URL(channel.baseUrl).origin === target.origin);

    let current = target;
    let response: Response | null = null;
    for (let hop = 0; hop <= MEDIA_REDIRECT_LIMIT; hop += 1) {
        if (!trustedChannel) {
            if (current.protocol !== "https:") throw new HttpError(403, "relay_media_https_only", "媒体资源仅允许 https 地址");
            try {
                await assertPublicHost(current.hostname);
            } catch {
                throw new HttpError(403, "relay_media_blocked", "媒体地址不可访问");
            }
        }
        const mediaHeaders = new Headers({ "user-agent": req.headers.get("user-agent") || "infinite-canvas" });
        if (trustedChannel?.apiKey) {
            if (trustedChannel.apiFormat === "gemini") mediaHeaders.set("x-goog-api-key", trustedChannel.apiKey);
            else mediaHeaders.set("authorization", `Bearer ${trustedChannel.apiKey}`);
        }
        response = await fetch(current.toString(), {
            method,
            redirect: "manual",
            signal: AbortSignal.timeout(deps.config.mediaTimeoutMs),
            headers: mediaHeaders,
        });
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (!location) break;
            const next = new URL(location, current);
            await response.body?.cancel().catch(() => undefined);
            current = next;
            continue;
        }
        break;
    }
    if (!response) throw new HttpError(502, "media_unreachable", "媒体地址不可达");

    const headers = new Headers();
    for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value) headers.set(name, value);
    }
    if (response.status >= 200 && response.status < 300) {
        const contentType = (response.headers.get("content-type") || "").toLowerCase();
        const allowed = !contentType || /^(image|video|audio)\//.test(contentType) || /^application\/(octet-stream|pdf)/.test(contentType);
        if (!allowed) throw new HttpError(502, "media_type_rejected", "媒体地址返回了不支持的内容类型");
        const declaredLength = Number(response.headers.get("content-length") || "0");
        if (declaredLength > MEDIA_MAX_BYTES) throw new HttpError(502, "media_too_large", "媒体文件超过大小限制");
    }
    if (response.status === 204 || response.status === 304 || !response.body) return new Response(null, { status: response.status, headers });
    const limited = limitStream(response.body, MEDIA_MAX_BYTES);
    return new Response(req.method === "HEAD" ? null : limited, { status: response.status, headers });
}

function limitStream(body: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
    let total = 0;
    return body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                total += chunk.byteLength;
                if (total > maxBytes) {
                    controller.error(new Error("media_too_large"));
                    return;
                }
                controller.enqueue(chunk);
            },
        }),
    );
}

function quotaHeaderEntries(status: QuotaStatus, capability: Capability): Array<[string, string]> {
    const usage = status.capabilities[capability];
    return [
        [`x-quota-${capability}-daily-used`, String(usage.dailyUsed)],
        [`x-quota-${capability}-daily-limit`, String(usage.dailyLimit)],
        [`x-quota-${capability}-weekly-used`, String(usage.weeklyUsed)],
        [`x-quota-${capability}-weekly-limit`, String(usage.weeklyLimit)],
        ["x-quota-daily-reset-at", status.dailyResetAt],
        ["x-quota-weekly-reset-at", status.weeklyResetAt],
    ];
}

function quotaExceededResponse(deps: RelayDeps, policy: QuotaPolicy, client: ClientRecord, capability: Capability, failure: ReserveFailure): Response {
    const status = quotaStatusFor(deps.db, policy, client);
    const usage = status.capabilities[capability];
    const used = failure.scope === "daily" ? usage.dailyUsed : usage.weeklyUsed;
    const limit = failure.scope === "daily" ? usage.dailyLimit : usage.weeklyLimit;
    const resetAt = failure.scope === "daily" ? status.dailyResetAt : status.weeklyResetAt;
    const label = CAPABILITY_LABELS[capability];
    const windowLabel = failure.scope === "daily" ? "今日" : "本周";
    const message = `${windowLabel}${label}额度已用完（${used}/${limit}），将于 ${resetAt} 重置`;
    const headers = new Headers();
    for (const [name, value] of quotaHeaderEntries(status, capability)) headers.set(name, value);
    return errorResponse(
        429,
        "quota_exceeded",
        message,
        {
            scope: failure.scope,
            capability,
            dimension: failure.dimension,
            quota: {
                ...usage,
                dailyResetAt: status.dailyResetAt,
                weeklyResetAt: status.weeklyResetAt,
            },
        },
        headers,
    );
}
