import type { Database } from "bun:sqlite";

import { loadPublicSettings, loadSystemSettings, savePublicSettings, saveSystemSettings, type SystemSettings } from "./admin-settings";
import { listChannels, maskedChannels, resolveDefaultModels, saveChannels, saveDefaultModels, type ChannelInput } from "./channels";
import type { ServerConfig } from "./config";
import { nowMs } from "./clock";
import { getSetting, setSetting } from "./db";
import { HttpError, assertSameOrigin, isSecureRequest, jsonResponse, parseCookies, readJsonBody, serializeCookie, type RequestContext, type Router } from "./http";
import { findClientById, listClientIps, setClientBlocked, type ClientRow } from "./identity";
import { log } from "./logger";
import { cleanupUsageEvents, isoWithOffset, quotaStatusFor, resetUsage, saveQuotaPolicy, startOfDay, startOfWeek, usageSince, usageTotals } from "./quota";
import { hashPassword, normalizeBaseUrl, randomToken, RateLimiter, rewriteHostForDocker, sha256, signValue, verifyPassword, verifySignedValue } from "./security";
import type { Capability, CapabilityLimits, QuotaPolicy } from "./types";
import { CAPABILITIES } from "./types";

export const ADMIN_COOKIE = "ic_admin";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_REFRESH_MS = 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const MAX_LIMIT = 1_000_000;

export type AdminDeps = {
    db: Database;
    config: ServerConfig;
    getQuotaPolicy: () => QuotaPolicy;
    setQuotaPolicy: (policy: QuotaPolicy) => void;
};

type SessionRow = {
    token_hash: string;
    ip: string;
    user_agent: string;
    created_at: number;
    last_seen_at: number;
    expires_at: number;
};

export function getAdminSession(db: Database, secret: string, req: Request): { session: SessionRow; token: string } | null {
    const raw = parseCookies(req.headers.get("cookie"))[ADMIN_COOKIE];
    if (!raw) return null;
    const token = verifySignedValue(secret, raw);
    if (!token) return null;
    const tokenHash = sha256(token);
    const session = db.query("SELECT * FROM admin_sessions WHERE token_hash = ?").get(tokenHash) as SessionRow | null;
    if (!session) return null;
    const now = nowMs();
    if (session.expires_at <= now) {
        db.query("DELETE FROM admin_sessions WHERE token_hash = ?").run(tokenHash);
        return null;
    }
    if (now - session.last_seen_at > SESSION_REFRESH_MS) {
        const expiresAt = now + SESSION_TTL_MS;
        db.query("UPDATE admin_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?").run(now, expiresAt, tokenHash);
        session.last_seen_at = now;
        session.expires_at = expiresAt;
    }
    return { session, token };
}

export function checkAdminSession(db: Database, secret: string, req: Request): boolean {
    return Boolean(getAdminSession(db, secret, req));
}

function randomPassword(length: number): string {
    return randomToken(32).replace(/[^A-Za-z0-9]/g, "").slice(0, length);
}

/** 首次启动初始化管理员账号；ADMIN_PASSWORD 未提供时生成随机密码。 */
export async function ensureAdminAccount(db: Database, config: ServerConfig): Promise<{ username: string; generatedPassword: string | null }> {
    const existingHash = getSetting(db, "admin_password_hash");
    if (existingHash) {
        return { username: getSetting(db, "admin_username") || config.adminUsername, generatedPassword: null };
    }
    const username = config.adminUsername;
    const generatedPassword = config.adminPassword ? null : randomPassword(16);
    const password = config.adminPassword ?? (generatedPassword as string);
    const hash = await hashPassword(password);
    setSetting(db, "admin_username", username);
    setSetting(db, "admin_password_hash", hash);
    setSetting(db, "admin_password_updated_at", String(nowMs()));
    return { username, generatedPassword };
}

function audit(db: Database, action: string, detail: unknown, ip: string) {
    db.query("INSERT INTO audit_logs (actor, action, detail, ip, created_at) VALUES ('admin', ?, ?, ?, ?)").run(action, JSON.stringify(detail ?? {}), ip, nowMs());
}

function toLimit(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return Math.min(MAX_LIMIT, Math.floor(parsed));
}

