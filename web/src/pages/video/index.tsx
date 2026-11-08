import { ArrowLeft, ArrowRight, BookOpen, ClipboardPaste, Download, FolderPlus, LoaderCircle, Menu, SlidersHorizontal, Sparkles, SquarePen, Trash2, Upload, VideoIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { App, Button, Checkbox, Drawer, Input, Modal, Tooltip, Typography } from "antd";
import localforage from "localforage";
import { nanoid } from "nanoid";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { VideoSettingsPanel, normalizeVideoResolutionValue, normalizeVideoSizeValue, videoModeLabel, videoSizeLabel } from "@/components/video-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { clampVideoSeconds } from "@/lib/media-size";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { cn } from "@/lib/utils";
import { deleteStoredMedia, resolveMediaUrl } from "@/services/file-storage";
import { resolveImageUrl, ensureImagePreview, getImagePreviewRevision, previewUrlFor, subscribeImagePreviews, uploadImage } from "@/services/image-storage";
import { createVideoGenerationTask, pollVideoGenerationTask, storeGeneratedVideo, type VideoGenerationTask } from "@/services/api/video";
import { useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { useConversationAgentStore } from "@/stores/use-conversation-agent-store";
import { useQuotaStore } from "@/stores/use-quota-store";
import { boolConfig, modelOptionLabel, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ReferenceImage } from "@/types/image";
import i18n from "@/i18n";

type GeneratedVideo = {
    id: string;
    url: string;
    storageKey: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

type GenerationResult = {
    id: string;
    status: "pending" | "success" | "failed";
    video?: GeneratedVideo;
    error?: string;
};

type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    size: string;
    resolution: string;
    seconds: string;
    status: "pending" | "success" | "failed";
    task?: VideoGenerationTask;
    video?: GeneratedVideo;
    error?: string;
};

type GenerationLogConfig = Pick<AiConfig, "model" | "videoModel" | "size" | "vquality" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark" | "videoMode">;

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

const LOG_STORE_KEY = "infinite-canvas:video_generation_logs";
const logStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });

