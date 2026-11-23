import type { NavigateFunction } from "react-router-dom";
import localforage from "localforage";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { fetchPrompts } from "@/services/api/prompts";
import { VIDEO_MAX_REFERENCES } from "@/services/api/video";
import { resolveMediaUrl } from "@/services/file-storage";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { imageAspectOptions, imageQualityOptions, imageScaleOptions } from "@/components/image-settings-panel";
import { videoResolutionOptions, videoSecondsRange, videoSizeOptions } from "@/components/video-settings-panel";
import { imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { buildReferenceContactSheet, captureVideoContactSheet, captureVideoFrame, encodeImageToMcpJpeg } from "@/lib/canvas/canvas-video-frame";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { clampVideoSeconds } from "@/lib/media-size";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { modelOptionLabel, modelOptionName, normalizeModelOptionValue, selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { resolveWorkbenchPage, useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { useAgentStore, type AgentCanvasContext } from "@/stores/use-agent-store";

// Execute site-level Agent tools in the browser, including canvas lists, workbench generation, prompt search, and asset operations.
// Their data lives locally in the browser through localforage and Zustand, so this module accesses the relevant stores directly.

export const SITE_TOOL_NAMES = [
    "canvas_list_projects",
    "generation_get_status",
    "canvas_inspect_node_visual",
    "video_inspect_frames",
    "canvas_extract_video_frame",
    "workbench_image_get_config",
    "workbench_image_generate",
    "workbench_video_get_config",
    "workbench_video_generate",
    "prompts_search",
    "assets_list",
    "assets_add",
] as const;

export type SiteToolName = (typeof SITE_TOOL_NAMES)[number];

export function isSiteTool(name: string): name is SiteToolName {
    return (SITE_TOOL_NAMES as readonly string[]).includes(name);
}

function siteText(key: string, options?: Record<string, unknown>) {
    return i18n.t(`agent.siteTools.${key}`, options);
}

export const SITE_TOOL_LABELS: Record<SiteToolName, string> = {
    get canvas_list_projects() { return siteText("canvasList"); },
    get generation_get_status() { return siteText("generationStatus"); },
    get canvas_inspect_node_visual() { return siteText("inspectNodeVisual"); },
    get video_inspect_frames() { return siteText("inspectVideoFrames"); },
    get canvas_extract_video_frame() { return siteText("extractVideoFrame"); },
    get workbench_image_get_config() { return siteText("imageConfig"); },
    get workbench_image_generate() { return siteText("imageGenerate"); },
    get workbench_video_get_config() { return siteText("videoConfig"); },
    get workbench_video_generate() { return siteText("videoGenerate"); },
    get prompts_search() { return siteText("promptSearch"); },
    get assets_list() { return siteText("assetList"); },
    get assets_add() { return siteText("assetAdd"); },
};

type SiteToolInput = Record<string, unknown>;
type SiteToolContext = {
    canvasSnapshot?: CanvasAgentSnapshot | null;
    canvasContext?: AgentCanvasContext | null;
    syncCanvasState?: (snapshot: CanvasAgentSnapshot) => void;
};
type GenerationStatus = "idle" | "queued" | "running" | "succeeded" | "failed";
type GenerationStatusItem = {
    id: string;
    source: "canvas" | "image" | "video";
    status: GenerationStatus;
    kind?: string;
    title?: string;
    prompt?: string;
    projectId?: string;
    createdAt?: string;
    updatedAt?: string;
    progress?: number;
    resultUrl?: string;
    successCount?: number;
    failCount?: number;
    error?: string;
};

export async function runSiteTool(name: SiteToolName, input: SiteToolInput, navigate: NavigateFunction, context: SiteToolContext = {}): Promise<unknown> {
    switch (name) {
        case "canvas_list_projects":
            return listCanvasProjects(input);
        case "generation_get_status":
            return getGenerationStatus(input, context);
        case "canvas_inspect_node_visual":
            return inspectNodeVisual(input, context);
        case "video_inspect_frames":
            return inspectVideoFrames(input, context);
        case "canvas_extract_video_frame":
            return extractVideoFrameToCanvas(input, context);
        case "workbench_image_get_config":
            return getImageConfig();
        case "workbench_image_generate":
            return runImageWorkbench(input, navigate, context);
        case "workbench_video_get_config":
            return getVideoConfig();
        case "workbench_video_generate":
            return runVideoWorkbench(input, navigate, context);
        case "prompts_search":
            return searchPrompts(input);
        case "assets_list":
            return listAssets(input);
        case "assets_add":
            return addAsset(input);
        default:
            throw new Error(siteText("unknownTool", { name }));
    }
}

function collectGenerationStatus(input: SiteToolInput, canvasSnapshot?: CanvasAgentSnapshot | null) {
    const scope = input.scope === "canvas" || input.scope === "image" || input.scope === "video" ? input.scope : "all";
    const taskId = typeof input.taskId === "string" ? input.taskId : "";
    const nodeIds = new Set(Array.isArray(input.nodeIds) ? input.nodeIds.filter((id): id is string => typeof id === "string") : []);
    const limit = Math.max(1, Math.min(100, Math.floor(Number(input.limit)) || 20));
    const tasks: GenerationStatusItem[] = [];
    const includeCanvas = (scope === "all" || scope === "canvas") && (!taskId || nodeIds.size > 0);
    const includeWorkbench = !nodeIds.size || Boolean(taskId);

    if (includeCanvas && canvasSnapshot) {
        canvasSnapshot.nodes.forEach((node) => {
            const status = normalizeCanvasGenerationStatus(node.metadata?.status);
            if (!status || (nodeIds.size && !nodeIds.has(node.id))) return;
            const metadata = node.metadata || {};
            if (!nodeIds.size && node.type !== "config" && status !== "running" && status !== "failed" && !metadata.generationMode && !metadata.generationType && !metadata.model) return;
            const progress = typeof metadata.videoProgress === "number"
                ? metadata.videoProgress
                : typeof metadata.progress === "number"
                  ? Math.round(metadata.progress * 100)
                  : undefined;
            const resultUrl = status === "succeeded" && typeof metadata.content === "string" && !metadata.content.startsWith("data:")
                ? metadata.content
                : undefined;
            tasks.push({
                id: node.id,
                source: "canvas",
                status,
                kind: metadata.generationMode || node.type,
                title: node.title,
                prompt: compactPrompt(metadata.prompt || metadata.composerContent),
                projectId: canvasSnapshot.projectId,
                ...(progress !== undefined ? { progress } : {}),
                ...(resultUrl ? { resultUrl } : {}),
                error: metadata.errorDetails,
            });
        });
    }

    if (includeWorkbench) {
        useWorkbenchAgentStore.getState().tasks.forEach((task) => {
            if ((scope === "image" || scope === "video") && task.kind !== scope) return;
            if (scope === "canvas" || (taskId && task.id !== taskId)) return;
            tasks.push({ ...task, source: task.kind, prompt: compactPrompt(task.prompt) });
        });
    }

    tasks.sort((a, b) => generationStatusOrder(a.status) - generationStatusOrder(b.status) || (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    const summary: Record<GenerationStatus, number> = { idle: 0, queued: 0, running: 0, succeeded: 0, failed: 0 };
    tasks.forEach((task) => (summary[task.status] += 1));
    return { total: tasks.length, summary, tasks: tasks.slice(0, limit) };
}

async function getGenerationStatus(input: SiteToolInput, context: SiteToolContext) {
    const waitSeconds = Math.max(0, Math.min(30, Math.floor(Number(input.waitSeconds) || 0)));
    const deadline = Date.now() + waitSeconds * 1000;
    const readSnapshot = () => useAgentStore.getState().canvasContext?.snapshot || context.canvasContext?.snapshot || context.canvasSnapshot;
    let status = collectGenerationStatus(input, readSnapshot());
    while (waitSeconds > 0 && Date.now() < deadline && (status.summary.queued > 0 || status.summary.running > 0)) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        status = collectGenerationStatus(input, readSnapshot());
    }
    return status;
}

function generationStatusOrder(status: GenerationStatus) {
    return status === "running" ? 0 : status === "queued" ? 1 : 2;
}

function normalizeCanvasGenerationStatus(status: unknown): GenerationStatus | null {
    if (status === "idle") return "idle";
    if (status === "loading") return "running";
    if (status === "success") return "succeeded";
    if (status === "error") return "failed";
    return null;
}

function compactPrompt(prompt: unknown) {
    const value = typeof prompt === "string" ? prompt.trim() : "";
    return value ? `${value.slice(0, 200)}${value.length > 200 ? "..." : ""}` : undefined;
}

function listCanvasProjects(input: SiteToolInput) {
    const { projects, hydrated } = useCanvasStore.getState();
    if (!hydrated) throw new Error(siteText("canvasLoading"));
    const keyword = String(input.keyword || "").trim().toLowerCase();
    const filtered = keyword ? projects.filter((project) => project.title.toLowerCase().includes(keyword)) : projects;
    const { page, pageSize, start, end } = paginate(input, filtered.length, 20);
    const items = filtered.slice(start, end).map((project) => ({
        id: project.id,
        title: project.title,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        nodeCount: project.nodes.length,
        connectionCount: project.connections.length,
    }));
    return { total: filtered.length, page, pageSize, items, hint: siteText("canvasHint") };
}

function getImageConfig() {
    const { config } = useConfigStore.getState();
    const model = config.imageModel || config.model;
    return {
        current: { model, modelName: modelOptionName(model), quality: config.quality || "auto", size: config.size || "1:1", count: config.count || "1" },
        models: selectableModelsByCapability(config, "image").map((value) => ({ value, label: modelOptionLabel(config, value) })),
        qualityOptions: imageQualityOptions,
        scaleOptions: imageScaleOptions,
        sizeOptions: imageAspectOptions,
        countRange: { min: 1, max: 15 },
    };
}

function runImageWorkbench(input: SiteToolInput, navigate: NavigateFunction, context: SiteToolContext) {
    const configStore = useConfigStore.getState();
    const applied: Record<string, unknown> = {};
    if (typeof input.model === "string" && input.model.trim()) {
        const value = normalizeModelOptionValue(input.model, configStore.config.channels) || input.model;
        configStore.updateConfig("imageModel", value);
        applied.model = value;
    }
    if (typeof input.quality === "string" && input.quality.trim()) {
        configStore.updateConfig("quality", input.quality);
        applied.quality = input.quality;
    }
    if (typeof input.size === "string" && input.size.trim()) {
        configStore.updateConfig("size", input.size);
        applied.size = input.size;
    }
    if (input.count != null) {
        const count = String(Math.max(1, Math.min(15, Math.floor(Number(input.count)) || 1)));
        configStore.updateConfig("count", count);
        applied.count = count;
    }
    const prompt = typeof input.prompt === "string" && input.prompt.trim() ? input.prompt : undefined;
    // 没有明确提示词时禁止自动出图：不能拿工作台输入框里的残留提示词直接开跑。
    const run = input.run !== false && Boolean(prompt);
    const page = resolveWorkbenchPage(typeof window !== "undefined" ? window.location.pathname : "");
    const sessionId = useAgentStore.getState().conversation.threadId || undefined;
    const canvasProjectId = context.canvasSnapshot?.projectId || undefined;
    navigate("/image");
    const taskId = useWorkbenchAgentStore.getState().dispatchImage({
        prompt,
        run,
        origin: "site-tool",
        page,
        ...(sessionId ? { sessionId } : {}),
        ...(canvasProjectId ? { canvasProjectId } : {}),
    });
    return { ok: true, navigated: "/image", prompt, run, taskId, applied, promptMissing: !prompt, note: siteText(run ? "imageGenerationStarted" : "imageConfigApplied") };
}

function getVideoConfig() {
    const { config } = useConfigStore.getState();
    const model = config.videoModel || config.model;
    return {
        current: {
            model,
            modelName: modelOptionName(model),
            size: config.size || "1280x720",
            seconds: config.videoSeconds || "6",
            resolution: config.vquality || "720",
            generateAudio: config.videoGenerateAudio !== "false",
            watermark: config.videoWatermark === "true",
            mode: config.videoMode === "reference" ? "reference" : "frames",
        },
        models: selectableModelsByCapability(config, "video").map((value) => ({ value, label: modelOptionLabel(config, value) })),
        sizeOptions: videoSizeOptions,
        secondsRange: videoSecondsRange,
        resolutionOptions: videoResolutionOptions,
        modeOptions: [
            { value: "frames", label: i18n.t("settingsPanels.video.modes.frames") },
            { value: "reference", label: i18n.t("settingsPanels.video.modes.reference") },
        ],
        maxReferences: VIDEO_MAX_REFERENCES,
        referenceTokenHint: "[图1] ~ [图10]",
    };
}

async function resolveVideoToolReferences(input: SiteToolInput): Promise<ReferenceImage[]> {
    const assetIds = Array.isArray(input.referenceAssetIds) ? input.referenceAssetIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())) : [];
    const urls = Array.isArray(input.referenceUrls) ? input.referenceUrls.filter((url): url is string => typeof url === "string" && Boolean(url.trim())) : [];
    const total = assetIds.length + urls.length;
    if (total > VIDEO_MAX_REFERENCES) {
        throw new Error(siteText("videoMaxReferences", { max: VIDEO_MAX_REFERENCES, count: total }));
    }
    if (!total) return [];

    const assets = useAssetStore.getState().assets;
    const refs: ReferenceImage[] = [];

    for (const id of assetIds) {
        const asset = assets.find((item) => item.id === id);
        if (!asset) throw new Error(siteText("videoAssetNotFound", { id }));
        if (asset.kind !== "image") throw new Error(siteText("videoAssetNotImage", { title: asset.title || id }));
        const dataUrl = await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl || asset.coverUrl);
        refs.push({
            id: nanoid(),
            name: asset.title || `asset-${refs.length + 1}.png`,
            type: asset.data.mimeType || "image/png",
            dataUrl,
            storageKey: asset.data.storageKey,
        });
    }

    for (const url of urls) {
        try {
            const stored = await uploadImage(url);
            refs.push({
                id: nanoid(),
                name: `ref-${refs.length + 1}.png`,
                type: stored.mimeType,
                dataUrl: stored.url,
                storageKey: stored.storageKey,
            });
        } catch {
            throw new Error(siteText("videoReferenceUrlFailed", { url: url.slice(0, 80) }));
        }
    }

    return refs;
}

async function runVideoWorkbench(input: SiteToolInput, navigate: NavigateFunction, context: SiteToolContext = {}) {
    const references = await resolveVideoToolReferences(input);
    const configStore = useConfigStore.getState();
    const applied: Record<string, unknown> = {};
    if (typeof input.model === "string" && input.model.trim()) {
        const value = normalizeModelOptionValue(input.model, configStore.config.channels) || input.model;
        configStore.updateConfig("videoModel", value);
        applied.model = value;
    }
    if (typeof input.size === "string" && input.size.trim()) {
        configStore.updateConfig("size", input.size);
        applied.size = input.size;
    }
    if (input.seconds != null && String(input.seconds).trim()) {
        const seconds = clampVideoSeconds(String(input.seconds));
        configStore.updateConfig("videoSeconds", seconds);
        applied.seconds = seconds;
    }
    if (typeof input.resolution === "string" && input.resolution.trim()) {
        configStore.updateConfig("vquality", input.resolution);
        applied.resolution = input.resolution;
    }
    if (typeof input.generateAudio === "boolean") {
        configStore.updateConfig("videoGenerateAudio", String(input.generateAudio));
        applied.generateAudio = input.generateAudio;
    }
    if (typeof input.watermark === "boolean") {
        configStore.updateConfig("videoWatermark", String(input.watermark));
        applied.watermark = input.watermark;
    }
    const mode = input.mode === "frames" || input.mode === "reference" ? input.mode : references.length > 2 ? "reference" : undefined;
    if (mode) {
        configStore.updateConfig("videoMode", mode);
        applied.mode = mode;
    }
    const prompt = typeof input.prompt === "string" ? input.prompt : undefined;
    const run = input.run !== false;
    const page = resolveWorkbenchPage(typeof window !== "undefined" ? window.location.pathname : "");
    const sessionId = useAgentStore.getState().conversation.threadId || undefined;
    const canvasProjectId = context.canvasSnapshot?.projectId || undefined;
    navigate("/video");
    const taskId = useWorkbenchAgentStore.getState().dispatchVideo({
        prompt,
        ...(references.length ? { references } : {}),
        run,
        origin: "site-tool",
        page,
        ...(sessionId ? { sessionId } : {}),
        ...(canvasProjectId ? { canvasProjectId } : {}),
    });
    return {
        ok: true,
        navigated: "/video",
        prompt,
        run,
        taskId,
        applied,
        referenceCount: references.length,
        referenceMapping: references.map((ref, index) => ({ token: `[图${index + 1}]`, name: ref.name })),
        note: siteText(run ? "videoGenerationStarted" : "videoConfigApplied"),
    };
}

async function searchPrompts(input: SiteToolInput) {
    const page = Math.max(1, Math.floor(Number(input.page)) || 1);
    const pageSize = Math.max(1, Math.min(50, Math.floor(Number(input.pageSize)) || 20));
    const tags = Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string") : [];
    const result = await fetchPrompts({ keyword: String(input.keyword || ""), category: String(input.category || i18n.t("common.all")), tag: tags, page, pageSize });
    return {
        total: result.total,
        page,
        pageSize,
        categories: result.categories,
        tags: result.tags.slice(0, 60),
        items: result.items.map((prompt) => ({ id: prompt.id, title: prompt.title, prompt: prompt.prompt, category: prompt.category, tags: prompt.tags, coverUrl: prompt.coverUrl, githubUrl: prompt.githubUrl })),
    };
}

function listAssets(input: SiteToolInput) {
    const { assets, hydrated } = useAssetStore.getState();
    if (!hydrated) throw new Error(siteText("assetsLoading"));
    const kind = input.kind === "text" || input.kind === "image" || input.kind === "video" ? input.kind : "all";
    const keyword = String(input.keyword || "").trim().toLowerCase();
    const filtered = assets.filter((asset) => {
        if (kind !== "all" && asset.kind !== kind) return false;
        if (!keyword) return true;
        return [asset.title, asset.note, asset.source, ...asset.tags].filter(Boolean).join(" ").toLowerCase().includes(keyword);
    });
    const { page, pageSize, start, end } = paginate(input, filtered.length, 20);
    const items = filtered.slice(start, end).map((asset) => ({
        id: asset.id,
        kind: asset.kind,
        title: asset.title,
        tags: asset.tags,
        source: asset.source,
        note: asset.note,
        createdAt: asset.createdAt,
        updatedAt: asset.updatedAt,
        coverUrl: asset.coverUrl || undefined,
        content: asset.kind === "text" ? asset.data.content : undefined,
    }));
    return { total: filtered.length, page, pageSize, items };
}

async function addAsset(input: SiteToolInput) {
    const kind = input.kind;
    const title = String(input.title || "").trim();
    if (!title) throw new Error(siteText("assetTitleRequired"));
    const tags = Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string") : [];
    const source = typeof input.source === "string" ? input.source : "Agent";
    const note = typeof input.note === "string" ? input.note : undefined;
    const store = useAssetStore.getState();
    if (kind === "text") {
        const content = String(input.content || "").trim();
        if (!content) throw new Error(siteText("textContentRequired"));
        const id = store.addAsset({ kind: "text", title, coverUrl: "", tags, source, note, data: { content } });
        return { ok: true, id, kind: "text" };
    }
    if (kind === "image") {
        const imageUrl = String(input.imageUrl || "").trim();
        if (!imageUrl) throw new Error(siteText("imageUrlRequired"));
        let stored;
        try {
            stored = await uploadImage(imageUrl);
        } catch {
            throw new Error(siteText("imageReadFailed"));
        }
        const id = store.addAsset({ kind: "image", title, coverUrl: stored.url, tags, source, note, data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType } });
        return { ok: true, id, kind: "image" };
    }
    throw new Error(siteText("assetKindUnsupported"));
}