function normalizePolicyInput(raw: unknown, current: QuotaPolicy): QuotaPolicy {
    const input = (raw ?? {}) as Partial<QuotaPolicy>;
    const capabilities = { ...current.capabilities } as Record<Capability, CapabilityLimits>;
    for (const capability of CAPABILITIES) {
        const limits = input.capabilities?.[capability];
        if (!limits) continue;
        capabilities[capability] = {
            daily: toLimit(limits.daily, capabilities[capability].daily),
            weekly: toLimit(limits.weekly, capabilities[capability].weekly),
            ipDaily: toLimit(limits.ipDaily, capabilities[capability].ipDaily),
            ipWeekly: toLimit(limits.ipWeekly, capabilities[capability].ipWeekly),
        };
    }
    const timezone = typeof input.timezone === "string" && input.timezone.trim() ? input.timezone.trim() : current.timezone;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
        throw new HttpError(400, "invalid_timezone", "时区不合法");
    }
    return {
        timezone,
        capabilities,
        adminExempt: typeof input.adminExempt === "boolean" ? input.adminExempt : current.adminExempt,
        refundOnFailure: typeof input.refundOnFailure === "boolean" ? input.refundOnFailure : current.refundOnFailure,
    };
}

function parseCapability(value: unknown): Capability | null {
    return CAPABILITIES.includes(value as Capability) ? (value as Capability) : null;
}