export default function VideoPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dragDepthRef = useRef(0);
    const activeLogIdsRef = useRef<Set<string>>(new Set());
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const [prompt, setPrompt] = useState("");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [running, setRunning] = useState(false);
    const [logsOpen, setLogsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [startedAt, setStartedAt] = useState(0);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [referenceDragTarget, setReferenceDragTarget] = useState(false);
    const [autoRunToken, setAutoRunToken] = useState(0);
    const videoCommand = useWorkbenchAgentStore((state) => state.videoCommand);
    const clearVideoCommand = useWorkbenchAgentStore((state) => state.clearVideoCommand);
    const updateAgentTask = useWorkbenchAgentStore((state) => state.updateTask);
    const navigate = useNavigate();
    const setLaunchContext = useConversationAgentStore((state) => state.setLaunchContext);
    const processedCommandRef = useRef(0);
    const agentTaskIdRef = useRef<string | undefined>(undefined);

    const model = effectiveConfig.videoModel || effectiveConfig.model;
    const canGenerate = Boolean(prompt.trim());

    useEffect(() => {
        if (!running || !startedAt) return;
        const timer = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 1000);
        return () => window.clearInterval(timer);
    }, [running, startedAt]);

    useEffect(() => {
        void refreshLogs();
    }, []);

    const addReferences = async (files?: FileList | null) => {
        const selectedFiles = Array.from(files || []);
        const unsupported = selectedFiles.filter((file) => !file.type.startsWith("image/"));
        if (unsupported.length) message.warning(t("videoWorkbench.unsupportedFiles"));
        const imageFiles = selectedFiles.filter((file) => file.type.startsWith("image/")).slice(0, 7 - references.length);
        const nextReferences = await Promise.all(
            imageFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
            }),
        );
        setReferences((value) => [...value, ...nextReferences].slice(0, 7));
    };

    const handleReferenceDragEnter = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current += 1;
        if (event.dataTransfer.types.includes("Files")) setReferenceDragTarget(true);
    };

    const handleReferenceDragLeave = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (!dragDepthRef.current) setReferenceDragTarget(false);
    };

    const handleReferenceDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current = 0;
        setReferenceDragTarget(false);
        void addReferences(event.dataTransfer.files);
    };

    const addReferencesFromClipboard = async () => {
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) {
                message.error(t("videoWorkbench.clipboardEmpty"));
                return;
            }
            const nextReferences = await Promise.all(
                blobs.slice(0, 7 - references.length).map(async (blob, index) => {
                    const image = await uploadImage(blob);
                    return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            setReferences((value) => [...value, ...nextReferences].slice(0, 7));
            message.success(t("videoWorkbench.clipboardAdded", { count: nextReferences.length }));
        } catch {
            message.error(t("videoWorkbench.clipboardEmpty"));
        }
    };
    const generate = async () => {
        const agentTaskId = agentTaskIdRef.current;
        agentTaskIdRef.current = undefined;
        const snapshot = buildRequestSnapshot();
        if (!snapshot) {
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("videoWorkbench.invalidParams") });
            return;
        }
        setElapsedMs(0);
        setRunning(true);
        if (agentTaskId) updateAgentTask(agentTaskId, { status: "running", error: undefined });
        setPreviewLog(null);
        setResults([{ id: nanoid(), status: "pending" }]);
        const batchStartedAt = performance.now();
        setStartedAt(batchStartedAt);
        try {
            const task = await createVideoGenerationTask(snapshot.config, snapshot.text, snapshot.references);
            const log = buildLog({ prompt: snapshot.text, model, config: snapshot.config, references: snapshot.references, durationMs: 0, status: "pending", task });
            await saveLog(log, false);
            void pollGenerationLog(log, snapshot.config, agentTaskId);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : t("workbench.generationFailed");
            setResults([{ id: nanoid(), status: "failed", error: errorMessage }]);
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", successCount: 0, failCount: 1, error: errorMessage });
            await saveLog(buildLog({ prompt: snapshot.text, model, config: snapshot.config, references: snapshot.references, durationMs: performance.now() - batchStartedAt, status: "failed", error: errorMessage }));
            message.error(errorMessage);
            setRunning(false);
        }
    };

    // Handle video-generation commands from the Agent panel by setting the prompt and optionally starting generation.
    useEffect(() => {
        if (!videoCommand || videoCommand.nonce === processedCommandRef.current) return;
        processedCommandRef.current = videoCommand.nonce;
        clearVideoCommand();
        if (typeof videoCommand.prompt === "string") setPrompt(videoCommand.prompt);
        if (videoCommand.run && running) {
            if (videoCommand.taskId) updateAgentTask(videoCommand.taskId, { status: "failed", error: t("videoWorkbench.busy") });
            return;
        }
        if (videoCommand.run) {
            agentTaskIdRef.current = videoCommand.taskId;
            setAutoRunToken((value) => value + 1);
        }
    }, [videoCommand, clearVideoCommand, running, updateAgentTask]);

    useEffect(() => {
        if (!autoRunToken) return;
        void generate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRunToken]);

    const buildRequestSnapshot = () => {
        const text = prompt.trim();
        if (!text) {
            message.error(t("videoWorkbench.promptRequired"));
            return null;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning(t("workbench.configFirst"));
            openConfigDialog(true);
            return null;
        }
        return { text, config: buildVideoConfig(effectiveConfig, model), references: [...references] };
    };

    const retryResult = () => {
        void generate();
    };

    const downloadVideo = (video: GeneratedVideo) => {
        saveAs(video.url, "video.mp4");
    };

    const saveResultToAssets = (video: GeneratedVideo) => {
        addAsset({
            kind: "video",
            title: t("videoWorkbench.resultTitle"),
            coverUrl: "",
            tags: [],
            source: t("videoWorkbench.source"),
            data: { url: video.url, storageKey: video.storageKey, width: video.width, height: video.height, bytes: video.bytes, mimeType: video.mimeType },
            metadata: { source: "video-page", prompt },
        });
        message.success(t("common.addedToAssets"));
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image") {
            const stored = await uploadImage(payload.dataUrl);
            setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }].slice(0, 7));
        }
        setAssetPickerOpen(false);
    };

    const createSession = () => {
        setPrompt("");
        setReferences([]);
        setResults([]);
        setElapsedMs(0);
        setStartedAt(0);
        setSelectedLogIds([]);
        setPreviewLog(null);
    };

    const deleteSelectedLogs = () => {
        const mediaKeys = logs
            .filter((log) => selectedLogIds.includes(log.id))
            .map((log) => log.video?.storageKey)
            .filter((key): key is string => Boolean(key));
        void Promise.all([deleteStoredMedia(mediaKeys), ...selectedLogIds.map((id) => logStore.removeItem(id))]).then(() => refreshLogs());
        if (previewLog && selectedLogIds.includes(previewLog.id)) {
            setPreviewLog(null);
            setResults([]);
        }
        setSelectedLogIds([]);
        setDeleteConfirmOpen(false);
    };

    const saveLog = async (log: GenerationLog, resumePending = true) => {
        await logStore.setItem(log.id, serializeLog(log));
        await refreshLogs(resumePending);
    };

    const refreshLogs = async (resumePending = true) => {
        const nextLogs = await readStoredLogs();
        setLogs(nextLogs);
        if (resumePending) resumePendingLogs(nextLogs);
        return nextLogs;
    };

    const resumePendingLogs = (items: GenerationLog[]) => {
        for (const log of items) {
            if (log.status === "pending" && log.task) void pollGenerationLog(log);
        }
    };

    const pollGenerationLog = async (log: GenerationLog, configOverride?: AiConfig, agentTaskId?: string) => {
        if (!log.task || activeLogIdsRef.current.has(log.id)) return;
        activeLogIdsRef.current.add(log.id);
        setRunning(true);
        setStartedAt((value) => value || performance.now());
        setResults((value) => (value.length ? value : [{ id: log.id, status: "pending" }]));
        const taskConfig = buildVideoConfig({ ...effectiveConfig, ...log.config }, log.task.model || log.model);
        try {
            for (let attempt = 0; attempt < 120; attempt += 1) {
                const state = await pollVideoGenerationTask(configOverride || taskConfig, log.task);
                if (state.status === "completed") {
                    const stored = await storeGeneratedVideo(state.result);
                    const nextVideo: GeneratedVideo = {
                        id: nanoid(),
                        url: stored.url,
                        storageKey: stored.storageKey,
                        durationMs: Date.now() - log.createdAt,
                        width: stored.width || 1280,
                        height: stored.height || 720,
                        bytes: stored.bytes,
                        mimeType: stored.mimeType,
                    };
                    setResults([{ id: nextVideo.id, status: "success", video: nextVideo }]);
                    if (agentTaskId) updateAgentTask(agentTaskId, { status: "succeeded", successCount: 1, failCount: 0, error: undefined });
                    await saveLog({ ...log, status: "success", durationMs: nextVideo.durationMs, video: nextVideo, error: undefined });
                    message.success(t("videoWorkbench.generated"));
                    return;
                }
                if (state.status === "failed") throw new Error(state.error);
                if (attempt === 119) throw new Error(t("videoWorkbench.timeout"));
                await delay(2500);
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : t("workbench.generationFailed");
            setResults([{ id: log.id, status: "failed", error: errorMessage }]);
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", successCount: 0, failCount: 1, error: errorMessage });
            await saveLog({ ...log, status: "failed", durationMs: Date.now() - log.createdAt, error: errorMessage });
            message.error(errorMessage);
        } finally {
            activeLogIdsRef.current.delete(log.id);
            if (!activeLogIdsRef.current.size) {
                setRunning(false);
                setStartedAt(0);
            }
        }
    };

    const previewGenerationLog = (log: GenerationLog) => {
        setPreviewLog(log);
        setLogsOpen(false);
        setPrompt(log.prompt);
        setReferences(log.references || []);
        if (log.config.videoModel || log.model) updateConfig("videoModel", log.config.videoModel || log.model);
        if (log.config.size) updateConfig("size", log.config.size);
        if (log.config.vquality) updateConfig("vquality", log.config.vquality);
        if (log.config.videoSeconds) updateConfig("videoSeconds", log.config.videoSeconds);
        if (log.config.videoGenerateAudio) updateConfig("videoGenerateAudio", log.config.videoGenerateAudio);
        if (log.config.videoWatermark) updateConfig("videoWatermark", log.config.videoWatermark);
        if (log.config.videoMode) updateConfig("videoMode", log.config.videoMode);
        setResults(log.status === "pending" ? [{ id: log.id, status: "pending" }] : log.video ? [{ id: log.video.id, status: "success", video: log.video }] : [{ id: log.id, status: "failed", error: log.error || t("workbench.generationFailed") }]);
    };

    return (
        <div className="agent-page-in flex h-full min-h-0 bg-[#faf9f5] text-stone-900 dark:bg-[#1c1b19] dark:text-stone-100">
            <aside className="hidden w-[252px] shrink-0 border-r border-stone-200/70 bg-[#f2efe8] lg:block dark:border-stone-800 dark:bg-[#171614]">
                <LogPanel
                    modelLabel={effectiveConfig.videoModel.split("::").pop() || effectiveConfig.videoModel}
                    chip="VIDEO"
                    quotaCapability="video"
                    logs={logs}
                    selectedLogIds={selectedLogIds}
                    activeLogId={previewLog?.id}
                    onSelectedLogIdsChange={setSelectedLogIds}
                    onCreateSession={createSession}
                    onDeleteSelected={() => setDeleteConfirmOpen(true)}
                    onPreviewLog={previewGenerationLog}
                />
            </aside>

            <main className="flex min-w-0 flex-1 flex-col">
                <div className="flex h-12 shrink-0 items-center gap-2 px-3 lg:hidden">
                    <Button size="small" type="text" icon={<Menu className="size-4" />} onClick={() => setLogsOpen(true)} />
                    <span className="text-sm font-semibold">{t("videoWorkbench.title")}</span>
                    <Button className="ml-auto sm:hidden" size="small" type="text" icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)} />
                </div>

                <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[420px_minmax(0,1fr)] lg:overflow-hidden">
                    <div className="thin-scrollbar flex flex-col border-stone-200/70 px-5 py-5 dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto lg:border-r">
                        <div className="space-y-5">
                            <div>
                                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                    <span className="shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-400/90 dark:text-stone-500">{t("workbench.prompt")}</span>
                                    <div className="flex flex-wrap items-center justify-end gap-1">
                                        <button
                                            type="button"
                                            className="flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] text-stone-500 transition-all duration-150 hover:bg-black/[.05] hover:text-stone-700 active:scale-95 dark:text-stone-400 dark:hover:bg-white/[.06] dark:hover:text-stone-200"
                                            onClick={() => {
                                                setLaunchContext({ page: "video", prompt, model });
                                                navigate("/chat");
                                            }}
                                        >
                                            <Sparkles className="size-3.5 text-amber-500" />
                                            {t("chat.workbenchEntry")}
                                        </button>
                                        <button type="button" className="flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] text-stone-500 transition-all duration-150 hover:bg-black/[.05] hover:text-stone-700 active:scale-95 dark:text-stone-400 dark:hover:bg-white/[.06] dark:hover:text-stone-200" onClick={() => setPromptDialogOpen(true)}>
                                            <BookOpen className="size-3.5" />
                                            {t("workbench.viewPrompts")}
                                        </button>
                                        <button type="button" className="flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] text-stone-500 transition-all duration-150 hover:bg-black/[.05] hover:text-stone-700 active:scale-95 dark:text-stone-400 dark:hover:bg-white/[.06] dark:hover:text-stone-200" onClick={() => setAssetPickerOpen(true)}>
                                            <FolderPlus className="size-3.5" />
                                            {t("workbench.viewAssets")}
                                        </button>
                                    </div>
                                </div>
                                <div className="rounded-2xl border border-stone-300/80 bg-white p-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-all duration-200 focus-within:border-stone-400/80 focus-within:shadow-[0_2px_14px_rgba(0,0,0,0.06)] dark:border-stone-700 dark:bg-stone-900 dark:focus-within:border-stone-600">
                                    <Input.TextArea variant="borderless" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} className="!px-1 !py-1 !text-sm font-serif" placeholder={t("videoWorkbench.promptPlaceholder")} />
                                </div>
                            </div>

                            <div className="min-w-0">
                                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                    <span className="shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-400/90 dark:text-stone-500">{t("videoWorkbench.references")}</span>
                                    <div className="flex flex-wrap items-center gap-1">
                                        <button type="button" className="flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] text-stone-500 transition-all duration-150 hover:bg-black/[.05] hover:text-stone-700 active:scale-95 dark:text-stone-400 dark:hover:bg-white/[.06] dark:hover:text-stone-200" onClick={() => void addReferencesFromClipboard()}>
                                            <ClipboardPaste className="size-3.5" />
                                            {t("workbench.clipboard")}
                                        </button>
                                        <button type="button" className="flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] text-stone-500 transition-all duration-150 hover:bg-black/[.05] hover:text-stone-700 active:scale-95 dark:text-stone-400 dark:hover:bg-white/[.06] dark:hover:text-stone-200" onClick={() => fileInputRef.current?.click()}>
                                            <Upload className="size-3.5" />
                                            {t("workbench.upload")}
                                        </button>
                                    </div>
                                </div>
                                <div
                                    className={`hover-scrollbar hover-scrollbar-hint flex min-h-18 w-full min-w-0 max-w-full gap-2.5 overflow-x-scroll overflow-y-hidden rounded-2xl border border-dashed p-2.5 pb-3 overscroll-x-contain transition-colors ${
                                        referenceDragTarget ? "border-stone-400 bg-white/70 dark:border-stone-500 dark:bg-white/[.06]" : "border-stone-300/80 dark:border-stone-700/80"
                                    }`}
                                    onDragEnter={handleReferenceDragEnter}
                                    onDragOver={(event) => {
                                        event.preventDefault();
                                        event.dataTransfer.dropEffect = "copy";
                                    }}
                                    onDragLeave={handleReferenceDragLeave}
                                    onDrop={handleReferenceDrop}
                                >
                                    {references.map((item, index) => (
                                        <div key={item.id} className="group relative size-18 shrink-0 overflow-hidden rounded-xl border border-stone-200/90 shadow-xs dark:border-stone-700/90">
                                            <img src={previewUrlFor(item.storageKey) || item.dataUrl} alt={item.name} className="size-full object-cover" />
                                            <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[9px] font-medium text-white backdrop-blur-sm">{index + 1}</span>
                                            <ReferenceOrderButtons index={index} total={references.length} onMove={(offset) => setReferences((value) => moveListItem(value, index, offset))} />
                                            <button
                                                type="button"
                                                className="absolute right-1 top-1 hidden size-5 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm transition hover:scale-110 hover:bg-black/80 group-hover:flex"
                                                onClick={() => setReferences((value) => value.filter((ref) => ref.id !== item.id))}
                                                aria-label={t("videoWorkbench.removeImage")}
                                            >
                                                <Trash2 className="size-3" />
                                            </button>
                                        </div>
                                    ))}
                                    {!references.length ? (
                                        <div className="flex min-w-full items-center justify-center py-2 text-xs text-stone-400 dark:text-stone-500">
                                            {referenceDragTarget ? t("videoWorkbench.dropReferences") : t("videoWorkbench.noImages")}
                                        </div>
                                    ) : null}
                                </div>
                            </div>

                            <div className="flex items-center justify-between gap-3 rounded-xl border border-stone-200/80 bg-white/60 px-3 py-2 text-[11px] text-stone-500 dark:border-stone-800 dark:bg-white/[.03] dark:text-stone-400 sm:hidden">
                                <span className="min-w-0 truncate">
                                    {model.split("::").pop() || model} · {normalizeResolution(effectiveConfig.vquality)}p · {videoSizeLabel(effectiveConfig.size)} · {normalizeVideoSeconds(effectiveConfig.videoSeconds)}s · {videoModeLabel(effectiveConfig.videoMode)}
                                </span>
                                <button type="button" className="flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] text-stone-500 transition-all duration-150 hover:bg-black/[.05] hover:text-stone-700 active:scale-95 dark:text-stone-400 dark:hover:bg-white/[.06] dark:hover:text-stone-200" onClick={() => setSettingsOpen(true)}>
                                    <SlidersHorizontal className="size-3.5" />
                                    {t("workbench.adjust")}
                                </button>
                            </div>

                            <div className="hidden rounded-2xl border border-stone-200/80 bg-white/60 p-3 dark:border-stone-800 dark:bg-white/[.03] sm:grid sm:grid-cols-2 sm:gap-4">
                                <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                            </div>
                        </div>

                        <div className="sticky bottom-0 z-10 -mx-5 mt-auto bg-gradient-to-t from-[#faf9f5] via-[#faf9f5]/95 to-transparent px-5 pb-2 pt-8 dark:from-[#1c1b19] dark:via-[#1c1b19]/95">
                            <Button
                                type="primary"
                                size="large"
                                block
                                className="!h-11 !rounded-xl !bg-[#1f1e1d] hover:!bg-[#33312c] !text-white dark:!bg-[#f2efe8] dark:!text-stone-900 dark:hover:!bg-white !border-none !font-medium !shadow-2xs hover:!shadow-xs transition-all duration-200 active:scale-[0.99]"
                                icon={<Sparkles className="size-4" />}
                                loading={running}
                                disabled={!canGenerate || running}
                                onClick={() => void generate()}
                            >
                                {running ? t("workbench.generating") : t("workbench.generate")}
                            </Button>
                        </div>
                    </div>

                    <div className="thin-scrollbar px-5 py-5 lg:min-h-0 lg:overflow-y-auto">
                        <div className="mb-4 flex items-center justify-between gap-3">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-400/90 dark:text-stone-500">{t("workbench.results")}</span>
                                {results.length ? <span className="font-mono text-[10px] tabular-nums text-stone-400 dark:text-stone-500">{results.length}</span> : null}
                            </div>
                            {running ? <span className="font-mono text-[10px] tabular-nums text-stone-400 dark:text-stone-500">{t("workbench.waiting", { time: formatDuration(elapsedMs) })}</span> : null}
                        </div>
                        {results.length ? (
                            <div className="grid gap-3.5">
                                {results.map((result) => (result.status === "success" && result.video ? <ResultVideoCard key={result.id} video={result.video} onDownload={downloadVideo} onSaveAsset={saveResultToAssets} /> : result.status === "failed" ? <FailedVideoCard key={result.id} error={result.error || t("workbench.generationFailed")} onRetry={retryResult} /> : <PendingVideoCard key={result.id} />))}
                            </div>
                        ) : (
                            <div className="flex min-h-[320px] flex-col items-center justify-center px-4 py-16 text-center lg:min-h-[520px]">
                                <div className="relative mb-6 flex size-14 items-center justify-center">
                                    <div className="absolute inset-0 rounded-full bg-stone-200/60 blur-md dark:bg-stone-700/40" />
                                    <div className="relative flex size-12 items-center justify-center rounded-2xl border border-stone-200/90 bg-gradient-to-b from-white to-stone-100/90 shadow-xs dark:border-stone-700/80 dark:from-stone-800 dark:to-stone-900">
                                        <VideoIcon className="size-5 text-stone-600 dark:text-stone-300" />
                                    </div>
                                </div>
                                <h1 className="font-serif text-[24px] font-normal leading-tight tracking-tight text-stone-900 dark:text-stone-100">{t("videoWorkbench.empty")}</h1>
                            </div>
                        )}
                    </div>
                </div>
            </main>

            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    void addReferences(event.target.files);
                    event.target.value = "";
                }}
            />
            <Drawer open={logsOpen} placement="left" width={272} onClose={() => setLogsOpen(false)} styles={{ body: { padding: 0, background: "var(--color-card)" } }}>
                <LogPanel
                    modelLabel={effectiveConfig.videoModel.split("::").pop() || effectiveConfig.videoModel}
                    chip="VIDEO"
                    quotaCapability="video"
                    logs={logs}
                    selectedLogIds={selectedLogIds}
                    activeLogId={previewLog?.id}
                    onSelectedLogIdsChange={setSelectedLogIds}
                    onCreateSession={() => {
                        createSession();
                        setLogsOpen(false);
                    }}
                    onDeleteSelected={() => setDeleteConfirmOpen(true)}
                    onPreviewLog={previewGenerationLog}
                />
            </Drawer>
            <Drawer title={t("workbench.settings")} placement="right" width={420} open={settingsOpen} onClose={() => setSettingsOpen(false)}>
                <div className="grid grid-cols-1 gap-3 pb-4">
                    <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                </div>
            </Drawer>
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
            <Modal title={t("workbench.deleteLogs")} open={deleteConfirmOpen} onCancel={() => setDeleteConfirmOpen(false)} onOk={deleteSelectedLogs} okText={t("common.delete")} okButtonProps={{ danger: true }} cancelText={t("common.cancel")}>
                {t("workbench.deleteLogsConfirm", { count: selectedLogIds.length })}
            </Modal>
        </div>
    );
}

