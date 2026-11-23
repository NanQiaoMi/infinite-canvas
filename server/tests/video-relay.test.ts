import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { ensureAdminAccount } from "../src/admin";
import { createApp, type App } from "../src/app";
import { openStore } from "../src/db";
import { createTestConfig } from "./helpers";

let upstream: ReturnType<typeof Bun.serve>;
let upstreamBase = "";
let lastVideoPayload: Record<string, unknown> | null = null;

beforeAll(() => {
    upstream = Bun.serve({
        port: 0,
        async fetch(req) {
            const url = new URL(req.url);
            if (url.pathname === "/v1/videos" && req.method === "POST") {
                lastVideoPayload = (await req.json()) as Record<string, unknown>;
                return Response.json({ id: "task_muse_relay_1", status: "queued" });
            }
            if (url.pathname === "/v1/videos/task_muse_relay_1" && req.method === "GET") {
                const mediaUrl = `${upstreamBase}/v1/media/vid_muse_1.mp4`;
                return Response.json({
                    id: "task_muse_relay_1",
                    status: "completed",
                    progress: 100,
                    url: mediaUrl,
                    video: { url: mediaUrl },
                    result: { url: mediaUrl },
                });
            }
            if (url.pathname === "/v1/media/vid_muse_1.mp4" && req.method === "GET") {
                return new Response(new Uint8Array([0, 0, 0, 24]), {
                    headers: { "content-type": "video/mp4" },
                });
            }
            return new Response("not found", { status: 404 });
        },
    });
    upstreamBase = `http://127.0.0.1:${upstream.port}`;
});

afterAll(() => {
    upstream.stop(true);
});

async function setupContext() {
    const { config, cleanup } = createTestConfig();
    const store = openStore(config.dbPath, config.schemaPath);
    await ensureAdminAccount(store.db, config);
    const app: App = createApp(config, store.db);

    const loginRes = await app.fetch(
        new Request("http://localhost/api/admin/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ username: "admin", password: "test-password-123" }),
        }),
        "127.0.0.1",
    );
    const adminCookie = (loginRes.headers.get("set-cookie") || "").split(";")[0] || "";

    const chRes = await app.fetch(
        new Request("http://localhost/api/admin/channels", {
            method: "PUT",
            headers: { "content-type": "application/json", cookie: adminCookie },
            body: JSON.stringify({
                channels: [
                    {
                        id: "muse",
                        name: "Muse",
                        baseUrl: `${upstreamBase}/v1`,
                        apiKey: "m2a_secret",
                        apiFormat: "openai",
                        models: [{ name: "muse-video", capability: "video" }],
                    },
                ],
            }),
        }),
        "127.0.0.1",
    );
    expect(chRes.status).toBe(200);

    const fpRes = await app.fetch(
        new Request("http://localhost/api/session/fingerprint", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ fingerprint: "fp-video-relay-test" }),
        }),
        "127.0.0.1",
    );
    const userCookie = (fpRes.headers.get("set-cookie") || "").split(";")[0] || "";
    return { app, cleanup, userCookie };
}

describe("muse2api video relay", () => {
    test("forwards POST /v1/videos JSON and rewrites media URLs on poll", async () => {
        const { app, cleanup, userCookie } = await setupContext();
        try {
            const images = Array.from({ length: 10 }, (_, idx) => `data:image/png;base64,iVBORw0KGgo=${idx}`);
            const createRes = await app.fetch(
                new Request(`http://localhost/api/relay?url=${encodeURIComponent(`${upstreamBase}/v1/videos`)}`, {
                    method: "POST",
                    headers: { "content-type": "application/json", cookie: userCookie },
                    body: JSON.stringify({ model: "muse-video", prompt: "让[图1]走到[图10]", images, duration: 6 }),
                }),
                "127.0.0.1",
            );
            expect(createRes.status).toBe(200);
            expect(lastVideoPayload?.model).toBe("muse-video");
            expect((lastVideoPayload?.images as string[]).length).toBe(10);

            const pollRes = await app.fetch(
                new Request(`http://localhost/api/relay?url=${encodeURIComponent(`${upstreamBase}/v1/videos/task_muse_relay_1`)}`, {
                    method: "GET",
                    headers: { cookie: userCookie },
                }),
                "127.0.0.1",
            );
            expect(pollRes.status).toBe(200);
            const polled = (await pollRes.json()) as { url: string; video: { url: string }; result: { url: string } };
            const expectedRelay = `/api/relay?url=${encodeURIComponent(`${upstreamBase}/v1/media/vid_muse_1.mp4`)}`;
            expect(polled.url).toBe(expectedRelay);
            expect(polled.video.url).toBe(expectedRelay);
            expect(polled.result.url).toBe(expectedRelay);

            const mediaRes = await app.fetch(
                new Request(`http://localhost${polled.url}`, {
                    method: "GET",
                    headers: { cookie: userCookie },
                }),
                "127.0.0.1",
            );
            expect(mediaRes.status).toBe(200);
            expect(mediaRes.headers.get("content-type")).toBe("video/mp4");
            expect(new Uint8Array(await mediaRes.arrayBuffer())).toEqual(new Uint8Array([0, 0, 0, 24]));
        } finally {
            cleanup();
        }
    });
});
