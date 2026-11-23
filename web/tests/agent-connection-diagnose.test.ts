import { afterAll, describe, expect, it } from "bun:test";

const storageValues = new Map<string, string>();
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => storageValues.get(key) ?? null,
        setItem: (key: string, value: string) => storageValues.set(key, value),
        removeItem: (key: string) => storageValues.delete(key),
    },
});
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const { diagnoseAgentConnection } = await import("../src/services/api/canvas-agent");

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

describe("diagnoseAgentConnection", () => {
    it("returns unreachable when /health throws a network error or fails", async () => {
        const netErr = await diagnoseAgentConnection("http://127.0.0.1:17371", "tok", 7, {
            fetchImpl: (async () => {
                throw new TypeError("Failed to fetch");
            }) as unknown as typeof fetch,
        });
        expect(netErr.status).toBe("unreachable");

        const httpErr = await diagnoseAgentConnection("http://127.0.0.1:17371", "tok", 7, {
            fetchImpl: (async () => jsonResponse({ ok: false }, 503)) as unknown as typeof fetch,
        });
        expect(httpErr.status).toBe("unreachable");
    });

    it("returns outdated when /health reports an older protocolVersion", async () => {
        const res = await diagnoseAgentConnection("http://127.0.0.1:17371", "tok", 7, {
            fetchImpl: (async () => jsonResponse({ ok: true, protocolVersion: 6 })) as unknown as typeof fetch,
        });
        expect(res).toEqual({ status: "outdated", protocolVersion: 6 });
    });

    it("returns invalid_token when /auth/check responds with 401", async () => {
        const res = await diagnoseAgentConnection("http://127.0.0.1:17371", "bad-tok", 7, {
            fetchImpl: (async (url) => {
                if (String(url).endsWith("/health")) return jsonResponse({ ok: true, protocolVersion: 7 });
                return jsonResponse({ ok: false, error: "invalid token" }, 401);
            }) as unknown as typeof fetch,
        });
        expect(res).toEqual({ status: "invalid_token", protocolVersion: 7 });
    });

    it("returns origin_rejected on 403 or CORS TypeError after healthy /health", async () => {
        const res403 = await diagnoseAgentConnection("http://127.0.0.1:17371", "tok", 7, {
            fetchImpl: (async (url) => {
                if (String(url).endsWith("/health")) return jsonResponse({ ok: true, protocolVersion: 7 });
                return jsonResponse({ ok: false, error: "origin not allowed" }, 403);
            }) as unknown as typeof fetch,
        });
        expect(res403).toEqual({ status: "origin_rejected", protocolVersion: 7 });

        const resCors = await diagnoseAgentConnection("http://127.0.0.1:17371", "tok", 7, {
            fetchImpl: (async (url) => {
                if (String(url).endsWith("/health")) return jsonResponse({ ok: true, protocolVersion: 7 });
                throw new TypeError("Failed to fetch");
            }) as unknown as typeof fetch,
        });
        expect(resCors.status).toBe("origin_rejected");
    });

    it("returns unreachable if /auth/check aborts due to timeout", async () => {
        const res = await diagnoseAgentConnection("http://127.0.0.1:17371", "tok", 7, {
            fetchImpl: (async (url) => {
                if (String(url).endsWith("/health")) return jsonResponse({ ok: true, protocolVersion: 7 });
                throw Object.assign(new Error("timed out"), { name: "AbortError" });
            }) as unknown as typeof fetch,
        });
        expect(res.status).toBe("unreachable");
    });

    it("returns ok when /auth/check returns 200 or 404 (legacy v7 server without /auth/check)", async () => {
        const ok200 = await diagnoseAgentConnection("http://127.0.0.1:17371", "tok", 7, {
            fetchImpl: (async (url) => {
                if (String(url).endsWith("/health")) return jsonResponse({ ok: true, protocolVersion: 7 });
                return jsonResponse({ ok: true, protocolVersion: 7 });
            }) as unknown as typeof fetch,
        });
        expect(ok200).toEqual({ status: "ok", protocolVersion: 7 });

        const ok404 = await diagnoseAgentConnection("http://127.0.0.1:17371", "tok", 7, {
            fetchImpl: (async (url) => {
                if (String(url).endsWith("/health")) return jsonResponse({ ok: true, protocolVersion: 7 });
                return new Response("Not Found", { status: 404 });
            }) as unknown as typeof fetch,
        });
        expect(ok404).toEqual({ status: "ok", protocolVersion: 7 });
    });
});