function GenerationSettings({ config, model, updateConfig, openConfigDialog }: { config: AiConfig; model: string; updateConfig: UpdateAiConfig; openConfigDialog: (shouldPromptContinue?: boolean) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();

    return (
        <>
            <label className="col-span-2 block min-w-0 sm:col-span-1">
                <span className="mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base">{t("workbench.model")}</span>
                <ModelPicker config={config} value={model} onChange={(value) => updateConfig("videoModel", value)} capability="video" fullWidth onMissingConfig={() => openConfigDialog(false)} />
            </label>
            <div className="col-span-2">
                <VideoSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-4" />
            </div>
        </>
    );
}

function ResultVideoCard({ video, onDownload, onSaveAsset }: { video: GeneratedVideo; onDownload: (video: GeneratedVideo) => void; onSaveAsset: (video: GeneratedVideo) => void }) {
    const { t } = useTranslation();
    return (
        <div className="group relative overflow-hidden rounded-2xl bg-black shadow-xs transition-all duration-300 hover:shadow-md">
            <video src={video.url} controls className="aspect-video w-full object-contain" />
            <div className="absolute left-2.5 top-2.5 flex flex-wrap items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                <span className="rounded-full bg-black/45 px-2 py-0.5 font-mono text-[10px] tabular-nums text-white/90 backdrop-blur-sm">
                    {video.width}x{video.height}
                </span>
                <span className="rounded-full bg-black/45 px-2 py-0.5 font-mono text-[10px] tabular-nums text-white/90 backdrop-blur-sm">{formatBytes(video.bytes)}</span>
                <span className="rounded-full bg-black/45 px-2 py-0.5 font-mono text-[10px] tabular-nums text-white/90 backdrop-blur-sm">{formatDuration(video.durationMs)}</span>
            </div>
            <div className="absolute right-2.5 top-2.5 flex items-center gap-0.5 rounded-full bg-black/55 px-1 py-0.5 text-white opacity-0 shadow-md backdrop-blur-md transition-opacity duration-200 group-hover:opacity-100 dark:bg-black/70" onClick={(event) => event.stopPropagation()}>
                <Tooltip title={t("common.addToAssets")}>
                    <button type="button" className="flex size-6 items-center justify-center rounded-full text-white/80 transition hover:bg-white/20 hover:text-white" onClick={() => onSaveAsset(video)}>
                        <FolderPlus className="size-3.5" />
                    </button>
                </Tooltip>
                <Tooltip title={t("common.download")}>
                    <button type="button" className="flex size-6 items-center justify-center rounded-full text-white/80 transition hover:bg-white/20 hover:text-white" onClick={() => onDownload(video)}>
                        <Download className="size-3.5" />
                    </button>
                </Tooltip>
            </div>
        </div>
    );
}

function PendingVideoCard() {
    const { t } = useTranslation();
    return (
        <div className="relative aspect-video overflow-hidden rounded-2xl bg-stone-100/50 dark:bg-stone-900/40">
            <div className="agent-shimmer absolute inset-0" />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                <LoaderCircle className="size-5 animate-spin" />
                <span>{t("workbench.generating")}</span>
            </div>
        </div>
    );
}

function FailedVideoCard({ error, onRetry }: { error: string; onRetry: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="overflow-hidden rounded-2xl border border-red-200/80 bg-red-50/60 dark:border-red-950 dark:bg-red-950/20">
            <div className="flex aspect-video flex-col items-center justify-center gap-3 p-5 text-center">
                <div className="text-sm font-medium text-red-600 dark:text-red-300">{t("workbench.failed")}</div>
                <Typography.Paragraph ellipsis={{ rows: 4 }} className="!mb-0 !text-xs !text-red-500 dark:!text-red-300">
                    {error}
                </Typography.Paragraph>
            </div>
            <div className="flex justify-end border-t border-red-200 p-3 dark:border-red-950">
                <Button size="small" danger onClick={onRetry}>
                    {t("workbench.retry")}
                </Button>
            </div>
        </div>
    );
}

function LogPanel({
    logs,
    selectedLogIds,
    activeLogId,
    modelLabel,
    chip,
    quotaCapability,
    onSelectedLogIdsChange,
    onCreateSession,
    onDeleteSelected,
    onPreviewLog,
}: {
    logs: GenerationLog[];
    selectedLogIds: string[];
    activeLogId?: string;
    modelLabel?: string;
    chip: string;
    quotaCapability?: "image" | "video";
    onSelectedLogIdsChange: (ids: string[]) => void;
    onCreateSession: () => void;
    onDeleteSelected: () => void;
    onPreviewLog: (log: GenerationLog) => void;
}) {
    const { t } = useTranslation();
    const quotaStatus = useQuotaStore((state) => state.status);
    const usage = quotaCapability ? quotaStatus?.capabilities?.[quotaCapability] : undefined;
    const quotaHint = usage && usage.dailyLimit > 0 ? t("workbench.quotaHint", { used: usage.dailyUsed, limit: usage.dailyLimit }) : "";
    const allSelected = Boolean(logs.length) && selectedLogIds.length === logs.length;
    const toggleAll = () => onSelectedLogIdsChange(allSelected ? [] : logs.map((log) => log.id));

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 px-3 pb-1 pt-4">
                <div className="flex items-center gap-2 px-1 pb-4">
                    <span
                        className="size-5 shrink-0 bg-stone-800 dark:bg-stone-100"
                        style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }}
                    />
                    <span className="text-[13px] font-semibold tracking-tight text-stone-900 dark:text-stone-100">{t("meta.title")}</span>
                    <span className="rounded border border-stone-300/80 px-1 font-mono text-[9px] uppercase tracking-widest text-stone-400 dark:border-stone-700 dark:text-stone-500">{chip}</span>
                </div>
                <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] text-stone-600 transition hover:bg-black/[.045] dark:text-stone-300 dark:hover:bg-white/[.06]"
                    onClick={onCreateSession}
                >
                    <SquarePen className="size-4 text-stone-500 dark:text-stone-400" />
                    {t("workbench.new")}
                </button>
                <div className="mt-5 flex items-center justify-between gap-2 px-2">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-400/90 dark:text-stone-500">{t("workbench.logs")}</span>
                    <div className="flex items-center gap-1.5">
                        <span className="text-[10px] tabular-nums text-stone-400 dark:text-stone-500">{logs.length}</span>
                        <button type="button" className="rounded px-1 text-[10px] font-medium text-stone-400 transition hover:text-stone-700 disabled:opacity-40 dark:text-stone-500 dark:hover:text-stone-200" disabled={!logs.length} onClick={toggleAll}>
                            {allSelected ? t("common.cancel") : t("workbench.selectAll")}
                        </button>
                        <button type="button" className="rounded px-1 text-[10px] font-medium text-stone-400 transition hover:text-red-500 disabled:opacity-40 dark:text-stone-500 dark:hover:text-red-400" disabled={!selectedLogIds.length} onClick={onDeleteSelected}>
                            {t("common.delete")}
                        </button>
                    </div>
                </div>
            </div>
            <div className="hover-scrollbar min-h-0 flex-1 space-y-px overflow-y-auto px-2 pb-3">
                {logs.map((log) => (
                    <LogCard
                        key={log.id}
                        log={log}
                        selected={selectedLogIds.includes(log.id)}
                        active={activeLogId === log.id}
                        selectionActive={selectedLogIds.length > 0}
                        onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))}
                        onClick={() => onPreviewLog(log)}
                    />
                ))}
                {!logs.length ? <div className="px-2 py-6 text-center text-xs text-stone-400 dark:text-stone-500">{t("workbench.noLogs")}</div> : null}
            </div>
            <div className="shrink-0 border-t border-stone-200/70 px-3 py-3 dark:border-stone-800">
                <div className="flex items-center gap-2 text-[11px] text-stone-500 dark:text-stone-400">
                    <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                    <span className="min-w-0 truncate font-mono">{modelLabel || "-"}</span>
                    {quotaHint ? <span className="ml-auto shrink-0 tabular-nums text-stone-400 dark:text-stone-500">{quotaHint}</span> : null}
                </div>
            </div>
        </div>
    );
}

