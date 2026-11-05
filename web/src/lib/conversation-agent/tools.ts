import i18n from "@/i18n";
import { nanoid } from "nanoid";

import { quotaExhausted, useQuotaStore } from "@/stores/use-quota-store";
import { selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { requestGeneration } from "@/services/api/image";
import { uploadImage } from "@/services/image-storage";

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
                count: { type: "integer", minimum: 1, maximum: 4, description: "生成张数，默认 1" },
                size: { type: "string", description: "尺寸，如 1024x1024；省略时使用默认尺寸" },
                quality: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"], description: "质量，省略时使用默认质量" },
                background: { type: "string", enum: ["transparent", "auto"], description: "背景，省略时使用默认值" },
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

function resolveImageModelOption(requested: string): { option: string } | { error: string } {
    const config = useConfigStore.getState().config;
    const options = selectableModelsByCapability(config, "image");
    if (!options.length) return { error: t("toolErrors.noImageModel") as string };
    const name = requested.trim();
    if (!name) {
        const preferred = options.includes(config.imageModel) ? config.imageModel : options[0];
        return { option: preferred };
    }
    if (options.includes(name)) return { option: name };
    const matched = options.find((option) => IMAGE_MODEL_LABEL(option) === name) ?? options.find((option) => IMAGE_MODEL_LABEL(option).toLowerCase() === name.toLowerCase());
    return matched ? { option: matched } : { error: t("toolErrors.unknownModel", { name }) as string };
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
    const resolved = resolveImageModelOption(typeof args.model === "string" ? args.model : "");
    if ("error" in resolved) return failure("generate_image", "invalid_args", resolved.error);
    const config = useConfigStore.getState().config;
    const count = Math.max(1, Math.min(4, typeof args.count === "number" ? args.count : 1));
    const modelOption = resolved.option;
    const generationConfig = {
        ...config,
        model: modelOption,
        count: String(count),
        ...(typeof args.size === "string" && args.size.trim() ? { size: args.size.trim() } : {}),
        ...(typeof args.quality === "string" ? { quality: args.quality } : {}),
        ...(typeof args.background === "string" ? { background: args.background } : {}),
    };
    try {
        const generated = await requestGeneration(generationConfig, prompt, { signal: context.signal });
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
        return { tool: "generate_image", ok: true, images, model: IMAGE_MODEL_LABEL(modelOption), size: generationConfig.size, count: images.length, quota: imageQuotaSnapshot() };
    } catch (error) {
        if (context.signal.aborted) return cancelFailure("generate_image");
        return quotaFailureIfExhausted("generate_image", error);
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

export async function executeAgentTool(call: AgentToolCall, context: { signal: AbortSignal }): Promise<AgentToolResult> {
    const definition = AGENT_TOOLS.find((tool) => tool.name === call.tool);
    if (!definition) return failure(call.tool || "unknown", "unsupported", t("toolErrors.unknownTool", { name: call.tool || "?" }) as string);
    const validation = validateArguments(definition.parameters, call.arguments);
    if (!validation.ok) return failure(call.tool, "invalid_args", validation.error);
    try {
        if (call.tool === "generate_image") return await executeGenerateImage({ ...call, arguments: validation.value }, context);
        return await executeApplyPrompt({ ...call, arguments: validation.value }, context);
    } catch (error) {
        if (context.signal.aborted) return cancelFailure(call.tool);
        return failure(call.tool, "execution_failed", normalizeError(error));
    }
}
