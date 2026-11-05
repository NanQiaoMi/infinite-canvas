import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { ensureAdminAccount } from "../src/admin";
import { createApp, type App } from "../src/app";
import { setNowForTests } from "../src/clock";
import { openStore } from "../src/db";
import { createTestConfig } from "./helpers";

type UpstreamServer = ReturnType<typeof Bun.serve>;
type TestCtx = {
    app: App;
    db: ReturnType<typeof openStore>["db"];
    config: ReturnType<typeof createTestConfig>["config"];
    cleanup: () => void;
};

let upstream: UpstreamServer;
let upstreamBase = "";
const upstreamCalls: Array<{ path: string; authorization: string | null }> = [];

beforeAll(() => {
    upstream = Bun.serve({
        port: 0,
        fetch(req) {
            const url = new URL(req.url);
            upstreamCalls.push({ path: url.pathname, authorization: req.headers.get("authorization") });
            if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "img-1" }, { id: "txt-1" }] });
            return Response.json({ created: 1, data: [{ b64_json: "QUJD" }] });
        },
    });
    upstreamBase = `http://127.0.0.1:${upstream.port}`;
});

afterAll(() => {
    upstream.stop(true);
});

afterEach(() => {
    setNowForTests(null);
});

async function setup(): Promise<TestCtx> {
    const { config, cleanup } = createTestConfig();
    const store = openStore(config.dbPath, config.schemaPath);
    await ensureAdminAccount(store.db, config);
    const app = createApp(config, store.db);
    return { app, db: store.db, config, cleanup };
}

function request(ctx: TestCtx, path: string, init: RequestInit = {}): Promise<Response> {
    return ctx.app.fetch(new Request(`http://localhost${path}`, init), "127.0.0.1");
}

async function adminLogin(ctx: TestCtx): Promise<string> {
    const response = await request(ctx, "/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "test-password-123" }),
    });
    expect(response.status).toBe(200);
    return (response.headers.get("set-cookie") || "").split(";")[0] || "";
}

async function configureChannel(ctx: TestCtx, adminCookie: string): Promise<void> {
    const response = await request(ctx, "/api/admin/channels", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: adminCookie },
        body: JSON.stringify({
            channels: [
                {
                    id: "ch1",
                    name: "mock",
                    baseUrl: upstreamBase,
                    apiKey: "sk-test-key",
                    apiFormat: "openai",
                    models: [
                        { name: "img-1", capability: "image" },
                        { name: "txt-1", capability: "text" },
                    ],
                },
            ],
        }),
    });
    expect(response.status).toBe(200);
}