function LogCard({ log, selected, active, selectionActive, onSelectedChange, onClick }: { log: GenerationLog; selected: boolean; active: boolean; selectionActive: boolean; onSelectedChange: (checked: boolean) => void; onClick: () => void }) {
    const { t } = useTranslation();
    return (
        <div className={cn("group flex items-start gap-1 rounded-lg px-2 py-2 transition-colors", active ? "bg-black/[.06] dark:bg-white/[.08]" : "hover:bg-black/[.04] dark:hover:bg-white/[.05]")}>
            <Checkbox className={cn("mt-0.5 shrink-0 transition-opacity", selected || selectionActive ? "opacity-100" : "opacity-0 group-hover:opacity-100")} checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => onSelectedChange(event.target.checked)} />
            <button type="button" className="min-w-0 flex-1 text-left" onClick={onClick}>
                <div className="flex items-center gap-2">
                    <span className={cn("min-w-0 flex-1 truncate text-[13px] leading-5", selected ? "text-stone-900 dark:text-stone-100" : "text-stone-600 dark:text-stone-300")}>{log.title}</span>
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-stone-400 dark:text-stone-500">{log.time}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-stone-400 dark:text-stone-500">
                    <span className={log.status === "failed" ? "text-red-500" : log.status === "pending" ? "text-amber-500" : ""}>{t(`workbench.${log.status === "success" ? "success" : log.status === "pending" ? "generating" : "failed"}`)}</span>
                    <span>{log.size}</span>
                    <span>{log.resolution}p</span>
                    <span>{log.seconds}s</span>
                    <span className="tabular-nums">{formatDuration(log.durationMs)}</span>
                </div>
            </button>
        </div>
    );
}

