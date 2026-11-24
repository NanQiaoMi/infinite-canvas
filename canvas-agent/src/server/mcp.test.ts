import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import {
    buildOneClickConnectUrl,
    enrichConnectionError,
    formatMcpToolResult,
    getConnectionStatus,
    isLocalBridgeUrl,
    postCanvasAgentTool,
} from "./mcp.js";

async function withMockServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
    run: (url: string) => Promise<void>,
) {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("unexpected server address");
    const url = `http://127.0.0.1:${addr.port}`;
    try {
        await run(url);
    } finally {
        await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
}

test("formatMcpToolResult wraps plain tool outputs as a single JSON text block", () => {
    const out = formatMcpToolResult({ ok: true, count: 2 });
    assert.deepEqual(out, {
        content: [{ type: "text", text: JSON.stringify({ ok: true, count: 2 }, null, 2) }],
    });
});

test("formatMcpToolResult strips _mcpImages from JSON and appends labeled MCP image blocks", () => {
    const out = formatMcpToolResult({
        ok: true,
        summary: "6 frames",
        _mcpImages: [
            { mimeType: "image/jpeg", data: "QUJD", label: "参考图拼图" },
            { mimeType: "", data: "REVG" },
            { mimeType: "image/png", data: "" },
        ],
    });

    assert.equal(out.content.length, 4);
    assert.deepEqual(out.content[0], {
        type: "text",
        text: JSON.stringify({ ok: true, summary: "6 frames" }, null, 2),
    });
    assert.deepEqual(out.content[1], { type: "text", text: "参考图拼图" });
    assert.deepEqual(out.content[2], { type: "image", data: "QUJD", mimeType: "image/jpeg" });
    assert.deepEqual(out.content[3], { type: "image", data: "REVG", mimeType: "image/jpeg" });
});

test("isLocalBridgeUrl accepts loopback HTTP(S) hosts and rejects remote or invalid URLs", () => {
    assert.equal(isLocalBridgeUrl("http://127.0.0.1:17371"), true);
    assert.equal(isLocalBridgeUrl("http://localhost:17371"), true);
    assert.equal(isLocalBridgeUrl("http://[::1]:17371"), true);
    assert.equal(isLocalBridgeUrl("https://example.com:17371"), false);
    assert.equal(isLocalBridgeUrl("file:///tmp/socket"), false);
    assert.equal(isLocalBridgeUrl("not-a-url"), false);
});

test("buildOneClickConnectUrl encodes agentUrl and agentToken into hash fragment", () => {
    const url = buildOneClickConnectUrl({ url: "http://127.0.0.1:17371", token: "tok-123" });
    assert.equal(
        url,
        "http://localhost:3000/#agentUrl=http%3A%2F%2F127.0.0.1%3A17371&agentToken=tok-123",
    );

    const custom = buildOneClickConnectUrl(
        { url: "http://127.0.0.1:17371", token: "tok-abc" },
        "https://canvas.example.com/canvas/",
    );
    assert.equal(
        custom,
        "https://canvas.example.com/canvas#agentUrl=http%3A%2F%2F127.0.0.1%3A17371&agentToken=tok-abc",
    );
});

test("enrichConnectionError appends one-click connect link for connection errors and preserves domain errors", () => {
    const cfg = { url: "http://127.0.0.1:17371", token: "tok-xyz" };
    const connectUrl = buildOneClickConnectUrl(cfg);

    const noPage = enrichConnectionError("当前没有已连接网页", cfg);
    assert.match(noPage, /尚未连接浏览器网页/);
    assert.ok(noPage.includes(connectUrl));

    const noCanvas = enrichConnectionError("当前没有已连接画布", cfg);
    assert.match(noCanvas, /site_navigate/);
    assert.ok(noCanvas.includes(connectUrl));

    const authFail = enrichConnectionError("invalid token", cfg, { httpStatus: 401 });
    assert.match(authFail, /鉴权失败/);
    assert.ok(authFail.includes(connectUrl));

    const netFail = enrichConnectionError("fetch failed", cfg);
    assert.match(netFail, /无法连接本地 Canvas Agent HTTP 服务/);
    assert.ok(netFail.includes(connectUrl));

    assert.equal(enrichConnectionError("未找到画布节点：n1", cfg), "未找到画布节点：n1");
});

test("postCanvasAgentTool reloads config on HTTP 401 and retries once", async () => {
    let seenTokens: string[] = [];
    await withMockServer(
        (req, res) => {
            const token = String(req.headers["x-canvas-agent-token"] || "");
            seenTokens.push(token);
            if (token !== "fresh-token") {
                res.writeHead(401, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "invalid token" }));
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, result: { projects: [{ id: "p1" }] } }));
        },
        async (url) => {
            let calls = 0;
            const result = await postCanvasAgentTool(
                "canvas_list_projects",
                {},
                {
                    readConfig: () => {
                        calls += 1;
                        return { url, token: calls === 1 ? "stale-token" : "fresh-token" };
                    },
                },
            );
            assert.deepEqual(seenTokens, ["stale-token", "fresh-token"]);
            assert.deepEqual(result, { projects: [{ id: "p1" }] });
        },
    );
});