function paginate(input: SiteToolInput, total: number, defaultSize: number) {
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(input.pageSize)) || defaultSize));
    const maxPage = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(maxPage, Math.max(1, Math.floor(Number(input.page)) || 1));
    const start = (page - 1) * pageSize;
    return { page, pageSize, start, end: start + pageSize };
}

type StoredVideoLog = {
    id?: string;
    createdAt?: number;
    title?: string;
    prompt?: string;
    model?: string;
    status?: string;
    task?: { id?: string };
    references?: Array<{ name?: string; dataUrl?: string; storageKey?: string }>;
    video?: { url?: string; storageKey?: string; width?: number; height?: number };
};

const videoLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });

const VIDEO_QA_DIMENSIONS = [
    "人物一致性（五官、发型、服饰与原始定妆照比对）",
    "首尾与动作连贯性（起始帧是否贴合 [图1]、运动是否顺滑）",
    "物理与肢体合理性（手部、道具交互、空间透视无崩坏）",
    "场景与色调统一（光线、色彩与目标画幅无意外黑边）",
    "提示词遵循度（主体动作、镜头运动是否按描述发生）",
];

function getLiveCanvasContext(context: SiteToolContext): AgentCanvasContext | null {
    return context.canvasContext || useAgentStore.getState().canvasContext;
}

