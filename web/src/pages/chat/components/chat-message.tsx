import { App, Button } from "antd";
import { ArrowUpRight, ChevronDown, Copy, RefreshCw, SlidersHorizontal, Sparkles, TriangleAlert } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Streamdown } from "streamdown";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { useCopyText } from "@/hooks/use-copy-text";
import type { AgentImageRef, AgentMessage, AgentToolCall, AgentToolResult } from "@/lib/conversation-agent/types";
import { ensureImagePreview, getImagePreviewRevision, resolveImageUrl, subscribeImagePreviews } from "@/services/image-storage";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { cn } from "@/lib/utils";

import { ImageResultGrid } from "./image-result-card";

function PromptCard({ text }: { text: string }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const copyText = useCopyText();
    const fillWorkbench = () => {
        useWorkbenchAgentStore.getState().dispatchImage({ prompt: text, run: false });
        message.success(t("chat.actions.filledWorkbench"));
    };
    return (
        <div className="overflow-hidden rounded-xl border border-stone-200/90 bg-white dark:border-stone-800 dark:bg-stone-900">
            <div className="flex items-center justify-between gap-2 border-b border-stone-200/70 px-3 py-2 dark:border-stone-800">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-stone-400 dark:text-stone-500">prompt</span>
                <span className="text-[10px] tabular-nums text-stone-400 dark:text-stone-500">{text.length}</span>
            </div>
            <div className="whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[12.5px] leading-6 text-stone-800 dark:text-stone-200">{text}</div>
            <div className="flex items-center justify-end gap-1 border-t border-stone-200/70 px-2 py-1 dark:border-stone-800">
                <Button size="small" type="text" icon={<Copy className="size-3.5" />} onClick={() => copyText(text)}>
                    {t("common.copy")}
                </Button>
                <Button size="small" type="text" icon={<SlidersHorizontal className="size-3.5" />} onClick={fillWorkbench}>
                    {t("chat.actions.fillWorkbench")}
                </Button>
            </div>
        </div>
    );
}

function toolLabel(tool: string, t: (key: string) => string) {
    if (tool === "generate_image") return t("chat.tools.names.generate_image");
    if (tool === "edit_image") return t("chat.tools.names.edit_image");
    if (tool === "apply_prompt") return t("chat.tools.names.apply_prompt");
    return tool || t("chat.tools.names.unknown");
}

function toolArgsSummary(call: AgentToolCall) {
    const prompt = typeof call.arguments.prompt === "string" ? call.arguments.prompt : "";
    const target = call.tool === "apply_prompt" ? (call.arguments.target === "video" ? "video" : "image") : "";
    const detail = prompt || JSON.stringify(call.arguments);
    return target ? `${target} · ${detail}` : detail;
}

function toolResultSummary(result: AgentToolResult, t: (key: string, options?: Record<string, unknown>) => string) {
    if (!result.ok) return result.code;
    if (result.tool === "generate_image" || result.tool === "edit_image") return t("chat.tools.resultImages", { count: result.count, size: result.size });
    return result.target === "video" ? t("chat.tools.videoWorkbench") : t("chat.tools.imageWorkbench");
}

function UserAttachments({ images }: { images: AgentImageRef[] }) {
    const revision = useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const [urls, setUrls] = useState<string[]>([]);
    useEffect(() => {
        let active = true;
        void Promise.all(
            images.map(async (image) => {
                await ensureImagePreview(image.storageKey);
                return resolveImageUrl(image.storageKey);
            }),
        ).then((list) => {
            if (active) setUrls(list);
        });
        return () => {
            active = false;
        };
    }, [images, revision]);
    return (
        <div className="mt-2 flex flex-wrap justify-end gap-1.5">
            {images.map((image, index) => (urls[index] ? <img key={image.id} src={urls[index]} alt="reference" className="size-16 rounded-xl border border-stone-200 object-cover dark:border-stone-700" /> : null))}
        </div>
    );
}

