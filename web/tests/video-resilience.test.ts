const storeMap = new Map<string, string>();
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => storeMap.get(key) ?? null,
        setItem: (key: string, value: string) => storeMap.set(key, String(value)),
        removeItem: (key: string) => storeMap.delete(key),
        clear: () => storeMap.clear(),
    },
});

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import axios, { AxiosError, AxiosHeaders } from "axios";

const { defaultConfig } = await import("../src/stores/use-config-store");
const {
    VIDEO_POLL_MAX_CONSECUTIVE_ERRORS,
    classifyVideoError,
    downloadVideoBlobWithRetry,
    pollBackoffMs,
    waitForVideoGenerationTask,
} = await import("../src/services/api/video");

afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const originalGet = axios.get;

afterEach(() => {
    axios.get = originalGet;
});

function makeConfig() {
    return {
        ...defaultConfig,
        model: "muse::muse-video",
        videoModel: "muse::muse-video",
        baseUrl: "http://127.0.0.1:18610/v1",
        apiKey: "m2a_test",
        channels: [
            {
                id: "muse",
                name: "Muse",
                baseUrl: "http://127.0.0.1:18610/v1",
                apiKey: "m2a_test",
                apiFormat: "openai" as const,
                models: [{ name: "muse-video", capability: "video" as const }],
            },
        ],
    };
}

function axiosStatusError(status: number, data: unknown) {
    return new AxiosError(`HTTP ${status}`, "ERR_BAD_RESPONSE", undefined, undefined, {
        status,
        statusText: String(status),
        headers: new AxiosHeaders(),
        config: { headers: new AxiosHeaders() },
        data,
    });
}

describe("video resilience and error classification", () => {
    it("classifies errors into actionable categories", () => {
        expect(classifyVideoError(new DOMException("Aborted", "AbortError")).kind).toBe("canceled");
        expect(classifyVideoError(axiosStatusError(401, { error: "bad key" })).kind).toBe("auth_quota");
        expect(classifyVideoError(new Error("请求被安全审核拒绝 (safety policy)")).kind).toBe("content_refused");
        expect(classifyVideoError(new Error("参考素材最多 10 个")).kind).toBe("invalid_input");
        expect(classifyVideoError(axiosStatusError(502, { message: "bad gateway" })).kind).toBe("transient");
        expect(classifyVideoError(new Error("429 Too Many Requests")).retryable).toBe(true);
    });

    it("caps polling backoff between 3s and 15s", () => {
        expect(pollBackoffMs(1)).toBe(3000);
        expect(pollBackoffMs(2)).toBe(6000);
        expect(pollBackoffMs(3)).toBe(12000);
        expect(pollBackoffMs(4)).toBe(15000);
        expect(pollBackoffMs(5)).toBe(15000);
    });

    it("tolerates up to 5 consecutive transient polling errors and succeeds when recovered", async () => {
        let attempts = 0;
        axios.get = (async (url: string) => {
            if (url.includes("/v1/media/")) {
                return { status: 200, data: new Blob(["ok-video"], { type: "video/mp4" }) };
            }
            attempts += 1;
            if (attempts <= 3) throw axiosStatusError(502, { message: "bad gateway" });
            return { status: 200, data: { id: "t1", status: "completed", url: "http://127.0.0.1:18610/v1/media/out.mp4" } };
        }) as unknown as typeof axios.get;

        const result = await waitForVideoGenerationTask(
            makeConfig(),
            { id: "t1", provider: "openai", model: "muse::muse-video" },
            { pollDelayMs: 1, backoffFn: () => 1 },
        );
        expect(attempts).toBe(4);
        expect(result.blob).toBeDefined();
    });

    it("fails after exceeding consecutive polling error limit and fails immediately on 401 or terminal failed status", async () => {
        let transientAttempts = 0;
        axios.get = (async () => {
            transientAttempts += 1;
            throw axiosStatusError(503, { message: "busy" });
        }) as unknown as typeof axios.get;

        await expect(
            waitForVideoGenerationTask(makeConfig(), { id: "t2", provider: "openai", model: "muse::muse-video" }, { pollDelayMs: 1, backoffFn: () => 1 }),
        ).rejects.toThrow();
        expect(transientAttempts).toBe(VIDEO_POLL_MAX_CONSECUTIVE_ERRORS + 1);

        let authAttempts = 0;
        axios.get = (async () => {
            authAttempts += 1;
            throw axiosStatusError(401, { message: "unauthorized" });
        }) as unknown as typeof axios.get;

        await expect(
            waitForVideoGenerationTask(makeConfig(), { id: "t3", provider: "openai", model: "muse::muse-video" }, { pollDelayMs: 1, backoffFn: () => 1 }),
        ).rejects.toThrow();
        expect(authAttempts).toBe(1);

        let failedStatusAttempts = 0;
        axios.get = (async () => {
            failedStatusAttempts += 1;
            return { status: 200, data: { id: "t4", status: "failed", error: "安全策略拒绝" } };
        }) as unknown as typeof axios.get;

        await expect(
            waitForVideoGenerationTask(makeConfig(), { id: "t4", provider: "openai", model: "muse::muse-video" }, { pollDelayMs: 1, backoffFn: () => 1 }),
        ).rejects.toThrow(/安全策略拒绝/);
        expect(failedStatusAttempts).toBe(1);
    });

    it("retries transient video blob downloads and rejects 0-byte or JSON error payloads", async () => {
        let dlAttempts = 0;
        const okBlob = await downloadVideoBlobWithRetry(
            async () => {
                dlAttempts += 1;
                if (dlAttempts < 3) throw new Error("network reset");
                return new Blob(["mp4"], { type: "video/mp4" });
            },
            2,
            undefined,
            1,
        );
        expect(dlAttempts).toBe(3);
        expect(okBlob.size).toBe(3);

        await expect(
            downloadVideoBlobWithRetry(async () => new Blob([], { type: "video/mp4" }), 1, undefined, 1),
        ).rejects.toThrow();

        let jsonAttempts = 0;
        await expect(
            downloadVideoBlobWithRetry(
                async () => {
                    jsonAttempts += 1;
                    return new Blob([JSON.stringify({ error: { message: "file expired" } })], { type: "application/json" });
                },
                2,
                undefined,
                1,
            ),
        ).rejects.toThrow(/file expired/);
        expect(jsonAttempts).toBe(1);
    });
});
