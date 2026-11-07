import type { ServerConfig } from "./config";

export class HttpError extends Error {
    status: number;
    code: string;
    extra?: Record<string, unknown>;

    constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
        super(message);
        this.name = "HttpError";
        this.status = status;
        this.code = code;
        this.extra = extra;
    }
}

export type RequestContext = {
    url: URL;
    params: Record<string, string>;
    config: ServerConfig;
    ip: string;
};

export type Handler = (req: Request, ctx: RequestContext) => Promise<Response> | Response;

type RouteDef = { method: string; segments: string[]; handler: Handler };

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
    if (pattern.length !== actual.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < pattern.length; i += 1) {
        const expected = pattern[i];
        const value = actual[i];
        if (expected.startsWith(":")) {
            params[expected.slice(1)] = decodeURIComponent(value);
            continue;
        }
        if (expected !== value) return null;
    }
    return params;
}

export class Router {
    private routes: RouteDef[] = [];

    constructor(private config: ServerConfig) {}

    private add(method: string, pattern: string, handler: Handler) {
        this.routes.push({ method, segments: pattern.split("/").filter(Boolean), handler });
    }

    get(pattern: string, handler: Handler) {
        this.add("GET", pattern, handler);
    }

    post(pattern: string, handler: Handler) {
        this.add("POST", pattern, handler);
    }

    put(pattern: string, handler: Handler) {
        this.add("PUT", pattern, handler);
    }

    any(pattern: string, handler: Handler) {
        this.add("*", pattern, handler);
    }

    async handle(req: Request, socketIp: string): Promise<Response | null> {
        const url = new URL(req.url);
        const segments = url.pathname.split("/").filter(Boolean);
        for (const route of this.routes) {
            if (route.method !== "*" && route.method !== req.method) continue;
            const params = matchSegments(route.segments, segments);
            if (!params) continue;
            const ctx: RequestContext = { url, params, config: this.config, ip: resolveClientIp(req, socketIp, this.config.trustProxy) };
            return route.handler(req, ctx);
        }
        return null;
    }
}

/** 默认使用 TCP 对端 IP；TRUST_PROXY=1 时取 X-Forwarded-For 最右侧条目（由最近的反代写入）。 */
function normalizeIp(value: string): string {
    const trimmed = value.trim();
    return trimmed.startsWith("::ffff:") ? trimmed.slice("::ffff:".length) : trimmed;
}

export function resolveClientIp(req: Request, socketIp: string, trustProxy: boolean): string {
    if (trustProxy) {
        const header = req.headers.get("x-forwarded-for");
        if (header) {
            const parts = header.split(",").map((part) => part.trim()).filter(Boolean);
            const candidate = parts[parts.length - 1];
            if (candidate && candidate.length <= 64) return normalizeIp(candidate);
        }
    }
    return normalizeIp(socketIp) || "unknown";
}

export function jsonResponse(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
    const headers = new Headers(extraHeaders);
    headers.set("content-type", "application/json; charset=utf-8");
    headers.set("cache-control", "no-store");
    return new Response(JSON.stringify(data), { status, headers });
}

export function errorResponse(status: number, code: string, message: string, extra?: Record<string, unknown>, extraHeaders?: HeadersInit): Response {
    return jsonResponse({ error: { message }, code, ...(extra || {}) }, status, extraHeaders);
}

export function httpErrorToResponse(error: HttpError): Response {
    return errorResponse(error.status, error.code, error.message, error.extra);
}

export async function readBody(req: Request, maxBytes: number): Promise<Uint8Array> {
    const declared = Number(req.headers.get("content-length") || "0");
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw new HttpError(413, "payload_too_large", `请求体超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`);
    }
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
        throw new HttpError(413, "payload_too_large", `请求体超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`);
    }
    return bytes;
}

export function parseCookies(header: string | null): Record<string, string> {
    const result: Record<string, string> = {};
    if (!header) return result;
    for (const chunk of header.split(";")) {
        const index = chunk.indexOf("=");
        if (index <= 0) continue;
        const name = chunk.slice(0, index).trim();
        const value = chunk.slice(index + 1).trim();
        if (!name) continue;
        try {
            result[name] = decodeURIComponent(value);
        } catch {
            result[name] = value;
        }
    }
    return result;
}

export type CookieOptions = {
    maxAgeSeconds?: number;
    httpOnly?: boolean;
    sameSite?: "Lax" | "Strict" | "None";
    secure?: boolean;
    path?: string;
};

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    parts.push(`Path=${options.path || "/"}`);
    if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAgeSeconds)}`);
    if (options.httpOnly !== false) parts.push("HttpOnly");
    parts.push(`SameSite=${options.sameSite || "Lax"}`);
    if (options.secure) parts.push("Secure");
    return parts.join("; ");
}

export function isSecureRequest(req: Request): boolean {
    if (new URL(req.url).protocol === "https:") return true;
    const forwarded = req.headers.get("x-forwarded-proto");
    return forwarded?.split(",")[0]?.trim() === "https";
}

/** 同源校验：Origin/Referer 存在时必须与当前站点主机一致；兼容反向代理与 NAT 端口映射。 */
export function assertSameOrigin(req: Request) {
    const origin = req.headers.get("origin");
    const referer = req.headers.get("referer");
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
    if (!host) return;
    const hostHostname = host.split(":")[0];
    const candidates = [origin, referer].filter(Boolean) as string[];
    for (const candidate of candidates) {
        try {
            const parsed = new URL(candidate);
            if (parsed.host !== host && parsed.hostname !== hostHostname) {
                throw new HttpError(403, "cross_origin_denied", "跨站请求被拒绝");
            }
        } catch (error) {
            if (error instanceof HttpError) throw error;
        }
    }
}

export async function readJsonBody<T = Record<string, unknown>>(req: Request, maxBytes = 256 * 1024): Promise<T> {
    const bytes = await readBody(req, maxBytes);
    if (bytes.byteLength === 0) return {} as T;
    try {
        return JSON.parse(new TextDecoder().decode(bytes)) as T;
    } catch {
        throw new HttpError(400, "invalid_json", "请求体不是合法 JSON");
    }
}