function ToolResultBody({ result, onUseReference }: { result: AgentToolResult; onUseReference?: (image: AgentImageRef) => void }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    if (!result.ok) {
        return (
            <div className="mt-2 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50/70 px-3 py-2 text-xs leading-5 text-red-600 dark:border-red-950 dark:bg-red-950/20 dark:text-red-300">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span className="break-words">{result.error}</span>
            </div>
        );
    }
    if (result.tool === "generate_image" || result.tool === "edit_image") {
        return (
            <div className="mt-2">
                <ImageResultGrid images={result.images} onUseAsReference={onUseReference} />
            </div>
        );
    }
    const target = result.target === "video" ? t("chat.tools.videoWorkbench") : t("chat.tools.imageWorkbench");
    return (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-stone-400 dark:text-stone-500">
            <span>→ {t("chat.tools.applied", { target })}</span>
            <Button size="small" type="text" icon={<ArrowUpRight className="size-3" />} onClick={() => navigate(result.target === "video" ? "/video" : "/image")}>
                {t("chat.tools.open", { target })}
            </Button>
        </div>
    );
}

function ToolMessage({ message, onUseReference }: { message: Extract<AgentMessage, { role: "tool" }>; onUseReference?: (image: AgentImageRef) => void }) {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(false);
    return (
        <div className="agent-message-in flex gap-3">
            <div className="w-7 shrink-0" />
            <div className="min-w-0 flex-1">
                <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-xl border border-stone-200/80 bg-white/60 px-3 py-1.5 text-left text-xs transition hover:bg-white dark:border-stone-800 dark:bg-white/[.025] dark:hover:bg-white/[.05]"
                    onClick={() => setExpanded((value) => !value)}
                >
                    <span className={cn("font-mono", message.result.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-500")}>{message.result.ok ? "✓" : "×"}</span>
                    <span className="shrink-0 font-medium text-stone-700 dark:text-stone-200">{toolLabel(message.call.tool, t)}</span>
                    <span className="min-w-0 flex-1 truncate text-stone-400 dark:text-stone-500">{toolArgsSummary(message.call)}</span>
                    <span className="shrink-0 text-[10px] tabular-nums text-stone-400 dark:text-stone-500">{toolResultSummary(message.result, t)}</span>
                    <ChevronDown className={cn("size-3.5 shrink-0 text-stone-400 transition-transform", expanded && "rotate-180")} />
                </button>
                <div className={cn("agent-collapse", expanded && "is-open")}>
                    <div>
                        <pre className="mt-1.5 max-h-56 overflow-auto rounded-xl border border-stone-200/80 bg-stone-50 px-3 py-2 font-mono text-[10.5px] leading-5 text-stone-500 hover-scrollbar dark:border-stone-800 dark:bg-stone-900/60 dark:text-stone-400">
                            {JSON.stringify(message.call.arguments, null, 2)}
                        </pre>
                    </div>
                </div>
                <ToolResultBody result={message.result} onUseReference={onUseReference} />
            </div>
        </div>
    );
}

export function ChatMessage({ message, onRetry, onUseReference }: { message: AgentMessage; onRetry?: () => void; onUseReference?: (image: AgentImageRef) => void }) {
    const { t } = useTranslation();
    if (message.role === "user") {
        return (
            <div className="agent-message-in flex flex-col items-end">
                <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-stone-200/75 px-4 py-2.5 text-sm leading-6 text-stone-800 dark:bg-stone-800 dark:text-stone-100">{message.text}</div>
                {message.attachments?.length ? <UserAttachments images={message.attachments} /> : null}
            </div>
        );
    }
    if (message.role === "assistant") {
        return (
            <div className="agent-message-in flex gap-3">
                <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400">
                    <Sparkles className="size-3.5" />
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                    {message.text ? <Streamdown className="agent-streamdown text-sm leading-7 text-stone-800 dark:text-stone-200">{message.text}</Streamdown> : null}
                    {message.promptBlocks.length ? (
                        <div className="max-w-xl space-y-2">
                            {message.promptBlocks.map((text, index) => (
                                <PromptCard key={`${message.id}:prompt:${index}`} text={text} />
                            ))}
                        </div>
                    ) : null}
                </div>
            </div>
        );
    }
    if (message.role === "tool") return <ToolMessage message={message} onUseReference={onUseReference} />;
    return (
        <div className="agent-message-in flex gap-3">
            <div className="w-7 shrink-0" />
            <div className="flex max-w-[85%] items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs leading-5 text-amber-700 dark:border-amber-950 dark:bg-amber-950/20 dark:text-amber-300">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <div className="min-w-0 flex-1 break-words">
                    {message.text}
                    {onRetry ? (
                        <Button size="small" type="text" className="mt-0.5 !h-6 !px-1" icon={<RefreshCw className="size-3" />} onClick={onRetry}>
                            {t("chat.actions.retry")}
                        </Button>
                    ) : null}
                </div>
            </div>
        </div>
    );
}