async function readStoredLogs() {
    if (typeof window === "undefined") return [];
    try {
        const logs: GenerationLog[] = [];
        await logStore.iterate<GenerationLog, void>((value) => {
            logs.push(value);
        });
        return (await Promise.all(logs.map(normalizeLog))).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch {
        return [];
    }
}

async function normalizeLog(log: Partial<GenerationLog>): Promise<GenerationLog> {
    const video = log.video?.storageKey ? { ...log.video, url: await resolveMediaUrl(log.video.storageKey, log.video.url) } : log.video;
    const references = await Promise.all(
        (log.references || []).map(async (item) => {
            void ensureImagePreview(item.storageKey);
            return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        }),
    );
    const config = normalizeLogConfig(log);
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || i18n.t("workbench.untitled"),
        prompt: log.prompt || "",
        time: log.time || new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model: log.model || config.videoModel || "",
        config,
        references,
        durationMs: log.durationMs || 0,
        size: log.size || config.size || "",
        resolution: normalizeResolution(log.resolution || config.vquality || ""),
        seconds: log.seconds || config.videoSeconds || "",
        status: log.status || "success",
        task: log.task,
        video,
        error: log.error,
    };
}

function serializeLog(log: GenerationLog): GenerationLog {
    return {
        ...log,
        references: log.references.map((item) => ({ ...item, dataUrl: item.storageKey ? "" : item.dataUrl })),
        video: log.video?.storageKey ? { ...log.video, url: "" } : log.video,
    };
}

