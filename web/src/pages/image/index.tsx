import { Activity, ArrowLeft, ArrowRight, BookOpen, Clapperboard, ClipboardPaste, Clock, Download, FolderPlus, ImagePlus, Menu, PenLine, SlidersHorizontal, Sparkles, SquarePen, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { App, Button, Checkbox, Drawer, Image, Input, InputNumber, Modal, Progress, Switch, Tooltip, Typography } from "antd";
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
import { isRetryableGenerationError } from "@/lib/conversation-agent/generation-retry";
import { requestEdit, requestGeneration, requestPromptOptimization } from "@/services/api/image";
import { deleteStoredImages, ensureImagePreview, getImagePreviewRevision, previewUrlFor, resolveImageUrl, subscribeImagePreviews, uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useConversationAgentStore } from "@/stores/use-conversation-agent-store";
import { planWorkbenchRecovery, resolveRetrySlotSnapshot, useImageTaskStore } from "@/stores/use-image-task-store";
import { resolveImageCommand, useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
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
    /** 生成本槽位时使用的提示词/参考图快照：失败重试必须复用这份快照，而不是输入框里的当前提示词。 */
    prompt?: string;
    references?: ReferenceImage[];
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
    const { message, modal } = App.useApp();
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
    const [recovering, setRecovering] = useState(false);
    const [resultsPrompt, setResultsPrompt] = useState("");
    const imageCommand = useWorkbenchAgentStore((state) => state.imageCommand);
    const clearImageCommand = useWorkbenchAgentStore((state) => state.clearImageCommand);
    const updateAgentTask = useWorkbenchAgentStore((state) => state.updateTask);
    const navigate = useNavigate();
    const setLaunchContext = useConversationAgentStore((state) => state.setLaunchContext);
    const processedCommandRef = useRef(0);
    const agentTaskIdRef = useRef<string | undefined>(undefined);
    const activeControllersRef = useRef<Record<number, AbortController>>({});
    const submittingRef = useRef(false);
    const generatingRef = useRef(false);
    const lastSubmitRef = useRef<{ text: string; at: number } | null>(null);
    const promptRef = useRef("");
    promptRef.current = prompt;
    const recoveryEpochRef = useRef(0);
    // 页面卸载时被 abort 的请求：其 catch/finally 不得再把取消结果写回持久化任务，任务应保持可恢复。
    const discardedControllersRef = useRef<WeakSet<AbortController>>(new WeakSet());
    const queueStatus = useImageTaskStore((state) => state.queueStatus);

    useEffect(() => {
        useImageTaskStore.getState().refreshQueueStatus(effectiveConfig);
        const timer = setInterval(() => {
            useImageTaskStore.getState().refreshQueueStatus(effectiveConfig);
        }, 15000);
        return () => clearInterval(timer);
    }, [effectiveConfig.baseUrl, effectiveConfig.apiKey]);

    // 页面刷新 / 重新进入时恢复未完成的后台生成任务：
    // 只恢复当前渠道、提示词完整的 workbench 任务，按持久化 slotIndex 归位；恢复结束必须在 finally 复位 running。
    useEffect(() => {
        const plan = planWorkbenchRecovery(useImageTaskStore.getState().getTasksBySource("workbench"), { baseUrl: effectiveConfig.baseUrl });
        const rejectedMessage = (reason: "channel-mismatch" | "missing-prompt") =>
            reason === "channel-mismatch"
                ? t("imageWorkbench.recoveryChannelMismatch", "原任务使用的 API 渠道与当前渠道不一致，已放弃恢复，请重新生成")
                : t("imageWorkbench.recoveryPromptMissing", "原任务缺少提示词，已放弃恢复");
        plan.rejected.forEach(({ task, reason }) => {
            useImageTaskStore.getState().completeActiveTask(task.taskId, "failed", rejectedMessage(reason));
        });
        if (plan.rejected.length) {
            message.warning(t("imageWorkbench.recoveryRejected", "部分未完成任务因渠道或提示词变化已放弃恢复，请重新生成"));
        }
        if (!plan.entries.length) return;

        const epoch = recoveryEpochRef.current + 1;
        recoveryEpochRef.current = epoch;
        setRecovering(true);
        setRunning(true);
        setStartedAt(performance.now());
        setElapsedMs(0);
        setResults(
            plan.entries.map(({ task }) => ({
                id: `recover-${task.taskId}`,
                status: "pending",
                taskId: task.taskId,
                phase: task.status === "queued" ? "queued" : "processing",
                queuePosition: task.queuePosition,
                estimatedWaitSeconds: task.estimatedWaitSeconds,
                progress: task.progress,
                durationSeconds: task.durationSeconds,
                prompt: task.prompt,
            })),
        );
        const distinctPrompts = Array.from(new Set(plan.entries.map(({ task }) => task.prompt.trim())));
        setResultsPrompt(distinctPrompts.length === 1 ? distinctPrompts[0] : "");
        void Promise.all(
            plan.entries.map(async ({ task }, index) => {
                const snapshot = {
                    text: task.prompt,
                    config: { ...effectiveConfig, model: task.model, count: "1" },
                    references: [] as ReferenceImage[],
                };
                try {
                    // entries 已按持久化 slotIndex 排序，用当前序号落回相同位置的槽位，避免空槽造成下标错位。
                    const img = await runGenerationSlot(index, snapshot, { taskId: task.taskId, expectedPrompt: task.prompt, expectedModel: task.model });
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
            }),
        ).finally(() => {
            if (recoveryEpochRef.current !== epoch) return;
            setRunning(false);
            setStartedAt(0);
            setRecovering(false);
        });
    }, []);

    // 页面卸载时断开在途请求：只 abort 网络轮询（cancelOnAbort=false），服务端任务保持可恢复，不做取消。
    useEffect(() => {
        return () => {
            Object.values(activeControllersRef.current).forEach((controller) => {
                discardedControllersRef.current.add(controller);
                controller.abort();
            });
        };
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

    const runGenerationBatchInner = async (text: string, agentTaskId?: string) => {
        const snapshot = buildRequestSnapshot(text);
        if (!snapshot) {
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.invalidParams") });
            return;
        }

        setElapsedMs(0);
        setRunning(true);
        if (agentTaskId) updateAgentTask(agentTaskId, { status: "running", error: undefined });
        setPreviewLog(null);
        setResults(Array.from({ length: generationCount }, () => ({ id: nanoid(), status: "pending", prompt: snapshot.text, references: [...snapshot.references] })));
        setResultsPrompt(snapshot.text);
        const batchStartedAt = performance.now();
        setStartedAt(batchStartedAt);

        // 客户端并发限流：一次最多同时请求 4 个槽位，其余等前序完成再发，避免把上游打到限流（配合服务端队列）
        const CLIENT_GENERATION_CONCURRENCY = 4;
        const settled: Array<PromiseSettledResult<GeneratedImage>> = new Array(generationCount);
        let cursor = 0;
        const workers = Array.from({ length: Math.min(CLIENT_GENERATION_CONCURRENCY, generationCount) }, async () => {
            while (cursor < generationCount) {
                const slotIndex = cursor;
                cursor += 1;
                try {
                    const value = await runGenerationSlot(slotIndex, snapshot);
                    settled[slotIndex] = value ? { status: "fulfilled", value } : { status: "rejected", reason: t("imageWorkbench.requestCanceled", "请求已取消") };
                } catch (reason) {
                    settled[slotIndex] = { status: "rejected", reason };
                }
            }
        });
        await Promise.all(workers);
        const result = settled;
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

    /** 工作台批次提交互斥：生成/提交期间忽略重复点击，避免同一需求被并发提交多次。 */
    const runGenerationBatch = async (text: string, agentTaskId?: string) => {
        if (generatingRef.current) {
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("workbench.busy") });
            message.info(t("workbench.busy"));
            return;
        }
        generatingRef.current = true;
        try {
            await runGenerationBatchInner(text, agentTaskId);
        } finally {
            generatingRef.current = false;
        }
    };

    const generateInner = async () => {
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

    /** 生成入口统一加互斥：优化中/生成中/提交中时忽略重复触发，并对 1.5s 内完全相同的提示词去重。 */
    const generate = async () => {
        if (running || optimizing || submittingRef.current) {
            // 早退时清空待处理的 agent 任务归属，避免下一次手动生成把结果记到旧任务上。
            const staleAgentTaskId = agentTaskIdRef.current;
            agentTaskIdRef.current = undefined;
            if (staleAgentTaskId) updateAgentTask(staleAgentTaskId, { status: "failed", error: t("workbench.busy") });
            message.info(t("workbench.busy"));
            return;
        }
        const text = prompt.trim();
        const now = Date.now();
        if (text && lastSubmitRef.current && lastSubmitRef.current.text === text && now - lastSubmitRef.current.at < 1500) return;
        if (text) lastSubmitRef.current = { text, at: now };
        submittingRef.current = true;
        try {
            await generateInner();
        } finally {
            submittingRef.current = false;
        }
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

    // 消费 Agent 面板下发的出图指令：先校验时效与来源归属，再决定是否覆盖输入框/自动出图。
    // 恢复流程进行中时延后消费，等恢复结束（recovering=false）后同一 effect 会再次执行。
    useEffect(() => {
        if (recovering) return;
        if (!imageCommand || imageCommand.nonce <= processedCommandRef.current) return;
        processedCommandRef.current = imageCommand.nonce;
        clearImageCommand();
        const failCommandTask = (reason: string) => {
            if (imageCommand.taskId) updateAgentTask(imageCommand.taskId, { status: "failed", error: reason });
        };
        const resolution = resolveImageCommand(imageCommand, {
            currentPrompt: promptRef.current,
            currentPage: "image",
            activeSessionId: useConversationAgentStore.getState().activeSessionId,
        });
        if (resolution.action === "ignore") {
            if (resolution.reason === "expired") {
                failCommandTask(t("imageWorkbench.commandExpired", "该出图指令已过期，已忽略"));
                message.info(t("imageWorkbench.commandExpired", "该出图指令已过期，已忽略"));
            } else {
                failCommandTask(t("imageWorkbench.promptRequired"));
            }
            return;
        }
        const applyCommand = () => {
            if (typeof resolution.prompt === "string") setPrompt(resolution.prompt);
            if (!resolution.run) return;
            agentTaskIdRef.current = imageCommand.taskId;
            setAutoRunToken((value) => value + 1);
        };
        if (!resolution.requiresConfirm) {
            applyCommand();
            return;
        }
        modal.confirm({
            title: t("imageWorkbench.overwritePromptTitle", "覆盖当前提示词？"),
            content: t("imageWorkbench.overwritePromptContent", "来自其他页面/会话的出图指令会覆盖输入框里已输入的提示词，是否继续？"),
            okText: t("common.confirm", "继续"),
            cancelText: t("common.cancel"),
            onOk: applyCommand,
            onCancel: () => failCommandTask(t("imageWorkbench.commandCanceled", "已取消该出图指令")),
        });
    }, [imageCommand, recovering, clearImageCommand, updateAgentTask, message, modal, t]);

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
        setResultsPrompt("");
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
            setResultsPrompt("");
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
        setResults(log.images.map((image) => ({ id: image.id, status: "success", image, prompt: log.prompt, references: log.references || [] })));
        setResultsPrompt(log.prompt);
    };

    const buildRequestSnapshot = (textOverride?: string, referencesOverride?: ReferenceImage[]) => {
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
        return { text, config: { ...effectiveConfig, model, count: "1" }, references: [...(referencesOverride ?? references)] };
    };

    type RecoveryTaskExpectation = { taskId: string; expectedPrompt: string; expectedModel: string };

    const runGenerationSlot = async (
        index: number,
        snapshot: { text: string; config: AiConfig; references: ReferenceImage[] },
        recovery?: RecoveryTaskExpectation,
    ) => {
        const itemStartedAt = performance.now();
        let currentTaskId: string | undefined = recovery?.taskId;
        const controller = new AbortController();
        activeControllersRef.current[index] = controller;
        // 页面卸载 abort 的请求不再写回结果/持久化任务（任务保持可恢复）；用户主动取消不在此列。
        const isDiscarded = () => discardedControllersRef.current.has(controller);

        try {
            const onProgress = (task: ImageTaskResult) => {
                if (isDiscarded()) return;
                currentTaskId = task.task_id;
                setResults((value) =>
                    updateResultAt(value, index, {
                        taskId: task.task_id,
                        phase: task.status === "queued" ? "queued" : "processing",
                        queuePosition: task.queue_position,
                        estimatedWaitSeconds: task.estimated_wait_seconds,
                        progress: task.progress,
                        durationSeconds: task.duration_seconds,
                        prompt: snapshot.text,
                        references: snapshot.references,
                    }),
                );
                if (task.task_id) {
                    useImageTaskStore.getState().registerActiveTask({
                        taskId: task.task_id,
                        source: "workbench",
                        prompt: snapshot.text,
                        model: snapshot.config.model || snapshot.config.imageModel,
                        baseUrl: snapshot.config.baseUrl,
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
                recoveryTaskId: recovery?.taskId,
                // 页面卸载只断开轮询，不取消服务端任务，回到工作台后可继续恢复。
                cancelOnAbort: false,
                ...(recovery ? { expectedTask: { prompt: recovery.expectedPrompt, model: recovery.expectedModel } } : {}),
                ...(gifWanted
                    ? {
                          outputFormat: "gif" as const,
                          frameCount: Math.min(16, Math.max(2, Math.round(Number(snapshot.config.gifFrames) || 9))),
                          frameDurationMs: Math.min(1000, Math.max(50, Math.round((Number(snapshot.config.gifFrameDuration) || 200) / 10) * 10)),
                      }
                    : {}),
            };

            const requestOnce = () =>
                snapshot.references.length
                    ? requestEdit(snapshot.config, snapshot.text, snapshot.references, requestOpts)
                    : requestGeneration(snapshot.config, snapshot.text, requestOpts);
            let result: Awaited<ReturnType<typeof requestGeneration>>;
            for (let attempt = 0; ; attempt += 1) {
                try {
                    result = await requestOnce();
                    break;
                } catch (error) {
                    // 排队拥挤/上游限流等可恢复错误：等待后自动重试一次，避免并发排队时直接失败
                    if (controller.signal.aborted || attempt >= 1 || !isRetryableGenerationError(error)) throw error;
                    // 重试前取消并丢弃首个已创建的异步 task，避免它的结果/状态被挂到本轮新请求上。
                    if (currentTaskId) {
                        useImageTaskStore.getState().cancelTask(snapshot.config, currentTaskId);
                        currentTaskId = undefined;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 1500));
                }
            }

            const image = result[0];
            if (!image) throw new Error(t("imageWorkbench.missingResult"));
            const stored = await uploadImage(image.dataUrl);
            if (isDiscarded()) return null;
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
            if (!isDiscarded()) {
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
            }
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
        // 只使用失败槽位自身保存的提示词/参考图快照，绝不回落到输入框当前提示词。
        const slotSnapshot = resolveRetrySlotSnapshot(results[index]);
        if (!slotSnapshot) {
            message.error(t("imageWorkbench.retrySnapshotMissing", "该结果缺少槽位提示词快照，请重新生成"));
            return;
        }
        if (generatingRef.current || running || recovering) {
            message.info(t("workbench.busy"));
            return;
        }
        const snapshot = buildRequestSnapshot(slotSnapshot.prompt, slotSnapshot.references);
        if (!snapshot) return;
        generatingRef.current = true;
        setRunning(true);
        setElapsedMs(0);
        setPreviewLog(null);
        setResults((value) => updateResultAt(value, index, { status: "pending", error: undefined, image: undefined, prompt: snapshot.text, references: snapshot.references }));
        const retryStartedAt = performance.now();
        setStartedAt(retryStartedAt);
        try {
            const image = await runGenerationSlot(index, snapshot);
            if (!image) return;
            saveLog(
                buildLog({
                    prompt: snapshot.text,
                    model: snapshot.config.model || snapshot.config.imageModel,
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
        } finally {
            generatingRef.current = false;
            setRunning(false);
            setStartedAt(0);
        }
    };

    return (
        <div className="agent-page-in flex h-full min-h-0 bg-[#faf9f5] text-stone-900 dark:bg-[#1c1b19] dark:text-stone-100">
            <aside className="hidden w-[252px] shrink-0 border-r border-stone-200/70 bg-[#f2efe8] lg:block dark:border-stone-800 dark:bg-[#171614]">
                <LogPanel
                    modelLabel={effectiveConfig.imageModel.split("::").pop() || effectiveConfig.imageModel}
                    chip="IMAGE"
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
            <main className="flex min-w-0 flex-1 flex-col">
                <div className="flex h-12 shrink-0 items-center gap-2 px-3 lg:hidden">
                    <Button size="small" type="text" icon={<Menu className="size-4" />} onClick={() => setLogsOpen(true)} />
                    <span className="text-sm font-semibold">{t("imageWorkbench.title")}</span>
                    <span className="ml-auto sm:hidden">
                        <Button size="small" type="text" icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)} />
                    </span>
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
                                                setLaunchContext({ page: "image", prompt, model, size: config.size, quality: config.quality, count: String(generationCount) });
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
                                    <span className="shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-400/90 dark:text-stone-500">{t("imageWorkbench.references")}</span>
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

                            <div className="flex items-center justify-between gap-3 rounded-xl border border-stone-200/80 bg-white/60 px-3 py-2 text-[11px] text-stone-500 dark:border-stone-800 dark:bg-white/[.03] dark:text-stone-400 sm:hidden">
                                <span className="min-w-0 truncate">
                                    {model.split("::").pop() || model} · {effectiveConfig.size} · {effectiveConfig.quality}
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

                        <div className="sticky bottom-0 z-10 -mx-5 -mb-5 mt-auto bg-gradient-to-t from-[#faf9f5] via-[#faf9f5]/95 to-transparent px-5 pb-2 pt-8 dark:from-[#1c1b19] dark:via-[#1c1b19]/95">
                            <Button
                                type="primary"
                                size="large"
                                block
                                className="!h-11 !rounded-xl !bg-[#1f1e1d] hover:!bg-[#33312c] !text-white dark:!bg-[#f2efe8] dark:!text-stone-900 dark:hover:!bg-white !border-none !font-medium !shadow-2xs hover:!shadow-xs transition-all duration-200 active:scale-[0.99]"
                                icon={<Sparkles className="size-4" />}
                                loading={running || optimizing}
                                disabled={!canGenerate || running || optimizing}
                                onClick={() => void generate()}
                            >
                                {optimizing ? t("imageWorkbench.optimizing") : running ? t("workbench.generating") : t("workbench.generate")}
                            </Button>
                        </div>
                    </div>

                    <div className="thin-scrollbar px-5 py-5 lg:min-h-0 lg:overflow-y-auto">
                        <div className="mb-4 flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2">
                                <span className="shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-400/90 dark:text-stone-500">{t("workbench.results")}</span>
                                {results.length ? <span className="font-mono text-[10px] tabular-nums text-stone-400 dark:text-stone-500">{results.length}</span> : null}
                                {queueStatus ? (
                                    <span className="inline-flex items-center gap-1.5 rounded-full border border-stone-200/80 bg-stone-100/70 px-2 py-0.5 text-[10px] text-stone-500 dark:border-stone-800 dark:bg-stone-800/60 dark:text-stone-400">
                                        <Activity className="size-3 text-stone-400" />
                                        <span>系统队列: {queueStatus.active_tasks} 生成中 · {queueStatus.queued_tasks} 排队</span>
                                    </span>
                                ) : null}
                            </div>
                            {running ? <span className="font-mono text-[10px] tabular-nums text-stone-400 dark:text-stone-500">{t("workbench.waiting", { time: formatDuration(elapsedMs) })}</span> : null}
                        </div>
                        {results.length && !running && resultsPrompt && prompt.trim() !== resultsPrompt ? (
                            <div className="mb-3 rounded-xl border border-amber-200/80 bg-amber-50/70 px-3 py-2 text-[11px] text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
                                {t("imageWorkbench.resultsFromPreviousPrompt", "以上结果来自上一批提示词，修改后的提示词尚未生成；失败格重试会沿用原批次提示词。")}
                            </div>
                        ) : null}
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
                            <div className="flex min-h-[320px] flex-col items-center justify-center px-4 py-16 text-center lg:min-h-[520px]">
                                <div className="relative mb-6 flex size-14 items-center justify-center">
                                    <div className="absolute inset-0 rounded-full bg-stone-200/60 blur-md dark:bg-stone-700/40" />
                                    <div className="relative flex size-12 items-center justify-center rounded-2xl border border-stone-200/90 bg-gradient-to-b from-white to-stone-100/90 shadow-xs dark:border-stone-700/80 dark:from-stone-800 dark:to-stone-900">
                                        <ImagePlus className="size-5 text-stone-600 dark:text-stone-300" />
                                    </div>
                                </div>
                                <h1 className="font-serif text-[24px] font-normal leading-tight tracking-tight text-stone-900 dark:text-stone-100">{t("imageWorkbench.empty")}</h1>
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
                    modelLabel={effectiveConfig.imageModel.split("::").pop() || effectiveConfig.imageModel}
                    chip="IMAGE"
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
            <Drawer title={t("workbench.settings")} placement="right" width={420} open={settingsOpen} onClose={() => setSettingsOpen(false)}>
                <div className="grid grid-cols-1 gap-3 pb-4">
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
        <div className="group relative overflow-hidden rounded-2xl bg-stone-100/60 shadow-xs transition-all duration-300 hover:shadow-md dark:bg-stone-900/40">
            <Image
                src={previewUrlFor(image.storageKey) || image.dataUrl}
                preview={{ src: image.dataUrl, mask: false }}
                alt={t("imageWorkbench.resultAlt", { count: index + 1 })}
                className="agent-fade-in aspect-square w-full object-cover transition-transform duration-500 group-hover:scale-[1.02]"
            />
            {/* 动图 GIF 徽章 */}
            {isGif ? (
                <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-black/55 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-white backdrop-blur-sm">GIF</span>
            ) : null}

            {/* 左下角悬浮元信息角标（hover 时显现） */}
            <div className="absolute bottom-2.5 left-2.5 flex flex-wrap items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                <span className="rounded-full bg-black/45 px-2 py-0.5 font-mono text-[10px] tabular-nums text-white/90 backdrop-blur-sm">
                    {image.width}×{image.height}
                </span>
                <span className="rounded-full bg-black/45 px-2 py-0.5 font-mono text-[10px] tabular-nums text-white/90 backdrop-blur-sm">{formatBytes(image.bytes)}</span>
                <span className="rounded-full bg-black/45 px-2 py-0.5 font-mono text-[10px] tabular-nums text-white/90 backdrop-blur-sm">{formatDuration(image.durationMs)}</span>
            </div>

            {/* 右下角悬浮玻璃拟态操作栏（直接浮于画面上，不占外部空间） */}
            <div
                className="absolute bottom-2.5 right-2.5 flex items-center gap-0.5 rounded-full bg-black/55 px-1 py-0.5 text-white opacity-0 shadow-md backdrop-blur-md transition-opacity duration-200 group-hover:opacity-100 dark:bg-black/70"
                onClick={(event) => event.stopPropagation()}
            >
                <Tooltip title={t("common.addToAssets")}>
                    <button
                        type="button"
                        className="flex size-6 items-center justify-center rounded-full text-white/80 transition hover:bg-white/20 hover:text-white"
                        onClick={() => void onSaveAsset(image, index)}
                    >
                        <FolderPlus className="size-3.5" />
                    </button>
                </Tooltip>
                <Tooltip title={t("imageWorkbench.addReference")}>
                    <button
                        type="button"
                        className="flex size-6 items-center justify-center rounded-full text-white/80 transition hover:bg-white/20 hover:text-white"
                        onClick={() => void onEdit(image, index)}
                    >
                        <PenLine className="size-3.5" />
                    </button>
                </Tooltip>
                <Tooltip title={t("common.download")}>
                    <button
                        type="button"
                        className="flex size-6 items-center justify-center rounded-full text-white/80 transition hover:bg-white/20 hover:text-white"
                        onClick={() => onDownload(image, index)}
                    >
                        <Download className="size-3.5" />
                    </button>
                </Tooltip>
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
    // 只展示服务端返回的真实进度；拿不到进度时展示真实已用时，避免出现假的百分比
    const progressPct = typeof progress === "number" && Number.isFinite(progress) ? Math.min(99, Math.max(1, Math.round(progress * 100))) : undefined;
    const [elapsedSeconds, setElapsedSeconds] = useState(0);

    useEffect(() => {
        if (isQueued) {
            setElapsedSeconds(0);
            return;
        }
        const startedAt = Date.now();
        const timer = window.setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
        return () => window.clearInterval(timer);
    }, [isQueued]);

    const queueLabel =
        typeof queuePosition === "number" && queuePosition > 0
            ? t("workbench.queuePosition", "前方还有 {{count}} 人", { count: queuePosition })
            : t("workbench.queued", "排队等待中");
    const queueWaitLabel =
        typeof estimatedWaitSeconds === "number"
            ? t("workbench.queueEstimate", "预计等待约 {{seconds}} 秒", { seconds: estimatedWaitSeconds })
            : t("workbench.queueHint", "等待服务端分配生成槽位");

    return (
        <div className="relative flex aspect-square flex-col justify-between overflow-hidden rounded-2xl bg-stone-100/50 p-4 dark:bg-stone-900/40">
            <div className="agent-shimmer absolute inset-0 pointer-events-none" />

            {/* Top Status */}
            <div className="relative z-10 flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-stone-200/80 bg-white/80 px-2.5 py-0.5 text-[11px] font-medium text-stone-600 shadow-2xs backdrop-blur-xs dark:border-stone-700/80 dark:bg-stone-800/80 dark:text-stone-300">
                    <span className={cn("size-2 rounded-full", isQueued ? "bg-amber-500 animate-pulse" : "bg-emerald-500 animate-pulse")} />
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
                            <div className="text-xs font-semibold text-stone-800 dark:text-stone-200">{queueLabel}</div>
                            <div className="text-[11px] text-stone-400 dark:text-stone-500">{queueWaitLabel}</div>
                        </div>
                    </div>
                ) : (
                    <div className="flex w-full flex-col items-center gap-2.5 px-4">
                        <div className="relative flex size-10 items-center justify-center rounded-2xl border border-stone-200/80 bg-stone-100/80 text-stone-600 shadow-xs dark:border-stone-700/80 dark:bg-stone-800/60 dark:text-stone-300">
                            <Sparkles className="size-5 animate-pulse" />
                        </div>
                        <div className="w-full space-y-1.5">
                            <div className="flex items-center justify-between text-xs text-stone-600 dark:text-stone-300">
                                <span>{t("workbench.drawing", "正在绘制中...")}</span>
                                <span
                                    title={progressPct !== undefined ? "服务端返回的生成进度" : "已用时（服务端尚未返回进度）"}
                                    className="font-mono font-semibold tabular-nums text-stone-700 dark:text-stone-200"
                                >
                                    {progressPct !== undefined ? `${progressPct}%` : `${elapsedSeconds}s`}
                                </span>
                            </div>
                            {progressPct !== undefined ? (
                                <Progress percent={progressPct} size="small" showInfo={false} strokeColor={{ "0%": "#a8a29e", "100%": "#78716c" }} />
                            ) : (
                                <div className="relative h-1 overflow-hidden rounded-full bg-stone-200/80 dark:bg-stone-700/60">
                                    <div className="agent-shimmer absolute inset-0" />
                                </div>
                            )}
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
                        <button
                            type="button"
                            className="rounded px-1 text-[10px] font-medium text-stone-400 transition hover:text-stone-700 disabled:opacity-40 dark:text-stone-500 dark:hover:text-stone-200"
                            disabled={!logs.length}
                            onClick={toggleAll}
                        >
                            {allSelected ? t("common.cancel") : t("workbench.selectAll")}
                        </button>
                        <button
                            type="button"
                            className="rounded px-1 text-[10px] font-medium text-stone-400 transition hover:text-red-500 disabled:opacity-40 dark:text-stone-500 dark:hover:text-red-400"
                            disabled={!selectedLogIds.length}
                            onClick={onDeleteSelected}
                        >
                            {t("common.delete")}
                        </button>
                    </div>
                </div>
            </div>
            <div className="hover-scrollbar min-h-0 flex-1 space-y-px overflow-y-auto px-2 pb-3">
                {logs.length === 0 ? <div className="px-2 py-6 text-center text-xs text-stone-400 dark:text-stone-500">{t("workbench.noLogs")}</div> : null}
                {logs.map((log) => (
                    <LogCard
                        key={log.id}
                        log={log}
                        selected={selectedLogIds.includes(log.id)}
                        active={activeLogId === log.id}
                        hasSelection={selectedLogIds.length > 0}
                        onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))}
                        onClick={() => onPreviewLog(log)}
                    />
                ))}
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

function LogCard({ log, selected, active, hasSelection, onSelectedChange, onClick }: { log: GenerationLog; selected: boolean; active: boolean; hasSelection: boolean; onSelectedChange: (checked: boolean) => void; onClick: () => void }) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const thumbnails = log.images.filter((image) => image.dataUrl).slice(0, 4);

    return (
        <div className={`group flex items-start gap-1 rounded-lg px-2 py-2 transition-colors ${active ? "bg-black/[.06] dark:bg-white/[.08]" : "hover:bg-black/[.04] dark:hover:bg-white/[.05]"}`}>
            <Checkbox
                className={`mt-0.5 shrink-0 transition-opacity ${selected || hasSelection ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                checked={selected}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => onSelectedChange(event.target.checked)}
            />
            <button type="button" className="min-w-0 flex-1 text-left" onClick={onClick}>
                <div className="flex items-center gap-2">
                    <span className={`min-w-0 flex-1 truncate text-[13px] leading-5 ${selected ? "text-stone-900 dark:text-stone-100" : "text-stone-600 dark:text-stone-300"}`}>{log.title}</span>
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-stone-400 dark:text-stone-500">{log.time}</span>
                </div>
                {thumbnails.length ? (
                    <div className="mt-1 flex gap-1 overflow-hidden">
                        {thumbnails.map((image) => (
                            <img key={image.id} src={previewUrlFor(image.storageKey) || image.dataUrl} alt="" className="size-7 shrink-0 rounded-md object-cover" />
                        ))}
                    </div>
                ) : null}
                <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-stone-400 dark:text-stone-500">
                    <span>{t("workbench.itemCount", { count: log.imageCount })}</span>
                    <span>{t("workbench.successCount", { count: log.successCount ?? log.imageCount })}</span>
                    {log.failCount ? <span className="text-red-500">{t("workbench.failCount", { count: log.failCount })}</span> : null}
                    <span className="tabular-nums">{formatDuration(log.durationMs)}</span>
                </div>
            </button>
        </div>
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