test("postCanvasAgentTool triggers ensureBridge on initial network failure and retries against new bridge", async () => {
    await withMockServer(
        (_req, res) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, result: { ok: true, count: 1 } }));
        },
        async (liveUrl) => {
            // Find an unused ephemeral port guaranteed to fail connection first
            const deadServer = http.createServer();
            await new Promise<void>((resolve) => deadServer.listen(0, "127.0.0.1", resolve));
            const deadAddr = deadServer.address();
            const deadPort = typeof deadAddr === "object" && deadAddr ? deadAddr.port : 1;
            await new Promise<void>((resolve) => deadServer.close(() => resolve()));

            let ensuredCount = 0;
            const result = await postCanvasAgentTool(
                "canvas_list_projects",
                {},
                {
                    readConfig: () => ({ url: `http://127.0.0.1:${deadPort}`, token: "t1" }),
                    ensureBridge: async () => {
                        ensuredCount += 1;
                        return {
                            config: { url: liveUrl, token: "t1" },
                            health: { ok: true, protocolVersion: 7, clients: 1 },
                            started: true,
                        };
                    },
                },
            );
            assert.equal(ensuredCount, 1);
            assert.deepEqual(result, { ok: true, count: 1 });
        },
    );
});

test("getConnectionStatus reports bridge/browser readiness and builds oneClickConnectUrl", async () => {
    await withMockServer(
        (req, res) => {
            if (req.url === "/health") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    ok: true,
                    protocolVersion: 7,
                    hasCanvas: true,
                    clients: 2,
                    activeClientId: "tab-video",
                    connectedTabs: [
                        { clientId: "tab-video", active: true, hasCanvas: false, projectId: null, title: null, nodeCount: 0 },
                        { clientId: "tab-canvas", active: false, hasCanvas: true, projectId: "p1", title: "Demo", nodeCount: 4 },
                    ],
                    codexBusy: false,
                }));
                return;
            }
            res.writeHead(404).end();
        },
        async (url) => {
            const status = await getConnectionStatus(
                { siteUrl: "http://localhost:5173/canvas", autoStart: false },
                { readConfig: () => ({ url, token: "tok-live" }) },
            );
            assert.equal(status.ok, true);
            assert.equal(status.ready, true);
            assert.equal(status.bridgeReachable, true);
            assert.equal(status.connectedClients, 2);
            assert.equal(status.activeClientId, "tab-video");
            assert.equal(status.connectedTabs.length, 2);
            assert.equal(status.connectedTabs[1]?.projectId, "p1");
            assert.equal(status.hasCanvas, true);
            assert.equal(status.protocolVersion, 7);
            assert.equal(
                status.oneClickConnectUrl,
                `http://localhost:5173/canvas#${new URLSearchParams({ agentUrl: url, agentToken: "tok-live" }).toString()}`,
            );
        },
    );
});