function moveListItem<T>(items: T[], index: number, offset: number) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= items.length) return items;
    const next = [...items];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    return next;
}

function ReferenceOrderButtons({ index, total, onMove }: { index: number; total: number; onMove: (offset: number) => void }) {
    if (total <= 1) return null;
    return (
        <div className="absolute inset-x-1 bottom-1 flex justify-between">
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowLeft className="size-3" />} disabled={index <= 0} onClick={() => onMove(-1)} />
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowRight className="size-3" />} disabled={index >= total - 1} onClick={() => onMove(1)} />
        </div>
    );
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    return {
        model: log.config?.model || log.model || "",
        videoModel: log.config?.videoModel || log.model || "",
        size: log.config?.size || log.size || "",
        vquality: normalizeResolution(log.config?.vquality || log.resolution || ""),
        videoSeconds: log.config?.videoSeconds || log.seconds || "",
        videoGenerateAudio: log.config?.videoGenerateAudio || "true",
        videoWatermark: log.config?.videoWatermark || "false",
        videoMode: log.config?.videoMode === "reference" ? "reference" : "frames",
    };
}

function buildLog({ prompt, model, config, references, durationMs, status, task, video, error }: { prompt: string; model: string; config: AiConfig; references: ReferenceImage[]; durationMs: number; status: GenerationLog["status"]; task?: VideoGenerationTask; video?: GeneratedVideo; error?: string }): GenerationLog {
    const logConfig = {
        model: config.model,
        videoModel: config.videoModel,
        size: config.size,
        vquality: normalizeResolution(config.vquality),
        videoSeconds: config.videoSeconds,
        videoGenerateAudio: config.videoGenerateAudio,
        videoWatermark: config.videoWatermark,
        videoMode: config.videoMode === "reference" ? "reference" : "frames",
    };
    return {
        id: nanoid(),
        createdAt: Date.now(),
        title: prompt.slice(0, 12) || i18n.t("workbench.untitled"),
        prompt,
        time: new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model,
        config: logConfig,
        references,
        durationMs,
        size: logConfig.size,
        resolution: logConfig.vquality,
        seconds: logConfig.videoSeconds,
        status,
        task,
        video,
        error,
    };
}

function buildVideoConfig(config: AiConfig, model: string): AiConfig {
    return {
        ...config,
        model,
        videoModel: model,
        size: normalizeVideoSize(config.size),
        videoSeconds: normalizeVideoSeconds(config.videoSeconds),
        vquality: normalizeResolution(config.vquality),
        videoGenerateAudio: String(boolConfig(config.videoGenerateAudio, true)),
        videoWatermark: String(boolConfig(config.videoWatermark, false)),
        videoMode: config.videoMode === "reference" ? "reference" : "frames",
    };
}

function normalizeVideoSeconds(value: string) {
    if (String(value).trim() === "-1") return "-1";
    return clampVideoSeconds(value);
}

function normalizeVideoSize(value: string) {
    return normalizeVideoSizeValue(value);
}

function normalizeResolution(value: string) {
    return normalizeVideoResolutionValue(value);
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
