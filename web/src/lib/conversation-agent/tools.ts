import i18n from "@/i18n";
import { nanoid } from "nanoid";

import { quotaExhausted, useQuotaStore } from "@/stores/use-quota-store";
import { selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useImageTaskStore } from "@/stores/use-image-task-store";
import { requestEdit, requestGeneration } from "@/services/api/image";
import type { ImageTaskResult } from "@/services/api/image-queue";
import { getImageBlob, resolveImageUrl, uploadImage } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";

import { inferImageSizeFromPrompt } from "./aspect-ratio";
import { CANVAS_AGENT_TOOLS, executeCanvasAgentTool, isCanvasTool } from "./canvas-tools";
import { validateArguments } from "./protocol";
import type { AgentImageRef, AgentQuotaSnapshot, AgentToolCall, AgentToolDefinition, AgentToolErrorCode, AgentToolResult } from "./types";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(`chat.${key}`, options);

const IMAGE_MODEL_LABEL = (option: string) => option.split("::").pop() || option;

export const AGENT_TOOLS: AgentToolDefinition[] = [
    {
        name: "generate_image",
        description: "根据提示词生成图片。仅在用户明确要求生成/修改图片时调用；返回图片引用与额度信息。",
        parameters: {
            type: "object",
            properties: {
                prompt: { type: "string", description: "完整的生图提示词" },
                count: { type: "integer", minimum: 1, maximum: 12, description: "生成张数，默认 1，最多 12" },
                size: {
                    type: "string",
                    description: "画幅尺寸/比例（可选，推荐由你根据画面自行判断）。如 1024x1024、1536x1024、1024x1536、768x1024、864x1536、1536x864 等；省略时系统按提示词自动推断，不必套用固定比例。",
                },
                quality: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"], description: "质量，省略时使用默认质量" },
                background: {
                    type: "string",
                    enum: ["transparent", "auto"],
                    description: "背景模式。当用户明确要求「透明底 / 透明背景 / 透明图 / PNG透明图片」时必须传 \"transparent\"，系统将直接下发透明底生成指令输出真实透明 PNG；默认为 \"auto\"",
                },
                format: {
                    type: "string",
                    enum: ["png", "gif"],
                    description: "图片输出格式。当用户要求「动图 / 动态表情包 / 动画 / GIF / 会动的图」时必须传 gif，系统会自动调用动图模型输出真正会动的动态 GIF；默认为 png",
                },
                frame_count: { type: "integer", minimum: 2, maximum: 16, description: "GIF 动图帧数（2-16），默认 9 帧" },
                frame_duration_ms: { type: "integer", minimum: 50, maximum: 1000, description: "GIF 每帧时长毫秒数（50-1000），默认 200ms" },
                model: { type: "string", description: "图片模型名；必须是当前可用图片模型之一" },
            },
            required: ["prompt"],
        },
    },
    {
        name: "edit_image",
        description: "基于用户本轮提供的参考图修改图片（换风格、改背景、加元素等）。参考图由系统自动传入，arguments 只需要 prompt；没有参考图时改用 generate_image。",
        parameters: {
            type: "object",
            properties: {
                prompt: { type: "string", description: "修改要求/提示词" },
                count: { type: "integer", minimum: 1, maximum: 12, description: "生成张数，默认 1，最多 12" },
                size: {
                    type: "string",
                    description: "画幅尺寸/比例（可选）。省略时沿用参考图尺寸或由系统按修改场景推断。",
                },
                quality: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
                background: { type: "string", enum: ["transparent", "auto"] },
                model: { type: "string", description: "图片模型名；必须是当前可用图片模型之一" },
            },
            required: ["prompt"],
        },
    },
    {
        name: "apply_prompt",
        description: "把提示词和参数填入生图或视频工作台，供用户手动生成；默认不自动运行。",
        parameters: {
            type: "object",
            properties: {
                target: { type: "string", enum: ["image", "video"], description: "目标工作台" },
                prompt: { type: "string", description: "要填入的提示词" },
                model: { type: "string", description: "该能力下可用的模型名" },
                size: { type: "string", description: "生图尺寸（仅 image）" },
                quality: { type: "string", description: "生图质量（仅 image）" },
                count: { type: "integer", minimum: 1, maximum: 9, description: "生成张数（仅 image）" },
                run: { type: "boolean", description: "是否同时开始生成，默认 false" },
            },
            required: ["target", "prompt"],
        },
    },
];

function failure(tool: string, code: AgentToolErrorCode, error: string): AgentToolResult {
    return { tool, ok: false, code, error };
}