async function createSession(ctx: TestCtx): Promise<{ cookie: string; clientId: string }> {
    const response = await request(ctx, "/api/session/fingerprint", {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "bun-test-agent" },
        body: JSON.stringify({ visitorId: "visitor-xyz-123456", source: "builtin" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { clientId: string };
    const cookie = (response.headers.get("set-cookie") || "").split(";")[0] || "";
    expect(cookie).toContain("ic_client=");
    return { cookie, clientId: body.clientId };
}

function relayImage(ctx: TestCtx, clientCookie: string, body: Record<string, unknown> = { model: "img-1", prompt: "hello", n: 1 }): Promise<Response> {
    const target = `${upstreamBase}/v1/images/generations`;
    return request(ctx, `/api/relay?url=${encodeURIComponent(target)}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: clientCookie },
        body: JSON.stringify(body),
    });
}

async function updateQuotaPolicy(ctx: TestCtx, adminCookie: string, imageDaily: number, imageWeekly: number): Promise<void> {
    const response = await request(ctx, "/api/admin/quota-policy", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: adminCookie },
        body: JSON.stringify({ policy: { capabilities: { image: { daily: imageDaily, weekly: imageWeekly } } } }),
    });
    expect(response.status).toBe(200);
}

describe("公共接口", () => {
    test("health 与 bootstrap 返回默认额度", async () => {
        const ctx = await setup();
        const health = await request(ctx, "/api/health");
        expect(health.status).toBe(200);
        const bootstrap = await request(ctx, "/api/bootstrap");
        expect(bootstrap.status).toBe(200);
        const data = (await bootstrap.json()) as any;
        expect(data.serverMode).toBe(true);
        expect(data.quotaPolicy.capabilities.image).toEqual({ daily: 100, weekly: 700 });
        expect(data.quotaPolicy.capabilities.text).toEqual({ daily: 0, weekly: 0 });
        expect(Array.isArray(data.channels)).toBe(true);
        ctx.cleanup();
    });

    test("静态页面在缺少 web/dist 时返回 503（有产物时返回 200）", async () => {
        const ctx = await setup();
        const response = await request(ctx, "/");
        expect([200, 503]).toContain(response.status);
        ctx.cleanup();
    });
});

describe("管理员鉴权与渠道配置", () => {
    test("未登录访问管理接口返回 401", async () => {
        const ctx = await setup();
        const response = await request(ctx, "/api/admin/clients");
        expect(response.status).toBe(401);
        const data = (await response.json()) as any;
        expect(data.code).toBe("admin_required");
        ctx.cleanup();
    });

    test("错误密码登录被拒绝，正确密码可登录", async () => {
        const ctx = await setup();
        const bad = await request(ctx, "/api/admin/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ username: "admin", password: "wrong-password" }),
        });
        expect(bad.status).toBe(401);
        const cookie = await adminLogin(ctx);
        expect(cookie).toContain("ic_admin=");
        const session = await request(ctx, "/api/admin/session", { headers: { cookie } });
        expect(session.status).toBe(200);
        ctx.cleanup();
    });

    test("管理员配置渠道后 bootstrap 对外暴露模型但不泄露 Key", async () => {
        const ctx = await setup();
        const adminCookie = await adminLogin(ctx);
        await configureChannel(ctx, adminCookie);
        const bootstrap = await request(ctx, "/api/bootstrap");
        const text = JSON.stringify(await bootstrap.json());
        expect(text).toContain("ch1");
        expect(text).toContain("img-1");
        expect(text).not.toContain("sk-test-key");
        ctx.cleanup();
    });

    test("默认模型只接受能力匹配的模型", async () => {
        const ctx = await setup();
        const adminCookie = await adminLogin(ctx);
        await configureChannel(ctx, adminCookie);
        const response = await request(ctx, "/api/admin/channels", {
            method: "PUT",
            headers: { "content-type": "application/json", cookie: adminCookie },
            body: JSON.stringify({
                channels: [
                    {
                        id: "ch1",
                        name: "mock",
                        baseUrl: upstreamBase,
                        apiFormat: "openai",
                        apiKey: "sk-test-key",
                        models: [
                            { name: "img-1", capability: "image" },
                            { name: "txt-1", capability: "text" },
                        ],
                    },
                ],
                defaultModels: { image: "ch1::txt-1", text: "ch1::img-1" },
            }),
        });
        expect(response.status).toBe(200);
        const data = (await response.json()) as any;
        expect(data.defaultModels.image).toBe("ch1::img-1");
        expect(data.defaultModels.text).toBe("ch1::txt-1");
        ctx.cleanup();
    });

    test("管理员可测试渠道连通性并拉取模型列表", async () => {
        const ctx = await setup();
        const adminCookie = await adminLogin(ctx);
        const response = await request(ctx, "/api/admin/channels/test", {
            method: "POST",
            headers: { "content-type": "application/json", cookie: adminCookie },
            body: JSON.stringify({ baseUrl: upstreamBase, apiKey: "sk-test-key", apiFormat: "openai" }),
        });
        expect(response.status).toBe(200);
        const data = (await response.json()) as any;
        expect(Array.isArray(data.models)).toBe(true);
        ctx.cleanup();
    });
});

describe("访客身份（IP + 指纹）", () => {
    test("指纹会话写入 clients / client_ips 并下发 Cookie", async () => {
        const ctx = await setup();
        const { cookie } = await createSession(ctx);
        const rows = ctx.db.query("SELECT * FROM clients").all() as any[];
        expect(rows.length).toBe(1);
        expect(rows[0].fingerprint).toBe("visitor-xyz-123456");
        expect(rows[0].last_ip).toBe("127.0.0.1");
        const ips = ctx.db.query("SELECT * FROM client_ips").all() as any[];
        expect(ips.length).toBe(1);
        expect(ips[0].ip).toBe("127.0.0.1");

        const quota = await request(ctx, "/api/quota", { headers: { cookie } });
        expect(quota.status).toBe(200);
        const data = (await quota.json()) as any;
        expect(data.quota.capabilities.image.dailyLimit).toBe(100);
        ctx.cleanup();
    });

    test("管理后台可查看访客 IP 与指纹", async () => {
        const ctx = await setup();
        await createSession(ctx);
        const adminCookie = await adminLogin(ctx);
        const response = await request(ctx, "/api/admin/clients?q=visitor-xyz", { headers: { cookie: adminCookie } });
        expect(response.status).toBe(200);
        const data = (await response.json()) as any;
        expect(data.total).toBe(1);
        expect(data.items[0].fingerprint).toBe("visitor-xyz-123456");
        expect(data.items[0].lastIp).toBe("127.0.0.1");
        ctx.cleanup();
    });
});

describe("中转与额度", () => {
    test("管理员注入 Key，匿名用户生成成功后额度扣减", async () => {
        const ctx = await setup();
        const adminCookie = await adminLogin(ctx);
        await configureChannel(ctx, adminCookie);
        const { cookie } = await createSession(ctx);
        upstreamCalls.length = 0;

        const response = await relayImage(ctx, cookie, { model: "img-1", prompt: "hello", n: 1 });
        expect(response.status).toBe(200);
        const data = (await response.json()) as any;
        expect(data.data[0].b64_json).toBe("QUJD");
        expect(upstreamCalls.at(-1)?.authorization).toBe("Bearer sk-test-key");

        const quota = await request(ctx, "/api/quota", { headers: { cookie } });
        const quotaData = (await quota.json()) as any;
        expect(quotaData.quota.capabilities.image.dailyUsed).toBe(1);
        const events = ctx.db.query("SELECT * FROM usage_events").all() as any[];
        expect(events.length).toBe(1);
        expect(events[0].state).toBe("committed");
        expect(events[0].capability).toBe("image");
        ctx.cleanup();
    });

    test("未建立会话的中转请求返回 401", async () => {
        const ctx = await setup();
        const adminCookie = await adminLogin(ctx);
        await configureChannel(ctx, adminCookie);
        const response = await relayImage(ctx, "");
        expect(response.status).toBe(401);
        const data = (await response.json()) as any;
        expect(data.code).toBe("session_required");
        ctx.cleanup();
    });

    test("未在渠道白名单的目标被拒绝", async () => {
        const ctx = await setup();
        const adminCookie = await adminLogin(ctx);
        await configureChannel(ctx, adminCookie);
        const { cookie } = await createSession(ctx);
        const response = await request(ctx, `/api/relay?url=${encodeURIComponent("http://127.0.0.1:1/v1/images/generations")}`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ model: "img-1", prompt: "hello", n: 1 }),
        });
        expect(response.status).toBe(403);
        const data = (await response.json()) as any;
        expect(data.code).toBe("relay_target_not_allowed");
        ctx.cleanup();
    });

    test("未配置的模型被拒绝", async () => {
        const ctx = await setup();
        const adminCookie = await adminLogin(ctx);
        await configureChannel(ctx, adminCookie);
        const { cookie } = await createSession(ctx);
        const response = await relayImage(ctx, cookie, { model: "unknown-model", prompt: "hello", n: 1 });
        expect(response.status).toBe(400);
        const data = (await response.json()) as any;
        expect(data.code).toBe("model_not_available");
        ctx.cleanup();
    });

    test("额度耗尽返回 429，管理员手动重置后恢复", async () => {
        const ctx = await setup();
        const adminCookie = await adminLogin(ctx);
        await configureChannel(ctx, adminCookie);
        const { cookie, clientId } = await createSession(ctx);
        await updateQuotaPolicy(ctx, adminCookie, 1, 10);

        expect((await relayImage(ctx, cookie)).status).toBe(200);
        const blocked = await relayImage(ctx, cookie);
        expect(blocked.status).toBe(429);
        const blockedData = (await blocked.json()) as any;
        expect(blockedData.code).toBe("quota_exceeded");
        expect(blockedData.scope).toBe("daily");
        expect(blockedData.error.message).toContain("今日图片额度已用完");

        const reset = await request(ctx, `/api/admin/clients/${clientId}/reset-quota`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie: adminCookie },
            body: JSON.stringify({ scope: "all" }),
        });
        expect(reset.status).toBe(200);
        expect((await relayImage(ctx, cookie)).status).toBe(200);
        ctx.cleanup();
    });

    test("跨天后日额度自动恢复", async () => {
        const ctx = await setup();
        const adminCookie = await adminLogin(ctx);
        await configureChannel(ctx, adminCookie);
        setNowForTests(Date.UTC(2026, 10, 5, 4, 0, 0));
        const { cookie } = await createSession(ctx);
        await updateQuotaPolicy(ctx, adminCookie, 1, 10);

        expect((await relayImage(ctx, cookie)).status).toBe(200);
        expect((await relayImage(ctx, cookie)).status).toBe(429);

        setNowForTests(Date.UTC(2026, 10, 6, 4, 0, 0));
        expect((await relayImage(ctx, cookie)).status).toBe(200);
        ctx.cleanup();
    });
});
