import { afterAll, describe, expect, it } from "bun:test";
import type { AgentCanvasContext } from "../src/stores/use-agent-store";
import type { CanvasAgentSnapshot } from "../src/lib/canvas/canvas-agent-ops";

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

const { extractCanvasProjectId, waitForCanvasProjectReady, runSiteTool } = await import("../src/lib/agent/agent-site-tools");
const { useAssetStore } = await import("../src/stores/use-asset-store");
const { CanvasNodeType } = await import("../src/types/canvas");

function fakeCanvasContext(projectId: string): AgentCanvasContext {
    const snapshot: CanvasAgentSnapshot = {
        projectId,
        title: `Project ${projectId}`,
        nodes: [],
        connections: [],
        selectedNodeIds: [],
        viewport: { x: 0, y: 0, k: 1 },
    };
    return {
        snapshot,
        applyOps: () => snapshot,
        undoOps: () => snapshot,
        canUndo: false,
    };
}

describe("extractCanvasProjectId", () => {
    it("extracts project id from /canvas/:id routes and ignores non-project paths", () => {
        expect(extractCanvasProjectId("/canvas/proj-123")).toBe("proj-123");
        expect(extractCanvasProjectId("/canvas/my%20proj?tab=1#top")).toBe("my proj");
        expect(extractCanvasProjectId("/canvas")).toBeNull();
        expect(extractCanvasProjectId("/canvas/")).toBeNull();
        expect(extractCanvasProjectId("/video")).toBeNull();
        expect(extractCanvasProjectId("")).toBeNull();
    });
});

describe("waitForCanvasProjectReady", () => {
    it("returns immediately when target canvas context is already loaded", async () => {
        const target = fakeCanvasContext("p1");
        const found = await waitForCanvasProjectReady("p1", () => target, { timeoutMs: 200, pollMs: 10 });
        expect(found).toBe(target);
    });

    it("polls until target project becomes active and returns it", async () => {
        let active: AgentCanvasContext | null = fakeCanvasContext("old");
        setTimeout(() => {
            active = fakeCanvasContext("new-id");
        }, 25);
        const found = await waitForCanvasProjectReady("new-id", () => active, { timeoutMs: 500, pollMs: 10 });
        expect(found?.snapshot.projectId).toBe("new-id");
    });

    it("returns null on timeout if canvas project never finishes loading", async () => {
        const active = fakeCanvasContext("other");
        const found = await waitForCanvasProjectReady("missing", () => active, { timeoutMs: 50, pollMs: 10 });
        expect(found).toBeNull();
    });
});

describe("canvas_create_asset_nodes validation", () => {
    const noopNavigate = (() => {}) as unknown as Parameters<typeof runSiteTool>[2];

    it("requires an active canvas context", async () => {
        await expect(
            runSiteTool("canvas_create_asset_nodes", { assetIds: ["a1"] }, noopNavigate, {}),
        ).rejects.toThrow();
    });

    it("rejects more than 10 assetIds, missing assets, and non-image assets", async () => {
        const prev = useAssetStore.getState();
        useAssetStore.setState({
            hydrated: true,
            assets: [
                {
                    id: "text-1",
                    kind: "text",
                    title: "Prompt note",
                    coverUrl: "",
                    tags: [],
                    createdAt: "2026-01-01",
                    updatedAt: "2026-01-01",
                    data: { content: "hello" },
                },
            ],
        });
        const ctx = fakeCanvasContext("p1");
        try {
            const tooMany = Array.from({ length: 11 }, (_, i) => `id-${i}`);
            await expect(
                runSiteTool("canvas_create_asset_nodes", { assetIds: tooMany }, noopNavigate, { canvasContext: ctx }),
            ).rejects.toThrow(/10/);

            await expect(
                runSiteTool("canvas_create_asset_nodes", { assetIds: ["missing-id"] }, noopNavigate, { canvasContext: ctx }),
            ).rejects.toThrow(/missing-id/);

            await expect(
                runSiteTool("canvas_create_asset_nodes", { assetIds: ["text-1"] }, noopNavigate, { canvasContext: ctx }),
            ).rejects.toThrow(/Prompt note/);
        } finally {
            useAssetStore.setState({ hydrated: prev.hydrated, assets: prev.assets });
        }
    });
});

describe("canvas_continue_video_shot validation", () => {
    const noopNavigate = (() => {}) as unknown as Parameters<typeof runSiteTool>[2];

    it("requires an active canvas context and valid source/character nodes within 10 total references", async () => {
        await expect(
            runSiteTool("canvas_continue_video_shot", { sourceVideoNodeId: "v1", prompt: "next shot" }, noopNavigate, {}),
        ).rejects.toThrow();

        const ctx = fakeCanvasContext("p1");
        ctx.snapshot.nodes = [
            {
                id: "v1",
                type: CanvasNodeType.Video,
                title: "Shot 1",
                position: { x: 0, y: 0 },
                width: 320,
                height: 180,
                metadata: { content: "https://example.com/v1.mp4", status: "success" },
            },
        ];

        await expect(
            runSiteTool("canvas_continue_video_shot", { sourceVideoNodeId: "missing", prompt: "next shot" }, noopNavigate, { canvasContext: ctx }),
        ).rejects.toThrow(/missing/);

        await expect(
            runSiteTool(
                "canvas_continue_video_shot",
                {
                    sourceVideoNodeId: "v1",
                    prompt: "next shot",
                    characterReferenceNodeIds: Array.from({ length: 10 }, (_, i) => `char-${i + 1}`),
                },
                noopNavigate,
                { canvasContext: ctx },
            ),
        ).rejects.toThrow(/10/);

        await expect(
            runSiteTool(
                "canvas_continue_video_shot",
                { sourceVideoNodeId: "v1", prompt: "next shot", characterReferenceNodeIds: ["missing-char"] },
                noopNavigate,
                { canvasContext: ctx },
            ),
        ).rejects.toThrow(/missing-char/);
    });
});
