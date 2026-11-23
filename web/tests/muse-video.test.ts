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
    VIDEO_MAX_REFERENCES,
    VIDEO_MAX_REFERENCE_BYTES,
    VIDEO_MAX_REFERENCE_TOTAL_BYTES,
    createVideoGenerationTask,
    estimateDataUrlBytes,
    isMuseVideoModel,
    normalizeMuseVideoPrompt,
    pollVideoGenerationTask,
    validateVideoReferenceLimits,
} = await import("../src/services/api/video");

afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const originalPost = axios.post;
const originalGet = axios.get;

afterEach(() => {
    axios.post = originalPost;
    axios.get = originalGet;
});

function makeConfig(model = "muse::muse-video") {
    return {
        ...defaultConfig,
        model,
        videoModel: model,
        baseUrl: "http://127.0.0.1:18610/v1",
        apiKey: "m2a_test_key",
        size: "16:9",
        vquality: "720",
        videoSeconds: "6",
        channels: [
            {
                id: "muse",
                name: "Muse",
                baseUrl: "http://127.0.0.1:18610/v1",
                apiKey: "m2a_test_key",
                apiFormat: "openai" as const,
                models: [
                    { name: "muse-video", capability: "video" as const },
                    { name: "sora", capability: "video" as const },
                ],
            },
        ],
    };
}

function makeRefs(count: number) {
    return Array.from({ length: count }, (_, idx) => ({
        id: `ref-${idx + 1}`,
        name: `img_${idx + 1}.png`,
        type: "image/png",
        dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    }));
}