function requireCanvasSnapshot(context: SiteToolContext): CanvasAgentSnapshot {
    const snapshot = getLiveCanvasContext(context)?.snapshot || context.canvasSnapshot;
    if (!snapshot) throw new Error(siteText("openCanvasFirst"));
    return snapshot;
}

async function resolveNodeVideoUrl(node: CanvasNodeData): Promise<string> {
    const content = node.metadata?.content || "";
    const storageKey = node.metadata?.storageKey;
    return storageKey ? await resolveMediaUrl(storageKey, content) : content;
}

async function resolveNodeImageUrl(node: CanvasNodeData): Promise<string> {
    const content = node.metadata?.content || "";
    const storageKey = node.metadata?.storageKey;
    return storageKey ? await resolveImageUrl(storageKey, content) : content;
}

function isLikelyImageReference(value: string): boolean {
    if (!value) return false;
    if (value.startsWith("image:") || value.startsWith("data:image/")) return true;
    return /\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i.test(value);
}

async function resolveCanvasImageReferenceUrls(node: CanvasNodeData, snapshot: CanvasAgentSnapshot): Promise<Array<{ url: string; label: string }>> {
    const metaRefs = Array.isArray(node.metadata?.references) ? node.metadata.references.filter(isLikelyImageReference) : [];
    if (metaRefs.length) {
        const urls = await Promise.all(
            metaRefs.slice(0, VIDEO_MAX_REFERENCES).map(async (ref, idx) => ({
                url: ref.startsWith("image:") ? await resolveImageUrl(ref, "") : ref,
                label: `[图${idx + 1}]`,
            })),
        );
        return urls.filter((item) => Boolean(item.url));
    }
    const collected: CanvasNodeData[] = [];
    const seen = new Set<string>();
    const pushUpstream = (targetId: string, depth: number) => {
        if (depth > 2) return;
        for (const conn of snapshot.connections) {
            if (conn.toNodeId !== targetId) continue;
            const src = snapshot.nodes.find((n) => n.id === conn.fromNodeId);
            if (!src || seen.has(src.id)) continue;
            seen.add(src.id);
            if (src.type === CanvasNodeType.Image && (src.metadata?.content || src.metadata?.storageKey)) {
                collected.push(src);
            } else if (src.type === CanvasNodeType.Config) {
                pushUpstream(src.id, depth + 1);
            }
        }
    };
    pushUpstream(node.id, 0);
    const resolved = await Promise.all(
        collected.slice(0, VIDEO_MAX_REFERENCES).map(async (imgNode, idx) => ({
            url: await resolveNodeImageUrl(imgNode),
            label: `[图${idx + 1}]`,
        })),
    );
    return resolved.filter((item) => Boolean(item.url));
}