function resolveImageModelOption(requested: string, format?: "png" | "gif"): { option: string } | { error: string } {
    const config = useConfigStore.getState().config;
    const options = selectableModelsByCapability(config, "image");
    if (!options.length) return { error: t("toolErrors.noImageModel") as string };
    const isGif = format === "gif";
    const name = requested.trim();
    if (name) {
        if (options.includes(name)) {
            if (isGif && !/gpt-image-2\.6/i.test(name)) {
                const gifModel = options.find((m) => /gpt-image-2\.6/i.test(m));
                if (gifModel) return { option: gifModel };
            }
            return { option: name };
        }
        const matched = options.find((option) => IMAGE_MODEL_LABEL(option) === name) ?? options.find((option) => IMAGE_MODEL_LABEL(option).toLowerCase() === name.toLowerCase());
        if (matched) return { option: matched };
    }
    if (isGif) {
        const gifModel = options.find((m) => /gpt-image-2\.6/i.test(m));
        if (gifModel) return { option: gifModel };
    }
    const preferred = options.includes(config.imageModel) ? config.imageModel : options[0];
    return { option: preferred };
}

function imageQuotaSnapshot(): AgentQuotaSnapshot | undefined {
    const usage = useQuotaStore.getState().status?.capabilities?.image;
    if (!usage) return undefined;
    return { dailyUsed: usage.dailyUsed, dailyLimit: usage.dailyLimit, weeklyUsed: usage.weeklyUsed, weeklyLimit: usage.weeklyLimit };
}

function cancelFailure(tool: string) {
    return failure(tool, "canceled", t("toolErrors.canceled") as string);
}

function normalizeError(error: unknown) {
    if (error instanceof Error) return error.message || String(error);
    return String(error);
}

async function quotaFailureIfExhausted(tool: string, error: unknown): Promise<AgentToolResult> {
    const state = useQuotaStore.getState();
    if (typeof state.refresh === "function") await state.refresh().catch(() => undefined);
    if (quotaExhausted(useQuotaStore.getState().status, "image")) return failure(tool, "quota_exceeded", normalizeError(error));
    return failure(tool, "execution_failed", normalizeError(error));
}

async function executeGenerateImage(call: AgentToolCall, context: { signal: AbortSignal }): Promise<AgentToolResult> {
    const args = call.arguments;
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!prompt) return failure("generate_image", "invalid_args", t("toolErrors.promptRequired") as string);
    const isGif = args.format === "gif" || /动图|动态表情包|动态图|\bgif\b|会动的/i.test(prompt);
    const resolved = resolveImageModelOption(typeof args.model === "string" ? args.model : "", isGif ? "gif" : "png");
    if ("error" in resolved) return failure("generate_image", "invalid_args", resolved.error);
    const config = useConfigStore.getState().config;
    const count = Math.max(1, Math.min(12, typeof args.count === "number" ? args.count : 1));
    const modelOption = resolved.option;
    const requestedSize = typeof args.size === "string" && args.size.trim() ? args.size.trim() : "";
    const size = isGif ? "auto" : (requestedSize || inferImageSizeFromPrompt(prompt, config.size));
    const generationConfig = {
        ...config,
        model: modelOption,
        count: String(count),
        size,
        ...(typeof args.quality === "string" ? { quality: args.quality } : {}),
        ...(typeof args.background === "string" ? { background: args.background } : {}),
    };
    let currentTaskId: string | undefined;
    try {
        const onProgress = (task: ImageTaskResult) => {
            currentTaskId = task.task_id;
            if (task.task_id) {
                useImageTaskStore.getState().registerActiveTask({
                    taskId: task.task_id,
                    source: "chat",
                    prompt,
                    model: IMAGE_MODEL_LABEL(modelOption),
                    size: generationConfig.size,
                    createdAt: Date.now(),
                    status: task.status,
                    queuePosition: task.queue_position,
                    estimatedWaitSeconds: task.estimated_wait_seconds,
                    progress: task.progress,
                    durationSeconds: task.duration_seconds,
                });
            }
        };
        const requestOptions = isGif
            ? {
                  signal: context.signal,
                  outputFormat: "gif" as const,
                  frameCount: Math.min(16, Math.max(2, Math.round(Number(args.frame_count) || 9))),
                  frameDurationMs: Math.min(1000, Math.max(50, Math.round(Number(args.frame_duration_ms) || 200))),
                  onProgress,
              }
            : { signal: context.signal, onProgress };
        const generated = await requestGeneration(generationConfig, prompt, requestOptions);
        if (currentTaskId) {
            useImageTaskStore.getState().completeActiveTask(currentTaskId, "succeeded");
        }
        if (!generated.length) return failure("generate_image", "execution_failed", t("toolErrors.noImageReturned") as string);
        const stored = await Promise.all(generated.map((image) => uploadImage(image.dataUrl)));
        await useQuotaStore.getState().refresh().catch(() => undefined);
        const images: AgentImageRef[] = stored.map((image) => ({
            id: `img_${nanoid(6)}`,
            storageKey: image.storageKey,
            width: image.width,
            height: image.height,
            prompt,
            model: IMAGE_MODEL_LABEL(modelOption),
        }));
        return {
            tool: "generate_image",
            ok: true,
            images,
            model: IMAGE_MODEL_LABEL(modelOption),
            size: generationConfig.size,
            count: images.length,
            ...(isGif ? { format: "gif" } : {}),
            quota: imageQuotaSnapshot(),
        };
    } catch (error) {
        if (currentTaskId) {
            useImageTaskStore.getState().completeActiveTask(currentTaskId, context.signal.aborted ? "cancelled" : "failed", error instanceof Error ? error.message : String(error));
        }
        if (context.signal.aborted) return cancelFailure("generate_image");
        return quotaFailureIfExhausted("generate_image", error);
    }
}