describe("muse2api video support", () => {
    it("detects muse video models with or without channel prefix", () => {
        expect(isMuseVideoModel("muse-video")).toBe(true);
        expect(isMuseVideoModel("muse::muse-video")).toBe(true);
        expect(isMuseVideoModel("muse_vid")).toBe(true);
        expect(isMuseVideoModel("muse::sora")).toBe(false);
    });

    it("normalizes reference tokens without double-wrapping existing brackets", () => {
        const input = "让【图1】的角色走入图2场景，保持Image 3色调，[图4]作为前景，参考视频 1 运镜，参考音频 1 配乐";
        expect(normalizeMuseVideoPrompt(input)).toBe("让[图1]的角色走入[图2]场景，保持[图3]色调，[图4]作为前景，[视频1] 运镜，[音频1] 配乐");
    });

    it("validates 10-item count, 40 MiB per-file, and 100 MiB total limits", () => {
        expect(estimateDataUrlBytes("data:image/png;base64,AAAA")).toBe(3);
        expect(() => validateVideoReferenceLimits(Array.from({ length: VIDEO_MAX_REFERENCES }, (_, i) => ({ name: `f${i}`, bytes: 1024 })))).not.toThrow();
        expect(() => validateVideoReferenceLimits(Array.from({ length: VIDEO_MAX_REFERENCES + 1 }, (_, i) => ({ name: `f${i}`, bytes: 1024 })))).toThrow(/10/);
        expect(() => validateVideoReferenceLimits([{ name: "huge.png", bytes: VIDEO_MAX_REFERENCE_BYTES + 1 }])).toThrow(/huge\.png/);
        expect(() =>
            validateVideoReferenceLimits([
                { name: "a.png", bytes: 38 * 1024 * 1024 },
                { name: "b.png", bytes: 38 * 1024 * 1024 },
                { name: "c.png", bytes: VIDEO_MAX_REFERENCE_TOTAL_BYTES - 75 * 1024 * 1024 },
            ]),
        ).toThrow(/100 MiB/);
    });

    it("sends JSON POST /videos with up to 10 images for muse-video", async () => {
        let capturedUrl = "";
        let capturedBody: Record<string, unknown> | null = null;
        let capturedHeaders: Record<string, unknown> | undefined;

        axios.post = (async (url: string, body: unknown, opts?: { headers?: Record<string, unknown> }) => {
            capturedUrl = url;
            capturedBody = body as Record<string, unknown>;
            capturedHeaders = opts?.headers;
            return { status: 200, data: { id: "task_muse_1", status: "queued" } };
        }) as unknown as typeof axios.post;

        const refs = makeRefs(10);
        const task = await createVideoGenerationTask(makeConfig("muse::muse-video"), "让图1走到【图10】", refs);

        expect(task).toEqual({ id: "task_muse_1", provider: "openai", model: "muse::muse-video" });
        expect(capturedUrl).toBe("http://127.0.0.1:18610/v1/videos");
        expect(capturedHeaders?.["Content-Type"]).toBe("application/json");
        expect(capturedBody?.prompt).toBe("让[图1]走到[图10]");
        expect(Array.isArray(capturedBody?.images)).toBe(true);
        expect((capturedBody?.images as string[]).length).toBe(10);
        expect(capturedBody?.duration).toBe(6);
        expect(capturedBody?.aspect_ratio).toBe("16:9");
    });

    it("falls back to Muse JSON when FormData POST /videos returns 422", async () => {
        const calls: Array<{ isFormData: boolean }> = [];
        axios.post = (async (_url: string, body: unknown) => {
            const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
            calls.push({ isFormData });
            if (isFormData) {
                throw new AxiosError("Unprocessable Entity", "ERR_BAD_REQUEST", undefined, undefined, {
                    status: 422,
                    statusText: "Unprocessable Entity",
                    headers: new AxiosHeaders(),
                    config: { headers: new AxiosHeaders() },
                    data: { detail: "JSON expected" },
                });
            }
            return { status: 200, data: { task_id: "task_fallback_1", status: "queued" } };
        }) as unknown as typeof axios.post;

        const task = await createVideoGenerationTask(makeConfig("muse::sora"), "测试回退", makeRefs(3));
        expect(calls).toEqual([{ isFormData: true }, { isFormData: false }]);
        expect(task.id).toBe("task_fallback_1");
    });

    it("rejects more than 10 references before sending request", async () => {
        await expect(createVideoGenerationTask(makeConfig("muse::muse-video"), "test", makeRefs(11))).rejects.toThrow(/10/);
    });

    it("polls progress, string errors, and /api/relay media URLs", async () => {
        let step = 0;
        const requestedUrls: string[] = [];
        axios.get = (async (url: string) => {
            requestedUrls.push(url);
            step += 1;
            if (step === 1) {
                return { status: 200, data: { id: "t1", status: "processing", progress: 55 } };
            }
            if (step === 2) {
                return {
                    status: 200,
                    data: {
                        id: "t1",
                        status: "succeeded",
                        progress: 100,
                        result: { url: "/api/relay?url=http%3A%2F%2F127.0.0.1%3A18610%2Fv1%2Fmedia%2Fvid.mp4" },
                    },
                };
            }
            if (step === 3) {
                return { status: 200, data: new Blob(["mp4data"], { type: "video/mp4" }) };
            }
            return { status: 200, data: { id: "t2", status: "failed", error: "安全策略拒绝" } };
        }) as unknown as typeof axios.get;

        const config = makeConfig("muse::muse-video");
        const task = { id: "t1", provider: "openai" as const, model: "muse::muse-video" };

        const pendingState = await pollVideoGenerationTask(config, task);
        expect(pendingState).toEqual({ status: "pending", progress: 55, remoteStatus: "processing" });

        const completedState = await pollVideoGenerationTask(config, task);
        expect(completedState.status).toBe("completed");
        expect(requestedUrls[2]).toBe("/api/relay?url=http%3A%2F%2F127.0.0.1%3A18610%2Fv1%2Fmedia%2Fvid.mp4");

        const failedState = await pollVideoGenerationTask(config, { id: "t2", provider: "openai", model: "muse::muse-video" });
        expect(failedState).toEqual({ status: "failed", error: "安全策略拒绝" });
    });
});