function parseScope(value: unknown): "daily" | "weekly" | "all" {
    return value === "weekly" ? "weekly" : value === "all" ? "all" : "daily";
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
    if (value === null || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
}

async function fetchChannelModels(baseUrl: string, apiKey: string, apiFormat: string, runningInDocker: boolean): Promise<string[]> {
    const base = normalizeBaseUrl(rewriteHostForDocker(baseUrl, runningInDocker));
    const headers = new Headers();
    let url: string;
    if (apiFormat === "gemini") {
        url = /\/v1beta$/i.test(base) ? `${base}/models` : `${base}/v1beta/models`;
        headers.set("x-goog-api-key", apiKey);
    } else {
        url = /\/v1$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
        headers.set("authorization", `Bearer ${apiKey}`);
    }
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    if (!response.ok) throw new HttpError(400, "channel_test_failed", `上游返回 ${response.status}：${text.slice(0, 200)}`);
    let data: Record<string, unknown> | null = null;
    try {
        data = JSON.parse(text) as Record<string, unknown>;
    } catch {
        data = null;
    }
    if (!data || typeof data !== "object") {
        throw new HttpError(
            400,
            "channel_test_failed",
            `上游返回的不是 JSON 模型列表（HTTP ${response.status}）。若服务端运行在 Docker 内，Base URL 中的 localhost/127.0.0.1 指向容器自身，访问宿主机服务请使用 http://host.docker.internal:<端口>（新版服务端会自动改写）。`,
        );
    }
    const rows = Array.isArray(data.data) ? (data.data as Array<Record<string, unknown>>) : Array.isArray(data.models) ? (data.models as Array<Record<string, unknown>>) : null;
    if (!rows) throw new HttpError(400, "channel_test_failed", `上游响应缺少 data/models 数组：${text.slice(0, 200)}`);
    const models = rows
        .map((row) => (typeof row.id === "string" ? row.id : typeof row.name === "string" ? row.name.replace(/^models\//, "") : ""))
        .filter((name) => Boolean(name));
    if (!models.length) {
        throw new HttpError(400, "channel_test_failed", "上游返回空模型列表，请检查 Base URL 与 API Key；Docker 内访问宿主机服务请使用 host.docker.internal。");
    }
    return models;
}

export function registerAdminRoutes(router: Router, deps: AdminDeps) {
    const loginMinute = new RateLimiter(5, 60_000);
    const loginHour = new RateLimiter(10, 3_600_000);

    const requireAdmin = (req: Request) => {
        const result = getAdminSession(deps.db, deps.config.secret, req);
        if (!result) throw new HttpError(401, "admin_required", "需要管理员登录");
        return result;
    };
    const verifyWrite = (req: Request) => {
        const result = requireAdmin(req);
        assertSameOrigin(req);
        return result;
    };

    router.post("/api/admin/login", async (req, ctx) => {
        assertSameOrigin(req);
        const ipKey = `login:${ctx.ip}`;
        if (!loginMinute.hit(ipKey) || !loginHour.hit(ipKey)) throw new HttpError(429, "login_rate_limited", "登录尝试过于频繁，请稍后再试");
        const body = await readJsonBody<{ username?: string; password?: string }>(req, 16 * 1024);
        const username = (body.username || "").trim();
        const password = body.password || "";
        const storedUsername = getSetting(deps.db, "admin_username") || deps.config.adminUsername;
        const storedHash = getSetting(deps.db, "admin_password_hash") || "";
        const ok = Boolean(storedHash) && username === storedUsername && (await verifyPassword(password, storedHash));
        deps.db.query("INSERT INTO admin_login_attempts (ip, success, created_at) VALUES (?, ?, ?)").run(ctx.ip, ok ? 1 : 0, nowMs());
        if (!ok) {
            audit(deps.db, "login.failed", { username }, ctx.ip);
            throw new HttpError(401, "invalid_credentials", "账号或密码错误");
        }
        loginMinute.reset(ipKey);
        loginHour.reset(ipKey);
        const token = randomToken(32);
        const now = nowMs();
        deps.db.query("INSERT INTO admin_sessions (token_hash, ip, user_agent, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(
            sha256(token),
            ctx.ip,
            req.headers.get("user-agent")?.slice(0, 300) || "",
            now,
            now,
            now + SESSION_TTL_MS,
        );
        audit(deps.db, "login.success", {}, ctx.ip);
        const cookie = serializeCookie(ADMIN_COOKIE, signValue(deps.config.secret, token), {
            maxAgeSeconds: SESSION_TTL_MS / 1000,
            httpOnly: true,
            sameSite: "Strict",
            secure: isSecureRequest(req),
        });
        return jsonResponse({ ok: true }, 200, { "set-cookie": cookie });
    });

    router.post("/api/admin/logout", (req) => {
        const raw = parseCookies(req.headers.get("cookie"))[ADMIN_COOKIE];
        const token = raw ? verifySignedValue(deps.config.secret, raw) : null;
        if (token) deps.db.query("DELETE FROM admin_sessions WHERE token_hash = ?").run(sha256(token));
        const cookie = serializeCookie(ADMIN_COOKIE, "", { maxAgeSeconds: 0, httpOnly: true, sameSite: "Strict", secure: isSecureRequest(req) });
        return jsonResponse({ ok: true }, 200, { "set-cookie": cookie });
    });

    router.get("/api/admin/session", (req) => {
        const { session } = requireAdmin(req);
        return jsonResponse({
            admin: true,
            username: getSetting(deps.db, "admin_username") || deps.config.adminUsername,
            expiresAt: session.expires_at,
        });
    });

    router.get("/api/admin/overview", (req) => {
        requireAdmin(req);
        const policy = deps.getQuotaPolicy();
        const now = nowMs();
        const dayStart = startOfDay(now, policy.timezone);
        const weekStart = startOfWeek(now, policy.timezone);
        const channelList = listChannels(deps.db, deps.config.secret, { includeDisabled: true });
        const clientsTotal = Number((deps.db.query("SELECT COUNT(*) AS total FROM clients").get() as { total: number }).total);
        const activeToday = Number((deps.db.query("SELECT COUNT(*) AS total FROM clients WHERE last_seen_at >= ?").get(dayStart) as { total: number }).total);
        deps.db.query("DELETE FROM admin_login_attempts WHERE created_at < ?").run(now - 7 * DAY);
        return jsonResponse({
            version: deps.config.version,
            uptimeSeconds: Math.round(process.uptime()),
            channels: { total: channelList.length, enabled: channelList.filter((channel) => channel.enabled).length },
            clients: { total: clientsTotal, activeToday },
            usage: {
                today: usageTotals(deps.db, dayStart, now + 1),
                week: usageTotals(deps.db, weekStart, now + 1),
            },
            resets: {
                daily: isoWithOffset(startOfDay(now + DAY, policy.timezone), policy.timezone),
                weekly: policy.timezone,
            },
        });
    });

    router.get("/api/admin/channels", (req) => {
        requireAdmin(req);
        const channels = listChannels(deps.db, deps.config.secret, { includeDisabled: true });
        return jsonResponse({ channels: maskedChannels(channels), defaultModels: resolveDefaultModels(deps.db, channels) });
    });

    router.put("/api/admin/channels", async (req, ctx) => {
        verifyWrite(req);
        const body = await readJsonBody<{ channels?: ChannelInput[]; defaultModels?: Partial<Record<Capability, string>> }>(req, 4 * 1024 * 1024);
        if (!Array.isArray(body.channels)) throw new HttpError(400, "invalid_channels", "channels 必须是数组");
        try {
            saveChannels(deps.db, deps.config.secret, body.channels, { runningInDocker: deps.config.runningInDocker });
        } catch (error) {
            const message = error instanceof Error ? error.message : "保存渠道失败";
            throw new HttpError(400, "invalid_channels", message);
        }
        if (body.defaultModels && typeof body.defaultModels === "object") saveDefaultModels(deps.db, body.defaultModels);
        audit(deps.db, "channels.update", { count: body.channels.length }, ctx.ip);
        const channels = listChannels(deps.db, deps.config.secret, { includeDisabled: true });
        return jsonResponse({ ok: true, channels: maskedChannels(channels), defaultModels: resolveDefaultModels(deps.db, channels) });
    });

    router.post("/api/admin/channels/test", async (req) => {
        verifyWrite(req);
        const body = await readJsonBody<{ baseUrl?: string; apiKey?: string; apiFormat?: string; channelId?: string }>(req, 64 * 1024);
        let { baseUrl, apiKey, apiFormat } = body;
        if (body.channelId) {
            const existing = listChannels(deps.db, deps.config.secret, { includeDisabled: true }).find((channel) => channel.id === body.channelId);
            if (existing) {
                baseUrl = baseUrl || existing.baseUrl;
                apiKey = apiKey || existing.apiKey;
                apiFormat = apiFormat || existing.apiFormat;
            }
        }
        if (!baseUrl || !apiKey) throw new HttpError(400, "channel_test_missing", "缺少 Base URL 或 API Key");
        const models = await fetchChannelModels(baseUrl, apiKey, apiFormat || "openai", deps.config.runningInDocker);
        return jsonResponse({ ok: true, models });
    });

    router.get("/api/admin/quota-policy", (req) => {
        requireAdmin(req);
        return jsonResponse({ policy: deps.getQuotaPolicy() });
    });

    router.put("/api/admin/quota-policy", async (req, ctx) => {
        verifyWrite(req);
        const body = await readJsonBody<{ policy?: unknown }>(req, 64 * 1024);
        const next = normalizePolicyInput(body.policy, deps.getQuotaPolicy());
        saveQuotaPolicy(deps.db, next);
        deps.setQuotaPolicy(next);
        audit(deps.db, "quota_policy.update", next, ctx.ip);
        return jsonResponse({ ok: true, policy: next });
    });

    router.get("/api/admin/usage", (req, ctx) => {
        requireAdmin(req);
        const days = clampInt(ctx.url.searchParams.get("days"), 7, 1, 90);
        const policy = deps.getQuotaPolicy();
        const timezone = policy.timezone;
        const now = nowMs();
        const todayStart = startOfDay(now, timezone);
        const daily: Array<{ date: string; label: string; capabilities: Record<string, { units: number; requests: number }> }> = [];
        for (let index = days - 1; index >= 0; index -= 1) {
            const from = startOfDay(todayStart - index * DAY, timezone);
            const to = index === 0 ? now + 1 : startOfDay(todayStart - (index - 1) * DAY, timezone);
            const capabilities: Record<string, { units: number; requests: number }> = {};
            for (const row of usageTotals(deps.db, from, to)) capabilities[row.capability] = { units: row.units, requests: row.requests };
            daily.push({ date: isoWithOffset(from, timezone).slice(0, 10), label: isoWithOffset(from, timezone).slice(0, 10), capabilities });
        }
        const rangeStart = startOfDay(todayStart - (days - 1) * DAY, timezone);
        const recent = deps.db.query("SELECT * FROM usage_events ORDER BY created_at DESC LIMIT 30").all();
        return jsonResponse({ days, totals: usageTotals(deps.db, rangeStart, now + 1), daily, recent });
    });

    router.get("/api/admin/clients", (req, ctx) => {
        requireAdmin(req);
        const query = (ctx.url.searchParams.get("q") || "").trim().slice(0, 100);
        const page = clampInt(ctx.url.searchParams.get("page"), 1, 1, 10_000);
        const pageSize = clampInt(ctx.url.searchParams.get("pageSize"), 20, 5, 100);
        const policy = deps.getQuotaPolicy();
        const now = nowMs();
        const dayStart = startOfDay(now, policy.timezone);
        const weekStart = startOfWeek(now, policy.timezone);
        let where = "";
        const params: Array<string | number> = [];
        if (query) {
            where = "WHERE id LIKE ? OR fingerprint LIKE ? OR last_ip LIKE ? OR user_agent LIKE ?";
            const like = `%${query}%`;
            params.push(like, like, like, like);
        }
        const total = Number((deps.db.query(`SELECT COUNT(*) AS total FROM clients ${where}`).get(...params) as { total: number }).total);
        const rows = deps.db.query(`SELECT * FROM clients ${where} ORDER BY last_seen_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as ClientRow[];
        const items = rows.map((row) => {
            const ipCount = Number((deps.db.query("SELECT COUNT(*) AS total FROM client_ips WHERE client_id = ?").get(row.id) as { total: number }).total);
            return {
                id: row.id,
                fingerprint: row.fingerprint,
                fingerprintSource: row.fingerprint_source,
                userAgent: row.user_agent,
                firstIp: row.first_ip,
                lastIp: row.last_ip,
                firstSeenAt: row.first_seen_at,
                lastSeenAt: row.last_seen_at,
                blocked: row.blocked === 1,
                ipCount,
                usage: {
                    today: usageSince(deps.db, "client_id", row.id, dayStart),
                    week: usageSince(deps.db, "client_id", row.id, weekStart),
                },
            };
        });
        return jsonResponse({ page, pageSize, total, items });
    });

    router.get("/api/admin/clients/:id", (req, ctx) => {
        requireAdmin(req);
        const client = findClientById(deps.db, ctx.params.id);
        if (!client) throw new HttpError(404, "client_not_found", "访客不存在");
        const policy = deps.getQuotaPolicy();
        return jsonResponse({
            client,
            quota: quotaStatusFor(deps.db, policy, client),
            ips: listClientIps(deps.db, ctx.params.id),
            events: deps.db.query("SELECT * FROM usage_events WHERE client_id = ? ORDER BY created_at DESC LIMIT 100").all(ctx.params.id),
        });
    });

    router.post("/api/admin/clients/:id/reset-quota", async (req, ctx) => {
        verifyWrite(req);
        const client = findClientById(deps.db, ctx.params.id);
        if (!client) throw new HttpError(404, "client_not_found", "访客不存在");
        const body = await readJsonBody<{ scope?: string; capability?: string }>(req, 16 * 1024);
        const scope = parseScope(body.scope);
        const capability = parseCapability(body.capability);
        const policy = deps.getQuotaPolicy();
        let changes = 0;
        if (scope === "daily" || scope === "all") changes += resetUsage(deps.db, policy, { kind: "client", id: client.id }, "daily", capability);
        if (scope === "weekly" || scope === "all") changes += resetUsage(deps.db, policy, { kind: "client", id: client.id }, "weekly", capability);
        audit(deps.db, "client.reset_quota", { clientId: client.id, scope, capability }, ctx.ip);
        return jsonResponse({ ok: true, changes, quota: quotaStatusFor(deps.db, deps.getQuotaPolicy(), client) });
    });

    router.post("/api/admin/clients/:id/block", async (req, ctx) => {
        verifyWrite(req);
        const client = findClientById(deps.db, ctx.params.id);
        if (!client) throw new HttpError(404, "client_not_found", "访客不存在");
        const body = await readJsonBody<{ blocked?: boolean }>(req, 16 * 1024);
        const blocked = Boolean(body.blocked);
        setClientBlocked(deps.db, client.id, blocked);
        audit(deps.db, blocked ? "client.block" : "client.unblock", { clientId: client.id }, ctx.ip);
        return jsonResponse({ ok: true, blocked });
    });

    router.post("/api/admin/quota/reset-all", async (req, ctx) => {
        verifyWrite(req);
        const body = await readJsonBody<{ scope?: string; capability?: string }>(req, 16 * 1024);
        const scope = parseScope(body.scope);
        const capability = parseCapability(body.capability);
        const policy = deps.getQuotaPolicy();
        let changes = 0;
        if (scope === "daily" || scope === "all") changes += resetUsage(deps.db, policy, { kind: "all" }, "daily", capability);
        if (scope === "weekly" || scope === "all") changes += resetUsage(deps.db, policy, { kind: "all" }, "weekly", capability);
        audit(deps.db, "quota.reset_all", { scope, capability }, ctx.ip);
        return jsonResponse({ ok: true, changes });
    });

    router.get("/api/admin/settings", (req) => {
        requireAdmin(req);
        const channels = listChannels(deps.db, deps.config.secret, { includeDisabled: true });
        return jsonResponse({
            publicSettings: loadPublicSettings(deps.db),
            systemSettings: loadSystemSettings(deps.db),
            defaultModels: resolveDefaultModels(deps.db, channels),
            server: { version: deps.config.version, uptimeSeconds: Math.round(process.uptime()) },
        });
    });

    router.put("/api/admin/settings", async (req, ctx) => {
        verifyWrite(req);
        const body = await readJsonBody<{ publicSettings?: Record<string, unknown>; systemSettings?: Partial<SystemSettings>; defaultModels?: Partial<Record<Capability, string>> }>(req, 64 * 1024);
        if (body.publicSettings) savePublicSettings(deps.db, body.publicSettings);
        if (body.systemSettings) saveSystemSettings(deps.db, body.systemSettings);
        if (body.defaultModels) saveDefaultModels(deps.db, body.defaultModels);
        audit(deps.db, "settings.update", { publicSettings: body.publicSettings, systemSettings: body.systemSettings }, ctx.ip);
        const channels = listChannels(deps.db, deps.config.secret, { includeDisabled: true });
        return jsonResponse({
            ok: true,
            publicSettings: loadPublicSettings(deps.db),
            systemSettings: loadSystemSettings(deps.db),
            defaultModels: resolveDefaultModels(deps.db, channels),
        });
    });

    router.post("/api/admin/password", async (req, ctx) => {
        const { session } = verifyWrite(req);
        const body = await readJsonBody<{ oldPassword?: string; newPassword?: string }>(req, 16 * 1024);
        const oldPassword = body.oldPassword || "";
        const newPassword = body.newPassword || "";
        if (newPassword.length < 8) throw new HttpError(400, "weak_password", "新密码至少 8 位");
        const currentHash = getSetting(deps.db, "admin_password_hash") || "";
        if (!(await verifyPassword(oldPassword, currentHash))) throw new HttpError(401, "invalid_credentials", "当前密码错误");
        setSetting(deps.db, "admin_password_hash", await hashPassword(newPassword));
        setSetting(deps.db, "admin_password_updated_at", String(nowMs()));
        deps.db.query("DELETE FROM admin_sessions").run();
        const token = randomToken(32);
        const now = nowMs();
        deps.db.query("INSERT INTO admin_sessions (token_hash, ip, user_agent, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(
            sha256(token),
            session.ip,
            session.user_agent,
            now,
            now,
            now + SESSION_TTL_MS,
        );
        audit(deps.db, "password.update", {}, ctx.ip);
        const cookie = serializeCookie(ADMIN_COOKIE, signValue(deps.config.secret, token), {
            maxAgeSeconds: SESSION_TTL_MS / 1000,
            httpOnly: true,
            sameSite: "Strict",
            secure: isSecureRequest(req),
        });
        return jsonResponse({ ok: true }, 200, { "set-cookie": cookie });
    });

    log.info("admin routes registered");
}

export function runRetentionCleanup(db: Database, retentionDays: number) {
    try {
        const deleted = cleanupUsageEvents(db, retentionDays);
        if (deleted > 0) log.info("usage retention cleanup", { deleted, retentionDays });
    } catch (error) {
        log.warn("usage retention cleanup failed", { message: error instanceof Error ? error.message : String(error) });
    }
}