async function readWorkbenchVideoLogs(): Promise<StoredVideoLog[]> {
    const logs: StoredVideoLog[] = [];
    await videoLogStore.iterate<StoredVideoLog, void>((value) => {
        if (value) logs.push(value);
    });
    return logs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function inspectNodeVisual(input: SiteToolInput, context: SiteToolContext) {
    const snapshot = requireCanvasSnapshot(context);
    const nodeId = String(input.nodeId || "").trim();
    const node = snapshot.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error(siteText("nodeNotFound", { id: nodeId }));
    const maxEdge = Math.max(256, Math.min(1280, Math.floor(Number(input.maxEdge) || 1280)));

    if (node.type === CanvasNodeType.Image) {
        const url = await resolveNodeImageUrl(node);
        if (!url) throw new Error(siteText("nodeNoMedia", { title: node.title || node.id }));
        const encoded = await encodeImageToMcpJpeg(url, maxEdge);
        return {
            ok: true,
            nodeId: node.id,
            type: node.type,
            title: node.title,
            width: node.metadata?.naturalWidth || encoded.width,
            height: node.metadata?.naturalHeight || encoded.height,
            summary: `${node.title || node.id} (${encoded.width}x${encoded.height})`,
            _mcpImages: [{ mimeType: encoded.mimeType, data: encoded.dataBase64, label: `画布图片节点 ${node.title || node.id} (${node.id})` }],
        };
    }

    if (node.type === CanvasNodeType.Video) {
        const videoUrl = await resolveNodeVideoUrl(node);
        if (!videoUrl) throw new Error(siteText("nodeNoMedia", { title: node.title || node.id }));
        const frameCount = Math.max(3, Math.min(9, Math.floor(Number(input.frameCount) || 6)));
        const sheet = await captureVideoContactSheet(videoUrl, { frameCount, maxEdge });
        return {
            ok: true,
            nodeId: node.id,
            type: node.type,
            title: node.title,
            durationSeconds: sheet.durationSeconds,
            resolution: `${sheet.videoWidth}x${sheet.videoHeight}`,
            timestamps: sheet.timestamps,
            summary: `${node.title || node.id} (${sheet.durationSeconds}s, ${frameCount} 帧)`,
            _mcpImages: [{ mimeType: sheet.mimeType, data: sheet.dataBase64, label: `视频节点 ${node.title || node.id} ${frameCount} 帧接触表` }],
        };
    }

    return {
        ok: true,
        nodeId: node.id,
        type: node.type,
        title: node.title,
        prompt: node.metadata?.prompt || node.metadata?.composerContent,
        content: node.metadata?.content,
        model: node.metadata?.model,
        status: node.metadata?.status,
        summary: `${node.title || node.id} (${node.type})`,
    };
}

async function inspectVideoFrames(input: SiteToolInput, context: SiteToolContext) {
    const snapshot = getLiveCanvasContext(context)?.snapshot || context.canvasSnapshot || null;
    const nodeId = typeof input.nodeId === "string" ? input.nodeId.trim() : "";
    const taskId = typeof input.taskId === "string" ? input.taskId.trim() : "";
    const frameCount = Math.max(3, Math.min(9, Math.floor(Number(input.frameCount) || 6)));
    const maxEdge = Math.max(512, Math.min(1280, Math.floor(Number(input.maxEdge) || 1280)));
    const includeReferences = input.includeReferences !== false;

    let videoUrl = "";
    let prompt = "";
    let model = "";
    let title = "";
    let sourceKind: "canvas" | "video" = "video";
    let resolvedId = "";
    let referenceItems: Array<{ url: string; label: string }> = [];

    if (nodeId) {
        if (!snapshot) throw new Error(siteText("openCanvasFirst"));
        const node = snapshot.nodes.find((item) => item.id === nodeId);
        if (!node) throw new Error(siteText("nodeNotFound", { id: nodeId }));
        videoUrl = await resolveNodeVideoUrl(node);
        if (!videoUrl) throw new Error(siteText("nodeNoMedia", { title: node.title || node.id }));
        sourceKind = "canvas";
        resolvedId = node.id;
        title = node.title;
        prompt = node.metadata?.prompt || "";
        model = node.metadata?.model || "";
        if (includeReferences) referenceItems = await resolveCanvasImageReferenceUrls(node, snapshot);
    } else if (taskId) {
        const logs = await readWorkbenchVideoLogs();
        const agentTask = useWorkbenchAgentStore.getState().tasks.find((item) => item.id === taskId);
        const matched = logs.find((item) => item.id === taskId || item.task?.id === taskId)
            || (agentTask ? logs.find((item) => item.status === "success" && item.prompt === agentTask.prompt) : undefined);
        if (!matched?.video) throw new Error(siteText("videoNotFound"));
        videoUrl = matched.video.storageKey ? await resolveMediaUrl(matched.video.storageKey, matched.video.url || "") : (matched.video.url || "");
        if (!videoUrl) throw new Error(siteText("videoNotFound"));
        resolvedId = matched.id || taskId;
        title = matched.title || "";
        prompt = matched.prompt || "";
        model = matched.model || "";
        if (includeReferences && matched.references?.length) {
            referenceItems = (
                await Promise.all(
                    matched.references.slice(0, VIDEO_MAX_REFERENCES).map(async (ref, idx) => ({
                        url: await resolveImageUrl(ref.storageKey, ref.dataUrl || ""),
                        label: `[图${idx + 1}]`,
                    })),
                )
            ).filter((item) => Boolean(item.url));
        }
    } else {
        const canvasVideo = snapshot
            ? [...snapshot.nodes].reverse().find((node) => node.type === CanvasNodeType.Video && Boolean(node.metadata?.content))
            : undefined;
        if (canvasVideo) {
            videoUrl = await resolveNodeVideoUrl(canvasVideo);
            sourceKind = "canvas";
            resolvedId = canvasVideo.id;
            title = canvasVideo.title;
            prompt = canvasVideo.metadata?.prompt || "";
            model = canvasVideo.metadata?.model || "";
            if (includeReferences && snapshot) referenceItems = await resolveCanvasImageReferenceUrls(canvasVideo, snapshot);
        } else {
            const latest = (await readWorkbenchVideoLogs()).find((item) => item.status === "success" && item.video);
            if (!latest?.video) throw new Error(siteText("videoNotFound"));
            videoUrl = latest.video.storageKey ? await resolveMediaUrl(latest.video.storageKey, latest.video.url || "") : (latest.video.url || "");
            resolvedId = latest.id || "";
            title = latest.title || "";
            prompt = latest.prompt || "";
            model = latest.model || "";
            if (includeReferences && latest.references?.length) {
                referenceItems = (
                    await Promise.all(
                        latest.references.slice(0, VIDEO_MAX_REFERENCES).map(async (ref, idx) => ({
                            url: await resolveImageUrl(ref.storageKey, ref.dataUrl || ""),
                            label: `[图${idx + 1}]`,
                        })),
                    )
                ).filter((item) => Boolean(item.url));
            }
        }
    }

    if (!videoUrl) throw new Error(siteText("videoNotFound"));
    const sheet = await captureVideoContactSheet(videoUrl, { frameCount, maxEdge });
    const mcpImages: Array<{ mimeType: string; data: string; label?: string }> = [];
    let referenceCollageIncluded = false;

    if (includeReferences && referenceItems.length) {
        const refSheet = await buildReferenceContactSheet(referenceItems, maxEdge);
        if (refSheet) {
            referenceCollageIncluded = true;
            mcpImages.push({
                mimeType: refSheet.mimeType,
                data: refSheet.dataBase64,
                label: `输入参考图对照拼图（共 ${refSheet.count} 张，按 [图1]~[图${refSheet.count}] 顺序）`,
            });
        }
    }
    mcpImages.push({
        mimeType: sheet.mimeType,
        data: sheet.dataBase64,
        label: `成片 ${frameCount} 帧抽帧接触表（时长 ${sheet.durationSeconds}s，分辨率 ${sheet.videoWidth}x${sheet.videoHeight}）`,
    });

    return {
        ok: true,
        source: sourceKind,
        id: resolvedId,
        title,
        model,
        prompt: compactPrompt(prompt),
        durationSeconds: sheet.durationSeconds,
        resolution: `${sheet.videoWidth}x${sheet.videoHeight}`,
        frameCount,
        timestamps: sheet.timestamps,
        referenceCount: referenceItems.length,
        referenceCollageIncluded,
        qaDimensions: VIDEO_QA_DIMENSIONS,
        summary: `${title || resolvedId} · ${sheet.durationSeconds}s · ${frameCount} 帧`,
        _mcpImages: mcpImages,
    };
}

async function extractVideoFrameToCanvas(input: SiteToolInput, context: SiteToolContext) {
    const canvasContext = getLiveCanvasContext(context);
    if (!canvasContext) throw new Error(siteText("openCanvasFirst"));
    const nodeId = String(input.nodeId || "").trim();
    const node = canvasContext.snapshot.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error(siteText("nodeNotFound", { id: nodeId }));

    const videoUrl = await resolveNodeVideoUrl(node);
    if (!videoUrl) throw new Error(siteText("nodeNoMedia", { title: node.title || node.id }));

    const position = input.position === "first" || input.position === "time" ? input.position : "last";
    const seconds = Math.max(0, Number(input.seconds) || 0);
    const blob = await captureVideoFrame(videoUrl, position, seconds);
    const uploaded = await uploadImage(blob);
    const size = fitNodeSize(uploaded.width, uploaded.height, 640, 640);
    const newNodeId = `image-${nanoid(10)}`;
    const x = typeof input.x === "number" ? input.x : node.position.x + node.width + 96;
    const y = typeof input.y === "number" ? input.y : node.position.y;
    const defaultTitle = `${node.title || "Video"} (${position === "first" ? "首帧" : position === "time" ? `${seconds}s` : "尾帧"})`;
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : defaultTitle;

    const ops: CanvasAgentOp[] = [
        {
            type: "add_node",
            id: newNodeId,
            nodeType: CanvasNodeType.Image,
            title,
            position: { x, y },
            width: size.width,
            height: size.height,
            metadata: imageMetadata(uploaded),
        },
        ...(input.connect !== false ? [{ type: "connect_nodes" as const, fromNodeId: node.id, toNodeId: newNodeId }] : []),
        { type: "select_nodes", ids: [newNodeId] },
    ];
    const nextSnapshot = canvasContext.applyOps(ops);
    context.syncCanvasState?.(nextSnapshot);

    const mcpImages: Array<{ mimeType: string; data: string; label?: string }> = [];
    if (input.inspect !== false) {
        const encoded = await encodeImageToMcpJpeg(uploaded.url, 1280);
        mcpImages.push({
            mimeType: encoded.mimeType,
            data: encoded.dataBase64,
            label: `已截取视频帧节点 ${title} (${newNodeId})`,
        });
    }

    return {
        ok: true,
        nodeId: newNodeId,
        sourceNodeId: node.id,
        position,
        title,
        width: uploaded.width,
        height: uploaded.height,
        ...(mcpImages.length ? { _mcpImages: mcpImages } : {}),
    };
}