async function executeEditImage(call: AgentToolCall, context: { signal: AbortSignal; references?: AgentImageRef[] }): Promise<AgentToolResult> {
    const args = call.arguments;
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!prompt) return failure("edit_image", "invalid_args", t("toolErrors.promptRequired") as string);
    const candidates = (context.references ?? []).filter((reference) => reference.storageKey);
    if (!candidates.length) return failure("edit_image", "invalid_args", t("toolErrors.referenceRequired") as string);
    const resolved = resolveImageModelOption(typeof args.model === "string" ? args.model : "");
    if ("error" in resolved) return failure("edit_image", "invalid_args", resolved.error);
    const config = useConfigStore.getState().config;
    const count = Math.max(1, Math.min(12, typeof args.count === "number" ? args.count : 1));
    const modelOption = resolved.option;
    const requestedSize = typeof args.size === "string" && args.size.trim() ? args.size.trim() : "";
    const size = requestedSize || inferImageSizeFromPrompt(prompt, config.size);
    const generationConfig = {
        ...config,
        model: modelOption,
        count: String(count),
        size,
        ...(typeof args.quality === "string" ? { quality: args.quality } : {}),
        ...(typeof args.background === "string" ? { background: args.background } : {}),
    };
    let currentTaskId: string | undefined;
    try {
        const onProgress = (task: ImageTaskResult) => {
            currentTaskId = task.task_id;
            if (task.task_id) {
                useImageTaskStore.getState().registerActiveTask({
                    taskId: task.task_id,
                    source: "chat",
                    prompt,
                    model: IMAGE_MODEL_LABEL(modelOption),
                    size: generationConfig.size,
                    createdAt: Date.now(),
                    status: task.status,
                    queuePosition: task.queue_position,
                    estimatedWaitSeconds: task.estimated_wait_seconds,
                    progress: task.progress,
                    durationSeconds: task.duration_seconds,
                });
            }
        };
        const references: ReferenceImage[] = await Promise.all(
            candidates.map(async (reference) => {
                const url = await resolveImageUrl(reference.storageKey);
                const blob = reference.storageKey ? await getImageBlob(reference.storageKey) : null;
                return { id: reference.id, name: `${reference.id}.png`, type: blob?.type || "image/png", dataUrl: url, storageKey: reference.storageKey };
            }),
        );
        const generated = await requestEdit(generationConfig, prompt, references, { signal: context.signal, onProgress });
        if (currentTaskId) {
            useImageTaskStore.getState().completeActiveTask(currentTaskId, "succeeded");
        }
        if (!generated.length) return failure("edit_image", "execution_failed", t("toolErrors.noImageReturned") as string);
        const stored = await Promise.all(generated.map((image) => uploadImage(image.dataUrl)));
        await useQuotaStore.getState().refresh().catch(() => undefined);
        const images: AgentImageRef[] = stored.map((image) => ({
            id: `img_${nanoid(6)}`,
            storageKey: image.storageKey,
            width: image.width,
            height: image.height,
            prompt,
            model: IMAGE_MODEL_LABEL(modelOption),
        }));
        return { tool: "edit_image", ok: true, images, model: IMAGE_MODEL_LABEL(modelOption), size: generationConfig.size, count: images.length, quota: imageQuotaSnapshot() };
    } catch (error) {
        if (currentTaskId) {
            useImageTaskStore.getState().completeActiveTask(currentTaskId, context.signal.aborted ? "cancelled" : "failed", error instanceof Error ? error.message : String(error));
        }
        if (context.signal.aborted) return cancelFailure("edit_image");
        return quotaFailureIfExhausted("edit_image", error);
    }
}

