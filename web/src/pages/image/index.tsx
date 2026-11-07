import { Activity, ArrowLeft, ArrowRight, BookOpen, CheckSquare, Clapperboard, ClipboardPaste, Clock, Download, FolderPlus, History, ImagePlus, LoaderCircle, Maximize2, PenLine, Plus, SlidersHorizontal, Sparkles, SquarePen, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { App, Button, Checkbox, Drawer, Empty, Image, Input, InputNumber, Modal, Progress, Switch, Tag, Tooltip, Typography } from "antd";
import localforage from "localforage";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { canvasThemes } from "@/lib/canvas-theme";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { modelOptionLabel, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { cn } from "@/lib/utils";
import { nanoid } from "nanoid";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { requestEdit, requestGeneration, requestPromptOptimization } from "@/services/api/image";
import { deleteStoredImages, ensureImagePreview, getImagePreviewRevision, previewUrlFor, resolveImageUrl, subscribeImagePreviews, uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { useConversationAgentStore } from "@/stores/use-conversation-agent-store";
import { useImageTaskStore } from "@/stores/use-image-task-store";
import type { ImageTaskResult } from "@/services/api/image-queue";
import { useQuotaStore } from "@/stores/use-quota-store";
import type { ReferenceImage } from "@/types/image";
import i18n from "@/i18n";

type GeneratedImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
};

type GenerationResult = {
    id: string;
    status: "pending" | "success" | "failed";
    image?: GeneratedImage;
    error?: string;
    taskId?: string;
    phase?: "queued" | "processing";
    queuePosition?: number;
    estimatedWaitSeconds?: number;
    progress?: number;
    durationSeconds?: number;
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
    successCount: number;
    failCount: number;
    imageCount: number;
    size: string;
    quality: string;
    status: "success" | "failed";
    images: GeneratedImage[];
};

type GenerationLogConfig = Pick<AiConfig, "model" | "imageModel" | "quality" | "size" | "count">;

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

const LOG_STORE_KEY = "infinite-canvas:image_generation_logs";
const logStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });

export default function ImagePage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dragDepthRef = useRef(0);
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
    const [isReferenceDragActive, setIsReferenceDragActive] = useState(false);
    const [autoRunToken, setAutoRunToken] = useState(0);
    const [optimizing, setOptimizing] = useState(false);
    const [optimization, setOptimization] = useState<{ original: string; optimized: string; edited: string } | null>(null);
    const imageCommand = useWorkbenchAgentStore((state) => state.imageCommand);
    const clearImageCommand = useWorkbenchAgentStore((state) => state.clearImageCommand);
    const updateAgentTask = useWorkbenchAgentStore((state) => state.updateTask);
    const navigate = useNavigate();
    const setLaunchContext = useConversationAgentStore((state) => state.setLaunchContext);
    const processedCommandRef = useRef(0);
    const agentTaskIdRef = useRef<string | undefined>(undefined);
    const activeControllersRef = useRef<Record<number, AbortController>>({});
    const queueStatus = useImageTaskStore((state) => state.queueStatus);

    useEffect(() => {
        useImageTaskStore.getState().refreshQueueStatus(effectiveConfig);
        const timer = setInterval(() => {
            useImageTaskStore.getState().refreshQueueStatus(effectiveConfig);
        }, 15000);
        return () => clearInterval(timer);
    }, [effectiveConfig.baseUrl, effectiveConfig.apiKey]);

    // 页面刷新 / 重新进入时恢复未完成的后台生成任务
    useEffect(() => {
        const workbenchTasks = useImageTaskStore.getState().getTasksBySource("workbench");
        if (!workbenchTasks.length) return;
        setResults(
            workbenchTasks.map((task) => ({
                id: task.taskId,
                status: "pending",
                taskId: task.taskId,
                phase: task.status === "queued" ? "queued" : "processing",
                queuePosition: task.queuePosition,
                estimatedWaitSeconds: task.estimatedWaitSeconds,
                progress: task.progress,
                durationSeconds: task.durationSeconds,
            })),
        );
        setRunning(true);
        setStartedAt(Date.now());
        workbenchTasks.forEach(async (task, idx) => {
            const snapshot = {
                text: task.prompt,
                config: { ...effectiveConfig, model: task.model, count: "1" },
                references: [],
            };
            try {
                const img = await runGenerationSlot(idx, snapshot, task.taskId);
                if (img) {
                    saveLog(
                        buildLog({
                            prompt: snapshot.text,
                            model: task.model,
                            config: { ...snapshot.config, count: "1" },
                            references: snapshot.references,
                            durationMs: 0,
                            successCount: 1,
                            failCount: 0,
                            status: "success",
                            images: [img],
                        }),
                    );
                }
            } catch {
                // error handled in runGenerationSlot
            }
        });
    }, []);

    const model = effectiveConfig.imageModel || effectiveConfig.model;
    const canGenerate = Boolean(prompt.trim());
    const generationCount = Math.max(1, Math.min(10, Number(config.count) || 1));

    useEffect(() => {
        if (!running || !startedAt) return;
        const timer = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 1000);
        return () => window.clearInterval(timer);
    }, [running, startedAt]);

    useEffect(() => {
        void refreshLogs();
    }, []);

    const addReferences = async (files?: FileList | null) => {
        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        const nextReferences = await Promise.all(
            imageFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
            }),
        );
        setReferences((value) => [...value, ...nextReferences]);
    };

    const addReferencesFromClipboard = async () => {
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) {
                message.error(t("imageWorkbench.clipboardEmpty"));
                return;
            }
            const nextReferences = await Promise.all(
                blobs.map(async (blob, index) => {
                    const image = await uploadImage(blob);
                    return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            setReferences((value) => [...value, ...nextReferences]);
            message.success(t("imageWorkbench.clipboardAdded", { count: nextReferences.length }));
        } catch {
            message.error(t("imageWorkbench.clipboardEmpty"));
        }
    };

    const runGenerationBatch = async (text: string, agentTaskId?: string) => {
        const snapshot = buildRequestSnapshot(text);
        if (!snapshot) {
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.invalidParams") });
            return;
        }

        setElapsedMs(0);
        setRunning(true);
        if (agentTaskId) updateAgentTask(agentTaskId, { status: "running", error: undefined });
        setPreviewLog(null);
        setResults(Array.from({ length: generationCount }, () => ({ id: nanoid(), status: "pending" })));
        const batchStartedAt = performance.now();
        setStartedAt(batchStartedAt);

        const tasks = Array.from({ length: generationCount }, (_, index) => runGenerationSlot(index, snapshot));

        const result = await Promise.allSettled(tasks);
        const successImages = result.filter((item): item is PromiseFulfilledResult<GeneratedImage> => item.status === "fulfilled").map((item) => item.value);
        const successCount = successImages.length;
        const failCount = generationCount - successCount;
        const failed = result.find((item): item is PromiseRejectedResult => item.status === "rejected");
        const error = failed?.reason instanceof Error ? failed.reason.message : failCount ? t("workbench.generationFailed") : undefined;
        if (agentTaskId) updateAgentTask(agentTaskId, { status: successCount ? "succeeded" : "failed", successCount, failCount, error: successCount ? undefined : error });

        try {
            saveLog(
                buildLog({
                    prompt: text,
                    model,
                    config: { ...snapshot.config, count: String(generationCount) },
                    references: snapshot.references,
                    durationMs: performance.now() - batchStartedAt,
                    successCount,
                    failCount,
                    status: successCount ? "success" : "failed",
                    images: successImages,
                }),
            );
            successCount ? message.success(t("imageWorkbench.generated")) : message.error(failed?.reason instanceof Error ? failed.reason.message : t("workbench.generationFailed"));
        } finally {
            setRunning(false);
        }
    };

    const generate = async () => {
        const agentTaskId = agentTaskIdRef.current;
        agentTaskIdRef.current = undefined;
        const text = prompt.trim();
        if (!text) {
            message.error(t("imageWorkbench.promptRequired"));
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.promptRequired") });
            return;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning(t("workbench.configFirst"));
            openConfigDialog(true);
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.configIncomplete") });
            return;
        }

        // 生成前可选优化：仅文生图与手动生成时触发，由用户确认是否采用；带参考图/Agent 自动执行时直接使用原提示词。
        const shouldOptimize = config.optimizePrompt !== false && !references.length && !agentTaskId;
        if (shouldOptimize) {
            setOptimizing(true);
            try {
                const optimized = await requestPromptOptimization(effectiveConfig, text);
                if (optimized && optimized.trim() && optimized.trim() !== text) {
                    setOptimization({ original: text, optimized: optimized.trim(), edited: optimized.trim() });
                    setOptimizing(false);
                    return;
                }
            } catch {
                message.warning(t("imageWorkbench.optimizeFailed"));
            }
            setOptimizing(false);
        }
        await runGenerationBatch(text, agentTaskId);
    };

    const approveOptimization = async () => {
        if (!optimization) return;
        const approved = optimization.edited.trim() || optimization.original;
        setOptimization(null);
        setPrompt(approved);
        await runGenerationBatch(approved);
    };

    const useOriginalOptimization = async () => {
        if (!optimization) return;
        const original = optimization.original;
        setOptimization(null);
        await runGenerationBatch(original);
    };

    // Handle image-generation commands from the Agent panel by setting the prompt and optionally starting generation.
    useEffect(() => {
        if (!imageCommand || imageCommand.nonce === processedCommandRef.current) return;
        processedCommandRef.current = imageCommand.nonce;
        clearImageCommand();
        if (typeof imageCommand.prompt === "string") setPrompt(imageCommand.prompt);
        if (imageCommand.run && running) {
            if (imageCommand.taskId) updateAgentTask(imageCommand.taskId, { status: "failed", error: t("imageWorkbench.busy") });
            return;
        }
        if (imageCommand.run) {
            agentTaskIdRef.current = imageCommand.taskId;
            setAutoRunToken((value) => value + 1);
        }
    }, [imageCommand, clearImageCommand, running, updateAgentTask]);

    useEffect(() => {
        if (!autoRunToken) return;
        void generate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRunToken]);

    const downloadImage = (image: GeneratedImage, index: number) => {
        const extension = image.mimeType === "image/gif" ? "gif" : image.mimeType === "image/webp" ? "webp" : "png";
        saveAs(image.dataUrl, `image-${index + 1}.${extension}`);
    };

    const addResultToReferences = async (image: GeneratedImage, index: number) => {
        const stored = await uploadImage(image.dataUrl);
        setReferences((value) => [...value, { id: nanoid(), name: `result-${index + 1}.${stored.mimeType === "image/gif" ? "gif" : "png"}`, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
        message.success(t("imageWorkbench.addedReference"));
    };

    const saveResultToAssets = async (image: GeneratedImage, index: number) => {
        const stored = await uploadImage(image.dataUrl);
        addAsset({
            kind: "image",
            title: t("imageWorkbench.resultTitle", { count: index + 1 }),
            coverUrl: stored.url,
            tags: [],
            source: t("imageWorkbench.source"),
            data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType },
            metadata: { source: "image-page", prompt },
        });
        message.success(t("common.addedToAssets"));
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image") {
            const stored = await uploadImage(payload.dataUrl);
            setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
        } else {
            message.warning(t("imageWorkbench.unsupportedAsset"));
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
        const imageKeys = logs.filter((log) => selectedLogIds.includes(log.id)).flatMap((log) => log.images.map((image) => image.storageKey).filter((key): key is string => Boolean(key)));
        void Promise.all([deleteStoredImages(imageKeys), ...selectedLogIds.map((id) => logStore.removeItem(id))]).then(refreshLogs);
        if (previewLog && selectedLogIds.includes(previewLog.id)) {
            setPreviewLog(null);
            setResults([]);
        }
        setSelectedLogIds([]);
        setDeleteConfirmOpen(false);
    };

    const saveLog = (log: GenerationLog) => {
        void logStore.setItem(log.id, serializeLog(log)).then(refreshLogs);
    };

    const refreshLogs = async () => setLogs(await readStoredLogs());

    const previewGenerationLog = async (log: GenerationLog) => {
        setPreviewLog(log);
        setLogsOpen(false);
        setPrompt(log.prompt);
        setReferences(log.references || []);
        if (log.config.imageModel || log.model) updateConfig("imageModel", log.config.imageModel || log.model);
        if (log.config.quality) updateConfig("quality", log.config.quality);
        if (log.config.size) updateConfig("size", log.config.size);
        if (log.config.count) updateConfig("count", log.config.count);
        setResults(log.images.map((image) => ({ id: image.id, status: "success", image })));
    };

    const buildRequestSnapshot = (textOverride?: string) => {
        const text = (textOverride ?? prompt).trim();
        if (!text) {
            message.error(t("imageWorkbench.promptRequired"));
            return null;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning(t("workbench.configFirst"));
            openConfigDialog(true);
            return null;
        }
        return { text, config: { ...effectiveConfig, model, count: "1" }, references: [...references] };
    };

    const runGenerationSlot = async (
        index: number,
        snapshot: { text: string; config: AiConfig; references: ReferenceImage[] },
        existingTaskId?: string,
    ) => {
        const itemStartedAt = performance.now();
        let currentTaskId: string | undefined = existingTaskId;
        const controller = new AbortController();
        activeControllersRef.current[index] = controller;

        try {
            const onProgress = (task: ImageTaskResult) => {
                currentTaskId = task.task_id;
                setResults((value) =>
                    updateResultAt(value, index, {
                        taskId: task.task_id,
                        phase: task.status === "queued" ? "queued" : "processing",
                        queuePosition: task.queue_position,
                        estimatedWaitSeconds: task.estimated_wait_seconds,
                        progress: task.progress,
                        durationSeconds: task.duration_seconds,
                    }),
                );
                if (task.task_id) {
                    useImageTaskStore.getState().registerActiveTask({
                        taskId: task.task_id,
                        source: "workbench",
                        prompt: snapshot.text,
                        model: snapshot.config.model || snapshot.config.imageModel,
                        size: snapshot.config.size,
                        createdAt: Date.now(),
                        status: task.status,
                        queuePosition: task.queue_position,
                        estimatedWaitSeconds: task.estimated_wait_seconds,
                        progress: task.progress,
                        durationSeconds: task.duration_seconds,
                        slotIndex: index,
                    });
                }
            };

            const gifWanted =
                snapshot.config.imageFormat === "gif" &&
                /gpt-image-2\.6/i.test(snapshot.config.model || snapshot.config.imageModel) &&
                !snapshot.references.length;

            const requestOpts = {
                signal: controller.signal,
                onProgress,
                recoveryTaskId: existingTaskId,
                ...(gifWanted
                    ? {
                          outputFormat: "gif" as const,
                          frameCount: Math.min(16, Math.max(2, Math.round(Number(snapshot.config.gifFrames) || 9))),
                          frameDurationMs: Math.min(1000, Math.max(50, Math.round((Number(snapshot.config.gifFrameDuration) || 200) / 10) * 10)),
                      }
                    : {}),
            };

            const result = snapshot.references.length
                ? await requestEdit(snapshot.config, snapshot.text, snapshot.references, requestOpts)
                : await requestGeneration(snapshot.config, snapshot.text, requestOpts);

            const image = result[0];
            if (!image) throw new Error(t("imageWorkbench.missingResult"));
            const stored = await uploadImage(image.dataUrl);
            const nextImage: GeneratedImage = {
                id: image.id,
                dataUrl: stored.url,
                ...(stored.storageKey ? { storageKey: stored.storageKey } : {}),
                durationMs: performance.now() - itemStartedAt,
                width: stored.width,
                height: stored.height,
                bytes: stored.bytes,
                mimeType: stored.mimeType,
            };
            if (currentTaskId) {
                useImageTaskStore.getState().completeActiveTask(currentTaskId, "succeeded", undefined, stored.url);
            }
            setResults((value) => updateResultAt(value, index, { status: "success", image: nextImage }));
            return nextImage;
        } catch (error) {
            if (currentTaskId) {
                useImageTaskStore.getState().completeActiveTask(
                    currentTaskId,
                    controller.signal.aborted ? "cancelled" : "failed",
                    error instanceof Error ? error.message : String(error),
                );
            }
            setResults((value) =>
                updateResultAt(value, index, {
                    status: "failed",
                    error: error instanceof Error ? error.message : t("workbench.generationFailed"),
                }),
            );
            throw error;
        } finally {
            delete activeControllersRef.current[index];
        }
    };

    const cancelResultSlot = (index: number) => {
        const item = results[index];
        const controller = activeControllersRef.current[index];
        if (controller) {
            controller.abort();
        }
        if (item?.taskId) {
            useImageTaskStore.getState().cancelTask(effectiveConfig, item.taskId);
        }
        setResults((value) =>
            updateResultAt(value, index, {
                status: "failed",
                error: t("workbench.taskCanceled", "任务已取消"),
            }),
        );
    };

    const retryResult = async (index: number) => {
        const snapshot = buildRequestSnapshot();
        if (!snapshot) return;
        setPreviewLog(null);
        setResults((value) => updateResultAt(value, index, { status: "pending", error: undefined, image: undefined }));
        const retryStartedAt = performance.now();
        try {
            const image = await runGenerationSlot(index, snapshot);
            saveLog(
                buildLog({
                    prompt: snapshot.text,
                    model,
                    config: { ...snapshot.config, count: "1" },
                    references: snapshot.references,
                    durationMs: performance.now() - retryStartedAt,
                    successCount: 1,
                    failCount: 0,
                    status: "success",
                    images: [image],
                }),
            );
            message.success(t("workbench.retrySuccess"));
        } catch {
            // runGenerationSlot has already marked the result as failed.
        }
    };

    return (
        <div className="agent-page-in flex h-full flex-col overflow-hidden bg-[#faf9f5] text-stone-900 dark:bg-[#1c1b19] dark:text-stone-100">
            <main className="flex min-h-0 flex-1 overflow-hidden">
                <aside className="hidden w-[260px] shrink-0 min-h-0 flex-col overflow-hidden border-r border-stone-200/70 bg-[#f2efe8] dark:border-stone-800 dark:bg-[#171614] lg:flex">
                    <LogPanel
                        modelLabel={effectiveConfig.imageModel.split("::").pop() || effectiveConfig.imageModel}
                        quotaCapability="image"
                        logs={logs}
                        selectedLogIds={selectedLogIds}
                        activeLogId={previewLog?.id}
                        onSelectedLogIdsChange={setSelectedLogIds}
                        onCreateSession={createSession}
                        onDeleteSelected={() => setDeleteConfirmOpen(true)}
                        onPreviewLog={(log) => void previewGenerationLog(log)}
                    />
                </aside>

                <section className="grid min-w-0 flex-1 lg:min-h-0 lg:overflow-hidden xl:grid-cols-[420px_minmax(0,1fr)]">
                    <div className="thin-scrollbar flex flex-col border-stone-200/70 px-5 py-5 dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto lg:border-r">
                        <div>
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <h1 className="text-lg font-semibold tracking-tight text-stone-950 dark:text-stone-100">{t("imageWorkbench.title")}</h1>
                                </div>
                                <div className="flex shrink-0 gap-2 lg:hidden">
                                    <Button icon={<History className="size-4" />} onClick={() => setLogsOpen(true)}>
                                        {t("workbench.logs")}
                                    </Button>
                                    <Button icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                        {t("workbench.settings")}
                                    </Button>
                                </div>
                            </div>
                        </div>

                        <div className="mt-6 space-y-5">
                            <div>
                                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                    <span className="shrink-0 whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400 dark:text-stone-500">{t("workbench.prompt")}</span>
                                    <div className="flex flex-wrap items-center justify-end gap-0.5">
                                        <Button
                                            type="text"
                                            size="small"
                                            className="!h-7 !rounded-lg !px-2 !text-[11px] !font-normal !text-stone-500 hover:!bg-black/[.05] hover:!text-stone-700 dark:!text-stone-400 dark:hover:!bg-white/[.06] dark:hover:!text-stone-200"
                                            icon={<Sparkles className="size-3.5 text-amber-500" />}
                                            onClick={() => {
                                                setLaunchContext({ page: "image", prompt, model, size: config.size, quality: config.quality, count: String(generationCount) });
                                                navigate("/chat");
                                            }}
                                        >
                                            {t("chat.workbenchEntry")}
                                        </Button>
                                        <Button type="text" size="small" className="!h-7 !rounded-lg !px-2 !text-[11px] !font-normal !text-stone-500 hover:!bg-black/[.05] hover:!text-stone-700 dark:!text-stone-400 dark:hover:!bg-white/[.06] dark:hover:!text-stone-200" icon={<BookOpen className="size-3.5" />} onClick={() => setPromptDialogOpen(true)}>
                                            {t("workbench.viewPrompts")}
                                        </Button>
                                        <Button type="text" size="small" className="!h-7 !rounded-lg !px-2 !text-[11px] !font-normal !text-stone-500 hover:!bg-black/[.05] hover:!text-stone-700 dark:!text-stone-400 dark:hover:!bg-white/[.06] dark:hover:!text-stone-200" icon={<FolderPlus className="size-3.5" />} onClick={() => setAssetPickerOpen(true)}>
                                            {t("workbench.viewAssets")}
                                        </Button>
                                    </div>
                                </div>
                                <div className="rounded-2xl border border-stone-300/80 bg-white p-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-all duration-200 focus-within:border-stone-400/80 focus-within:shadow-[0_2px_14px_rgba(0,0,0,0.06)] dark:border-stone-700 dark:bg-stone-900 dark:focus-within:border-stone-600">
                                    <Input.TextArea variant="borderless" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} className="!px-1 !py-1 !text-sm font-serif" placeholder={t("imageWorkbench.promptPlaceholder")} />
                                </div>
                                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1">
                                    <div className="flex min-w-0 items-center gap-1.5 text-xs text-stone-500 dark:text-stone-400">
                                        <Sparkles className="size-3.5 shrink-0 text-amber-500" />
                                        <span className="shrink-0">{t("imageWorkbench.optimizePrompt")}</span>
                                        <span className="hidden truncate text-stone-400 sm:inline dark:text-stone-500">{t("imageWorkbench.optimizePromptHint")}</span>
                                    </div>
                                    <Switch size="small" checked={config.optimizePrompt !== false} onChange={(checked) => updateConfig("optimizePrompt", checked)} />
                                </div>
                            </div>

                            <div className="min-w-0">
                                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                    <span className="shrink-0 whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400 dark:text-stone-500">{t("imageWorkbench.references")}</span>
                                    <div className="flex flex-wrap items-center gap-1.5">
                                        <Button type="text" size="small" className="!h-7 !rounded-lg !px-2 !text-[11px] !font-normal !text-stone-500 hover:!bg-black/[.05] hover:!text-stone-700 dark:!text-stone-400 dark:hover:!bg-white/[.06] dark:hover:!text-stone-200" icon={<ClipboardPaste className="size-3.5" />} onClick={() => void addReferencesFromClipboard()}>
                                            {t("workbench.clipboard")}
                                        </Button>
                                        <Button type="text" size="small" className="!h-7 !rounded-lg !px-2 !text-[11px] !font-normal !text-stone-500 hover:!bg-black/[.05] hover:!text-stone-700 dark:!text-stone-400 dark:hover:!bg-white/[.06] dark:hover:!text-stone-200" icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>
                                            {t("workbench.upload")}
                                        </Button>
                                    </div>
                                </div>
                                <div
                                    className={`hover-scrollbar hover-scrollbar-hint relative flex min-h-20 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-2xl border border-dashed p-2 pb-3 overscroll-x-contain transition-colors ${isReferenceDragActive ? "border-stone-400 bg-white/70 dark:border-stone-500 dark:bg-white/[.06]" : "border-stone-300 dark:border-stone-700"}`}
                                    onDragEnter={(event) => {
                                        event.preventDefault();
                                        dragDepthRef.current += 1;
                                        if (event.dataTransfer.types.includes("Files")) setIsReferenceDragActive(true);
                                    }}
                                    onDragOver={(event) => {
                                        event.preventDefault();
                                        event.dataTransfer.dropEffect = "copy";
                                    }}
                                    onDragLeave={(event) => {
                                        event.preventDefault();
                                        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
                                        if (!dragDepthRef.current) setIsReferenceDragActive(false);
                                    }}
                                    onDrop={(event) => {
                                        event.preventDefault();
                                        dragDepthRef.current = 0;
                                        setIsReferenceDragActive(false);
                                        void addReferences(event.dataTransfer.files);
                                    }}
                                    onWheel={(event) => {
                                        if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
                                        event.preventDefault();
                                        event.currentTarget.scrollLeft += event.deltaY;
                                    }}
                                >
                                    {references.map((item, index) => (
                                        <div key={item.id} className="group relative size-20 shrink-0 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                                            <img src={previewUrlFor(item.storageKey) || item.dataUrl} alt={item.name} className="size-full object-cover" />
                                            <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{imageReferenceLabel(index)}</span>
                                            <ReferenceOrderButtons index={index} total={references.length} onMove={(offset) => setReferences((value) => moveListItem(value, index, offset))} />
                                            <button
                                                type="button"
                                                className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex"
                                                onClick={() => setReferences((value) => value.filter((ref) => ref.id !== item.id))}
                                                aria-label={t("imageWorkbench.removeReference")}
                                            >
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                    {!references.length ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">{isReferenceDragActive ? t("imageWorkbench.dropReferences") : t("imageWorkbench.noReferences")}</div> : null}
                                </div>
                            </div>

                            <div className="flex items-center justify-between rounded-xl border border-stone-200/70 bg-white/50 px-3 py-2 text-sm dark:border-stone-800 dark:bg-white/[.03] sm:hidden">
                                <span className="truncate text-stone-500 dark:text-stone-400">
                                    {model.split("::").pop() || model} · {effectiveConfig.size} · {effectiveConfig.quality}
                                </span>
                                <Button size="small" type="text" icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                    {t("workbench.adjust")}
                                </Button>
                            </div>

                            <div className="hidden rounded-2xl border border-stone-200/70 bg-white/40 p-3 dark:border-stone-800 dark:bg-white/[.02] sm:grid sm:grid-cols-2 sm:gap-4">
                                <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                            </div>
                        </div>

                        <div className="sticky bottom-0 z-10 -mx-5 mt-auto border-t border-stone-200/70 bg-[#faf9f5]/95 px-5 py-3.5 backdrop-blur-md dark:border-stone-800 dark:bg-[#1c1b19]/95">
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
                            <div className="flex items-center gap-2.5">
                                <h2 className="text-sm font-semibold tracking-tight text-stone-950 dark:text-stone-100">{t("workbench.results")}</h2>
                                {queueStatus ? (
                                    <span className="inline-flex items-center gap-1.5 rounded-full border border-stone-200/80 bg-stone-100/70 px-2 py-0.5 text-[11px] text-stone-500 dark:border-stone-800 dark:bg-stone-800/60 dark:text-stone-400">
                                        <Activity className="size-3 text-stone-400" />
                                        <span>系统队列: {queueStatus.active_tasks} 生成中 · {queueStatus.queued_tasks} 排队</span>
                                    </span>
                                ) : null}
                            </div>
                            {running ? (
                                <span className="rounded-full border border-stone-200/90 bg-white/70 px-2.5 py-0.5 text-[11px] tabular-nums text-stone-500 shadow-2xs backdrop-blur-xs dark:border-stone-700/80 dark:bg-stone-800/70 dark:text-stone-400">
                                    {t("workbench.waiting", { time: formatDuration(elapsedMs) })}
                                </span>
                            ) : null}
                        </div>
                        {results.length ? (
                            <div className="grid gap-3.5 sm:grid-cols-2 2xl:grid-cols-3">
                                {results.map((result, index) =>
                                    result.status === "success" && result.image ? (
                                        <ResultImageCard key={result.id} image={result.image} index={index} onEdit={addResultToReferences} onDownload={downloadImage} onSaveAsset={saveResultToAssets} />
                                    ) : result.status === "failed" ? (
                                        <FailedImageCard key={result.id} error={result.error || t("workbench.generationFailed")} onRetry={() => retryResult(index)} />
                                    ) : (
                                        <PendingImageCard
                                            key={result.id}
                                            phase={result.phase}
                                            queuePosition={result.queuePosition}
                                            estimatedWaitSeconds={result.estimatedWaitSeconds}
                                            progress={result.progress}
                                            onCancel={() => cancelResultSlot(index)}
                                        />
                                    ),
                                )}
                            </div>
                        ) : (
                            <div className="agent-fade-in flex min-h-[360px] flex-col items-center justify-center py-16 text-center lg:min-h-[520px]">
                                <div className="relative mb-5 flex size-14 items-center justify-center">
                                    <div className="absolute inset-0 animate-[pulse_3s_ease-in-out_infinite] rounded-full bg-stone-200/60 blur-md dark:bg-stone-700/40" />
                                    <div className="relative flex size-12 items-center justify-center rounded-2xl border border-stone-200/90 bg-gradient-to-b from-white to-stone-100/90 shadow-xs dark:border-stone-700/80 dark:from-stone-800 dark:to-stone-900">
                                        <ImagePlus className="size-5.5 text-stone-600 dark:text-stone-300" />
                                    </div>
                                </div>
                                <p className="text-sm font-medium text-stone-700 dark:text-stone-300">{t("imageWorkbench.empty")}</p>
                                <p className="mt-1 text-xs text-stone-400 dark:text-stone-500">{t("imageWorkbench.promptPlaceholder")}</p>
                            </div>
                        )}
                    </div>
                </section>
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
            <Drawer
                open={logsOpen}
                placement="left"
                width={280}
                onClose={() => setLogsOpen(false)}
                styles={{ body: { padding: 0, background: "var(--color-card)" } }}
            >
                <LogPanel
                    modelLabel={effectiveConfig.imageModel.split("::").pop() || effectiveConfig.imageModel}
                    quotaCapability="image"
                    logs={logs}
                    selectedLogIds={selectedLogIds}
                    activeLogId={previewLog?.id}
                    onSelectedLogIdsChange={setSelectedLogIds}
                    onCreateSession={() => {
                        createSession();
                        setLogsOpen(false);
                    }}
                    onDeleteSelected={() => setDeleteConfirmOpen(true)}
                    onPreviewLog={(log) => void previewGenerationLog(log)}
                />
            </Drawer>
            <Drawer title={t("workbench.settings")} placement="bottom" size="82vh" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
                <div className="grid grid-cols-2 gap-3 pb-4">
                    <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                </div>
            </Drawer>
            <Modal open={Boolean(optimization)} title={t("imageWorkbench.optimizeTitle")} onCancel={() => setOptimization(null)} footer={null} width={760}>
                <p className="mb-4 text-sm leading-6 text-stone-500 dark:text-stone-400">{t("imageWorkbench.optimizeDescription")}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                    <div className="min-w-0">
                        <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-stone-400 dark:text-stone-500">{t("imageWorkbench.optimizeOriginal")}</div>
                        <div className="hover-scrollbar max-h-60 overflow-y-auto whitespace-pre-wrap rounded-xl border border-stone-200/80 bg-white/60 p-3 text-sm leading-6 text-stone-600 dark:border-stone-800 dark:bg-white/[.03] dark:text-stone-300">{optimization?.original}</div>
                    </div>
                    <div className="min-w-0">
                        <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-stone-400 dark:text-stone-500">{t("imageWorkbench.optimizeOptimized")}</div>
                        <Input.TextArea
                            value={optimization?.edited ?? ""}
                            onChange={(event) => setOptimization((value) => (value ? { ...value, edited: event.target.value } : value))}
                            autoSize={{ minRows: 8, maxRows: 14 }}
                            className="!text-sm"
                        />
                    </div>
                </div>
                <div className="mt-4 flex flex-wrap justify-end gap-2">
                    <Button onClick={() => setOptimization(null)}>{t("common.cancel")}</Button>
                    <Button onClick={() => void useOriginalOptimization()}>{t("imageWorkbench.optimizeUseOriginal")}</Button>
                    <Button type="primary" onClick={() => void approveOptimization()}>{t("imageWorkbench.optimizeUseOptimized")}</Button>
                </div>
            </Modal>
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
    const gifSupported = /gpt-image-2\.6/i.test(model);
    const gifFrames = Math.min(16, Math.max(2, Math.round(Number(config.gifFrames) || 9)));
    const gifFrameDuration = Math.min(1000, Math.max(50, Math.round((Number(config.gifFrameDuration) || 200) / 10) * 10));
    const gifFps = Math.max(1, Math.min(20, Math.round(1000 / gifFrameDuration)));
    const gifDurationWarning = (gifFrames * gifFrameDuration) / 1000 < 1 || (gifFrames * gifFrameDuration) / 1000 > 3;

    return (
        <>
            <label className="col-span-2 block min-w-0 sm:col-span-1">
                <span className="mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base">{t("workbench.model")}</span>
                <ModelPicker config={config} value={model} onChange={(value) => updateConfig("imageModel", value)} capability="image" fullWidth onMissingConfig={() => openConfigDialog(false)} />
            </label>
            <div className="col-span-2 space-y-2">
                <div className="flex items-center justify-between gap-3 rounded-2xl border border-stone-200/70 bg-white/40 px-3 py-2.5 dark:border-stone-800 dark:bg-white/[.02]">
                    <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-sm font-semibold">
                            <Clapperboard className="size-3.5 text-stone-400" />
                            {t("imageWorkbench.gifTitle")}
                        </div>
                        <div className="mt-0.5 text-xs text-stone-400 dark:text-stone-500">{gifSupported ? t("imageWorkbench.gifHint") : t("imageWorkbench.gifUnsupported")}</div>
                    </div>
                    <Switch
                        size="small"
                        checked={gifSupported && config.imageFormat === "gif"}
                        disabled={!gifSupported}
                        onChange={(checked) => updateConfig("imageFormat", checked ? "gif" : "png")}
                    />
                </div>
                {gifSupported && config.imageFormat === "gif" ? (
                    <div className="space-y-1.5">
                        <div className="grid grid-cols-2 gap-3">
                            <label className="min-w-0 space-y-1">
                                <span className="block text-[11px] text-stone-400 dark:text-stone-500">{t("imageWorkbench.gifFrames")}</span>
                                <InputNumber
                                    min={2}
                                    max={16}
                                    step={1}
                                    value={gifFrames}
                                    onChange={(value) => updateConfig("gifFrames", String(value ?? 9))}
                                    className="!w-full"
                                />
                            </label>
                            <label className="min-w-0 space-y-1">
                                <span className="block text-[11px] text-stone-400 dark:text-stone-500">{t("imageWorkbench.gifFps")}</span>
                                <InputNumber
                                    min={1}
                                    max={20}
                                    step={1}
                                    value={gifFps}
                                    onChange={(value) => {
                                        const fps = Math.min(20, Math.max(1, Math.round(Number(value) || 5)));
                                        updateConfig("gifFrameDuration", String(Math.min(1000, Math.max(50, Math.round(1000 / fps / 10) * 10))));
                                    }}
                                    addonAfter="fps"
                                    className="!w-full"
                                />
                            </label>
                        </div>
                        <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]", gifDurationWarning ? "text-amber-600 dark:text-amber-400" : "text-stone-400 dark:text-stone-500")}>
                            <span>{t("imageWorkbench.gifTotalDuration", { frames: gifFrames, ms: gifFrameDuration, seconds: (gifFrames * gifFrameDuration / 1000).toFixed(2) })}</span>
                            <span>{t("imageWorkbench.gifDurationHint")}</span>
                        </div>
                    </div>
                ) : null}
            </div>
            <div className="col-span-2">
                <ImageSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-4" maxCount={10} />
            </div>
        </>
    );
}

function ResultImageCard({
    image,
    index,
    onEdit,
    onDownload,
    onSaveAsset,
}: {
    image: GeneratedImage;
    index: number;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
}) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const isGif = image.mimeType === "image/gif";
    return (
        <div className="group relative aspect-square overflow-hidden rounded-2xl border border-stone-200/90 bg-stone-100/50 shadow-2xs transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md dark:border-stone-800 dark:bg-stone-900/50 dark:hover:border-stone-700">
            <div className="relative size-full">
                <Image
                    src={previewUrlFor(image.storageKey) || image.dataUrl}
                    preview={{ src: image.dataUrl }}
                    alt={t("imageWorkbench.resultAlt", { count: index + 1 })}
                    className="agent-fade-in size-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.02]"
                />
                {/* 动图 GIF 徽章 */}
                {isGif ? (
                    <span className="pointer-events-none absolute left-2.5 top-2.5 z-10 rounded-md bg-black/60 px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-white backdrop-blur-sm shadow-xs">
                        GIF
                    </span>
                ) : null}

                {/* 左下角微悬浮尺寸规格胶囊（hover 时优雅显现） */}
                <span className="pointer-events-none absolute bottom-2.5 left-2.5 z-10 flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-0.5 font-mono text-[10px] tabular-nums text-white/95 opacity-0 backdrop-blur-md transition-opacity duration-200 group-hover:opacity-100 shadow-xs">
                    <span>
                        {image.width}×{image.height}
                    </span>
                    <span className="text-white/40">·</span>
                    <span>{formatBytes(image.bytes)}</span>
                </span>

                {/* 右下角悬浮玻璃拟态操作栏（直接浮于画面上，不占外部空间） */}
                <div
                    className="absolute bottom-2.5 right-2.5 z-10 flex items-center gap-0.5 rounded-full bg-black/55 px-1 py-0.5 text-white opacity-0 backdrop-blur-md transition-opacity duration-200 group-hover:opacity-100 shadow-md dark:bg-black/70"
                    onClick={(event) => event.stopPropagation()}
                >
                    <Tooltip title={t("common.addToAssets")}>
                        <button
                            type="button"
                            className="flex size-6.5 items-center justify-center rounded-full text-white/80 transition hover:bg-white/20 hover:text-white"
                            onClick={() => void onSaveAsset(image, index)}
                        >
                            <FolderPlus className="size-3.5" />
                        </button>
                    </Tooltip>
                    <Tooltip title={t("imageWorkbench.addReference")}>
                        <button
                            type="button"
                            className="flex size-6.5 items-center justify-center rounded-full text-white/80 transition hover:bg-white/20 hover:text-white"
                            onClick={() => void onEdit(image, index)}
                        >
                            <PenLine className="size-3.5" />
                        </button>
                    </Tooltip>
                    <Tooltip title={t("common.download")}>
                        <button
                            type="button"
                            className="flex size-6.5 items-center justify-center rounded-full text-white/80 transition hover:bg-white/20 hover:text-white"
                            onClick={() => onDownload(image, index)}
                        >
                            <Download className="size-3.5" />
                        </button>
                    </Tooltip>
                </div>
            </div>
        </div>
    );
}

function PendingImageCard({
    phase,
    queuePosition,
    estimatedWaitSeconds,
    progress,
    onCancel,
}: {
    phase?: "queued" | "processing";
    queuePosition?: number;
    estimatedWaitSeconds?: number;
    progress?: number;
    onCancel?: () => void;
}) {
    const { t } = useTranslation();
    const isQueued = phase === "queued";
    const pct = Math.min(100, Math.max(0, Math.round((progress ?? 0) * 100)));

    return (
        <div className="relative aspect-square overflow-hidden rounded-2xl border border-stone-200/80 bg-stone-100/40 shadow-xs dark:border-stone-800 dark:bg-stone-900/40 flex flex-col justify-between p-4">
            <div className="agent-shimmer absolute inset-0 pointer-events-none" />

            {/* Top Status */}
            <div className="relative z-10 flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-stone-200/80 bg-white/80 px-2.5 py-0.5 text-[11px] font-medium text-stone-600 shadow-2xs backdrop-blur-xs dark:border-stone-700/80 dark:bg-stone-800/80 dark:text-stone-300">
                    <span className={cn("size-2 rounded-full", isQueued ? "bg-amber-500 animate-pulse" : "bg-blue-500 animate-pulse")} />
                    {isQueued ? t("workbench.queued", "排队等待中") : t("workbench.processing", "正在绘制中...")}
                </span>
                {onCancel ? (
                    <Button size="small" type="text" danger className="!h-6 !px-2 !text-[11px]" onClick={onCancel}>
                        {t("workbench.cancelTask", "取消任务")}
                    </Button>
                ) : null}
            </div>

            {/* Center Content */}
            <div className="relative z-10 flex flex-col items-center justify-center gap-2.5 text-center">
                {isQueued ? (
                    <div className="flex flex-col items-center gap-2">
                        <div className="relative flex size-10 items-center justify-center rounded-2xl border border-amber-200/80 bg-amber-50/80 text-amber-600 shadow-xs dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-400">
                            <Clock className="size-5 animate-spin" style={{ animationDuration: "6s" }} />
                        </div>
                        <div className="space-y-0.5">
                            <div className="text-xs font-semibold text-stone-800 dark:text-stone-200">
                                {t("workbench.queuePosition", "前方还有 {{count}} 人", { count: queuePosition || 1 })}
                            </div>
                            <div className="text-[11px] text-stone-400 dark:text-stone-500">
                                {t("workbench.queueEstimate", "预计等待约 {{seconds}} 秒", { seconds: estimatedWaitSeconds ?? 45 })}
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="flex flex-col items-center gap-2.5 w-full px-4">
                        <div className="relative flex size-10 items-center justify-center rounded-2xl border border-blue-200/80 bg-blue-50/80 text-blue-600 shadow-xs dark:border-blue-900/50 dark:bg-blue-950/40 dark:text-blue-400">
                            <Sparkles className="size-5 animate-pulse" />
                        </div>
                        <div className="w-full space-y-1.5">
                            <div className="flex items-center justify-between text-xs text-stone-600 dark:text-stone-300">
                                <span>{t("workbench.drawing", "正在绘制中...")}</span>
                                <span className="font-mono font-semibold tabular-nums text-blue-600 dark:text-blue-400">{pct}%</span>
                            </div>
                            <Progress percent={pct} size="small" showInfo={false} strokeColor={{ "0%": "#3b82f6", "100%": "#60a5fa" }} />
                        </div>
                    </div>
                )}
            </div>

            {/* Bottom Hint */}
            <div className="relative z-10 text-center text-[10px] text-stone-400 dark:text-stone-500">
                {isQueued ? t("workbench.queueHint", "已进入全局并发排队，请稍候…") : t("workbench.renderHint", "高精度神经网络渲染中…")}
            </div>
        </div>
    );
}

function FailedImageCard({ error, onRetry }: { error: string; onRetry: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="overflow-hidden rounded-2xl border border-red-200/80 bg-red-50/60 dark:border-red-950 dark:bg-red-950/20">
            <div className="flex aspect-square flex-col items-center justify-center gap-3 p-5 text-center">
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

function updateResultAt(results: GenerationResult[], index: number, next: Partial<GenerationResult>) {
    return results.map((item, itemIndex) => (itemIndex === index ? { ...item, ...next } : item));
}

function LogPanel({
    logs,
    selectedLogIds,
    activeLogId,
    modelLabel,
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
                    <span className="text-[13px] font-semibold tracking-tight text-stone-900 dark:text-stone-100">{t("imageWorkbench.title")}</span>
                    <span className="rounded border border-stone-300/80 px-1 font-mono text-[9px] uppercase tracking-widest text-stone-400 dark:border-stone-700 dark:text-stone-500">image</span>
                </div>
                <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-stone-600 transition hover:bg-black/[.045] dark:text-stone-300 dark:hover:bg-white/[.06]"
                    onClick={onCreateSession}
                >
                    <SquarePen className="size-4 text-stone-500 dark:text-stone-400" />
                    {t("workbench.new")}
                </button>
                <div className="mt-5 flex items-center justify-between px-1">
                    <div className="flex items-center gap-1.5">
                        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-400/90 dark:text-stone-500">{t("workbench.logs")}</span>
                        <span className="rounded-full bg-stone-200/60 px-1.5 py-0.2 font-mono text-[9px] tabular-nums text-stone-500 dark:bg-stone-800 dark:text-stone-400">{logs.length}</span>
                    </div>
                    {logs.length > 0 ? (
                        <div className="flex items-center gap-1">
                            <button
                                type="button"
                                className="rounded px-1.5 py-0.5 text-[10px] text-stone-400 transition hover:bg-black/[.04] hover:text-stone-700 dark:hover:bg-white/[.06] dark:hover:text-stone-200"
                                onClick={toggleAll}
                            >
                                {allSelected ? t("common.cancel") : t("workbench.selectAll")}
                            </button>
                            {selectedLogIds.length > 0 ? (
                                <button
                                    type="button"
                                    className="rounded px-1.5 py-0.5 text-[10px] text-red-500 transition hover:bg-red-50 dark:hover:bg-red-950/30"
                                    onClick={onDeleteSelected}
                                >
                                    {t("common.delete")} ({selectedLogIds.length})
                                </button>
                            ) : null}
                        </div>
                    ) : null}
                </div>
            </div>
            <div className="hover-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3 pt-1">
                {logs.map((log) => (
                    <LogCard
                        key={log.id}
                        log={log}
                        selected={selectedLogIds.includes(log.id)}
                        active={activeLogId === log.id}
                        onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))}
                        onClick={() => onPreviewLog(log)}
                    />
                ))}
                {!logs.length ? <div className="flex min-h-40 flex-1 items-center justify-center text-center text-xs text-stone-400 dark:text-stone-500">{t("workbench.noLogs")}</div> : null}
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

function LogCard({ log, selected, active, onSelectedChange, onClick }: { log: GenerationLog; selected: boolean; active: boolean; onSelectedChange: (checked: boolean) => void; onClick: () => void }) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const thumbnails = log.images.filter((image) => image.dataUrl).slice(0, 4);

    return (
        <button
            type="button"
            className={`group block w-full rounded-xl px-2.5 py-2 text-left transition-all ${
                active ? "bg-black/[.06] shadow-2xs dark:bg-white/[.08]" : "hover:bg-black/[.035] dark:hover:bg-white/[.05]"
            }`}
            onClick={onClick}
        >
            <div className="grid grid-cols-[minmax(120px,1fr)_auto] gap-2">
                <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
                    <Checkbox className="mt-0.5" checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => onSelectedChange(event.target.checked)} />
                    <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium leading-5 text-stone-800 dark:text-stone-200">{log.title}</div>
                        {thumbnails.length ? (
                            <div className="mt-1.5 flex gap-1 overflow-hidden">
                                {thumbnails.map((image) => (
                                    <img
                                        key={image.id}
                                        src={previewUrlFor(image.storageKey) || image.dataUrl}
                                        alt=""
                                        className="size-8 shrink-0 rounded-lg border border-black/5 object-cover dark:border-white/10"
                                    />
                                ))}
                            </div>
                        ) : null}
                    </div>
                </div>
                <div className="grid justify-items-end gap-1 text-[10px] text-stone-400 dark:text-stone-500">
                    <div className="flex gap-2">
                        <span>{t("workbench.successCount", { count: log.successCount ?? log.imageCount })}</span>
                        {log.failCount ? <span className="text-red-500">{t("workbench.failCount", { count: log.failCount })}</span> : null}
                    </div>
                    <div className="flex flex-wrap justify-end gap-x-2 gap-y-0.5">
                        <span>{t("workbench.itemCount", { count: log.imageCount })}</span>
                        <span className="tabular-nums">{formatDuration(log.durationMs)}</span>
                    </div>
                    <span className="tabular-nums opacity-80">{log.time}</span>
                </div>
            </div>
        </button>
    );
}

async function readStoredLogs() {
    if (typeof window === "undefined") return [];
    try {
        const values: GenerationLog[] = [];
        await logStore.iterate<GenerationLog, void>((value) => {
            values.push(value);
        });
        const logs = await Promise.all(values.map(normalizeLog));
        return logs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch {
        return [];
    }
}

async function normalizeLog(log: Partial<GenerationLog>): Promise<GenerationLog> {
    const references = await Promise.all(
        (log.references || []).map(async (item) => {
            void ensureImagePreview(item.storageKey);
            return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        }),
    );
    const images = await Promise.all(
        (log.images || []).map(async (item) => {
            void ensureImagePreview(item.storageKey);
            return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        }),
    );
    const config = normalizeLogConfig(log);
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || i18n.t("workbench.untitled"),
        prompt: log.prompt || log.title || "",
        time: log.time || new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model: log.model || config.imageModel || "",
        config,
        references,
        durationMs: log.durationMs || 0,
        successCount: log.successCount ?? log.imageCount ?? 0,
        failCount: log.failCount || 0,
        imageCount: log.imageCount || log.successCount || 0,
        size: log.size || config.size || "",
        quality: log.quality || config.quality || "",
        status: log.status || "success",
        images,
    };
}

function serializeLog(log: GenerationLog): GenerationLog {
    return {
        ...log,
        references: log.references.map((item) => ({ ...item, dataUrl: item.storageKey ? "" : item.dataUrl })),
        images: log.images.map((image) => ({ ...image, dataUrl: image.storageKey ? "" : image.dataUrl })),
    };
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    return {
        model: log.config?.model || log.model || "",
        imageModel: log.config?.imageModel || log.model || "",
        quality: log.config?.quality || log.quality || "",
        size: log.config?.size || log.size || "",
        count: log.config?.count || String(log.imageCount || log.successCount || 1),
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

function buildLog({
    prompt,
    model,
    config,
    references,
    durationMs,
    successCount,
    failCount,
    status,
    images,
}: {
    prompt: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    status: GenerationLog["status"];
    images: GeneratedImage[];
}): GenerationLog {
    const logConfig = {
        model: config.model,
        imageModel: config.imageModel,
        quality: config.quality,
        size: config.size,
        count: config.count,
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
        successCount,
        failCount,
        imageCount: Number(logConfig.count) || successCount,
        size: logConfig.size,
        quality: logConfig.quality,
        status,
        images,
    };
}