async function executeApplyPrompt(call: AgentToolCall, context: { signal: AbortSignal }): Promise<AgentToolResult> {
    const args = call.arguments;
    if (context.signal.aborted) return cancelFailure("apply_prompt");
    const target = args.target === "video" ? "video" : args.target === "image" ? "image" : null;
    if (!target) return failure("apply_prompt", "invalid_args", t("toolErrors.invalidTarget") as string);
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!prompt) return failure("apply_prompt", "invalid_args", t("toolErrors.promptRequired") as string);
    const configStore = useConfigStore.getState();
    const capability = target === "image" ? "image" : "video";
    if (typeof args.model === "string" && args.model.trim()) {
        const options = selectableModelsByCapability(configStore.config, capability);
        const name = args.model.trim();
        const matched = options.includes(name) ? name : options.find((option) => IMAGE_MODEL_LABEL(option) === name);
        if (!matched) return failure("apply_prompt", "invalid_args", t("toolErrors.unknownModel", { name }) as string);
        configStore.updateConfig(target === "image" ? "imageModel" : "videoModel", matched);
    }
    if (target === "image") {
        if (typeof args.size === "string" && args.size.trim()) configStore.updateConfig("size", args.size.trim());
        if (typeof args.quality === "string" && args.quality.trim()) configStore.updateConfig("quality", args.quality.trim());
        if (typeof args.count === "number") configStore.updateConfig("count", String(Math.max(1, Math.min(9, args.count))));
    }
    const workbench = useWorkbenchAgentStore.getState();
    const run = args.run === true;
    if (target === "image") workbench.dispatchImage({ prompt, run });
    else workbench.dispatchVideo({ prompt, run });
    return { tool: "apply_prompt", ok: true, target, prompt };
}

export const ALL_AGENT_TOOLS: AgentToolDefinition[] = [...AGENT_TOOLS, ...CANVAS_AGENT_TOOLS];

export async function executeAgentTool(call: AgentToolCall, context: { signal: AbortSignal; references?: AgentImageRef[] }): Promise<AgentToolResult> {
    const definition = ALL_AGENT_TOOLS.find((tool) => tool.name === call.tool);
    if (!definition) return failure(call.tool || "unknown", "unsupported", t("toolErrors.unknownTool", { name: call.tool || "?" }) as string);
    const validation = validateArguments(definition.parameters, call.arguments);
    if (!validation.ok) return failure(call.tool, "invalid_args", validation.error);
    try {
        if (isCanvasTool(call.tool)) {
            const hasCanvasContext = Boolean(useAgentStore.getState().canvasContext);
            if (!hasCanvasContext) {
                if (call.tool === "canvas_batch_generate_nodes") {
                    const rawTasks = Array.isArray(call.arguments?.tasks) ? (call.arguments.tasks as Array<{ prompt?: string; size?: string; background?: string }>) : [];
                    const tasks = rawTasks.filter((t) => typeof t?.prompt === "string" && t.prompt.trim());
                    if (tasks.length > 0) {
                        // 在非画布环境（如独立AI对话页面）中优雅降级为直接并发生成图片，彻底杜绝报错引发的 ReAct 循环失控
                        const results = await Promise.all(
                            tasks.map((task) =>
                                executeGenerateImage(
                                    {
                                        tool: "generate_image",
                                        arguments: {
                                            prompt: task.prompt!.trim(),
                                            size: task.size || "1024x1024",
                                            count: 1,
                                            ...(task.background ? { background: task.background } : {}),
                                        },
                                    },
                                    context,
                                ),
                            ),
                        );
                        const successfulImages = results.flatMap((r) => (r.ok && "images" in r ? r.images : []));
                        if (successfulImages.length > 0) {
                            return {
                                tool: "generate_image",
                                ok: true,
                                images: successfulImages,
                                model: results.find((r) => r.ok && "model" in r && r.model)?.model || "gpt-image-2.5",
                                size: tasks[0]?.size || "1024x1024",
                                count: successfulImages.length,
                            };
                        }
                        const firstErr = results.find((r) => !r.ok);
                        return firstErr || failure("generate_image", "execution_failed", "批量图片生成未产生有效输出");
                    }
                } else if (call.tool === "canvas_create_image_node") {
                    const prompt = typeof call.arguments?.prompt === "string" ? call.arguments.prompt.trim() : "";
                    const size = typeof call.arguments?.size === "string" ? call.arguments.size.trim() : "1024x1024";
                    const background = call.arguments?.background === "transparent" ? "transparent" : undefined;
                    return await executeGenerateImage(
                        {
                            tool: "generate_image",
                            arguments: { prompt, size, count: 1, ...(background ? { background } : {}) },
                        },
                        context,
                    );
                }
            }
            return await executeCanvasAgentTool(call);
        }
        if (call.tool === "generate_image") return await executeGenerateImage({ ...call, arguments: validation.value }, context);
        if (call.tool === "edit_image") return await executeEditImage({ ...call, arguments: validation.value }, context);
        return await executeApplyPrompt({ ...call, arguments: validation.value }, context);
    } catch (error) {
        if (context.signal.aborted) return cancelFailure(call.tool);
        return failure(call.tool, "execution_failed", normalizeError(error));
    }
}
