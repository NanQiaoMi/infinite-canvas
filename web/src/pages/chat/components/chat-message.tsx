import { App, Button } from "antd";
import { ArrowUpRight, ChevronDown, Copy, RefreshCw, SlidersHorizontal, Sparkles, TriangleAlert } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Streamdown } from "streamdown";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { useCopyText } from "@/hooks/use-copy-text";
import { normalizeMarkdownForChat } from "@/lib/conversation-agent/markdown-normalizer";
import type { AgentImageRef, AgentMessage, AgentToolCall, AgentToolResult } from "@/lib/conversation-agent/types";
import { ensureImagePreview, getImagePreviewRevision, resolveImageUrl, subscribeImagePreviews } from "@/services/image-storage";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { cn } from "@/lib/utils";

import { ImageResultGrid } from "./image-result-card";
import { StepTrail } from "./step-trail";

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
                <span className="text-[10px] tabular-nums text-stone-400 dark:text-stone-500">{(text || "").length}</span>
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
    if (tool === "canvas_create_image_node") return "在画布创建生图节点";
    if (tool === "canvas_batch_generate_nodes") return "在画布批量排布生成";
    if (tool === "canvas_create_text_node") return "在画布创建文本便签";
    if (tool === "canvas_update_node") return "更新画布节点";
    if (tool === "canvas_connect_nodes") return "建立节点连线";
    if (tool === "canvas_delete_nodes") return "删除画布节点";
    if (tool === "canvas_focus_nodes") return "聚焦画布视口";
    if (tool === "canvas_get_context") return "获取画布上下文";
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
    if (result.tool === "apply_prompt") return result.target === "video" ? t("chat.tools.videoWorkbench") : t("chat.tools.imageWorkbench");
    return t("chat.tools.imageWorkbench");
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
        <div className="mt-2 flex flex-wrap justify-end gap-2">
            {images.map((image, index) =>
                urls[index] ? (
                    <img
                        key={image.id}
                        src={urls[index]}
                        alt="reference"
                        className="size-16 rounded-xl border border-stone-200/90 object-cover shadow-xs transition-transform duration-200 hover:scale-105 hover:shadow-md dark:border-stone-700/80"
                    />
                ) : null,
            )}
        </div>
    );
}

export function ToolResultBody({ result }: { result: AgentToolResult }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    if (!result.ok) {
        return (
            <div className="mt-2 flex items-start gap-2 rounded-xl border border-red-200/80 bg-red-50/70 px-3.5 py-2.5 text-xs leading-5 text-red-600 shadow-xs dark:border-red-950 dark:bg-red-950/20 dark:text-red-300">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span className="break-words">{result.error}</span>
            </div>
        );
    }
    if (result.tool === "generate_image" || result.tool === "edit_image") {
        return (
            <div className="mt-2.5">
                <ImageResultGrid images={result.images} />
            </div>
        );
    }
    if (result.tool === "canvas_create_image_node") {
        return (
            <div className="mt-2 rounded-lg border border-stone-200/70 bg-stone-50/50 p-2.5 text-xs dark:border-stone-800 dark:bg-stone-900/50">
                <div className="flex items-center justify-between font-medium text-stone-700 dark:text-stone-300">
                    <span>🎨 {result.title}</span>
                    <span className="font-mono text-[11px] text-stone-400">{result.size}</span>
                </div>
                <div className="mt-1 line-clamp-2 text-stone-500 dark:text-stone-400">{result.prompt}</div>
                <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-emerald-600 dark:text-emerald-400">
                    <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    <span>已在画布创建节点并启动精细渲染 (位置: {result.position.x}, {result.position.y})</span>
                </div>
            </div>
        );
    }
    if (result.tool === "canvas_batch_generate_nodes") {
        return (
            <div className="mt-2 space-y-1.5 rounded-lg border border-stone-200/70 bg-stone-50/50 p-2.5 text-xs dark:border-stone-800 dark:bg-stone-900/50">
                <div className="flex items-center justify-between font-medium text-stone-700 dark:text-stone-300">
                    <span>✨ 批量排布生成 ({result.count} 个节点)</span>
                    <span className="text-[11px] text-stone-400">布局: {result.layout}</span>
                </div>
                <div className="grid grid-cols-2 gap-1.5 pt-1">
                    {result.nodes.map((node, i) => (
                        <div key={node.nodeId || i} className="truncate rounded border border-stone-200/60 bg-white/70 px-2 py-1 text-[11px] text-stone-600 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-300">
                            {node.title}: {node.prompt}
                        </div>
                    ))}
                </div>
                <div className="pt-1 flex items-center gap-1.5 text-[10px] text-emerald-600 dark:text-emerald-400">
                    <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    <span>全部节点已在画布网格排开并并行启动渲染</span>
                </div>
            </div>
        );
    }
    if (result.tool === "canvas_create_text_node") {
        return (
            <div className="mt-2 rounded-lg border border-stone-200/70 bg-stone-50/50 p-2 text-xs text-stone-600 dark:border-stone-800 dark:bg-stone-900/50 dark:text-stone-400">
                📝 已在画布添加便签「{result.title}」：{result.text}
            </div>
        );
    }
    if (result.tool === "canvas_update_node") {
        return (
            <div className="mt-2 rounded-lg border border-stone-200/70 bg-stone-50/50 p-2 text-xs text-stone-600 dark:border-stone-800 dark:bg-stone-900/50 dark:text-stone-400">
                🛠️ 已更新画布节点 {result.nodeId}（{result.updatedFields.join(", ")}）{result.rerun ? " 并触发重新生成" : ""}
            </div>
        );
    }
    if (result.tool === "canvas_connect_nodes") {
        return (
            <div className="mt-2 rounded-lg border border-stone-200/70 bg-stone-50/50 p-2 text-xs text-stone-600 dark:border-stone-800 dark:bg-stone-900/50 dark:text-stone-400">
                🔗 已建立连线: {result.fromNodeId} → {result.toNodeId}
            </div>
        );
    }
    if (result.tool === "canvas_delete_nodes") {
        return (
            <div className="mt-2 rounded-lg border border-stone-200/70 bg-stone-50/50 p-2 text-xs text-stone-600 dark:border-stone-800 dark:bg-stone-900/50 dark:text-stone-400">
                🗑️ 已从画布删除 {result.deletedCount} 个节点
            </div>
        );
    }
    if (result.tool === "canvas_focus_nodes") {
        return (
            <div className="mt-2 rounded-lg border border-stone-200/70 bg-stone-50/50 p-2 text-xs text-stone-600 dark:border-stone-800 dark:bg-stone-900/50 dark:text-stone-400">
                🎯 视口已聚焦到 {result.focusedCount} 个目标节点
            </div>
        );
    }
    if (result.tool === "canvas_get_context") {
        return (
            <div className="mt-2 rounded-lg border border-stone-200/70 bg-stone-50/50 p-2 text-xs text-stone-600 dark:border-stone-800 dark:bg-stone-900/50 dark:text-stone-400">
                📋 已读取画布「{result.title}」（当前包含 {result.nodeCount} 个节点）
            </div>
        );
    }
    const target = result.target === "video" ? t("chat.tools.videoWorkbench") : t("chat.tools.imageWorkbench");
    return (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-stone-400 dark:text-stone-500">
            <span>→ {t("chat.tools.applied", { target })}</span>
            <Button size="small" type="text" className="!h-6 !px-1.5 text-stone-600 dark:text-stone-300" icon={<ArrowUpRight className="size-3" />} onClick={() => navigate(result.target === "video" ? "/video" : "/image")}>
                {t("chat.tools.open", { target })}
            </Button>
        </div>
    );
}

function ToolMessage({ message, onRetry }: { message: Extract<AgentMessage, { role: "tool" }>; onRetry?: () => void }) {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(false);
    return (
        <div className="agent-message-in w-full space-y-2">
            <button
                type="button"
                className="flex w-full items-center gap-2.5 rounded-xl border border-stone-200/80 bg-white/60 px-3.5 py-2 text-left text-xs shadow-none transition hover:bg-white hover:border-stone-300 dark:border-stone-800 dark:bg-stone-900/40 dark:hover:bg-stone-900/70"
                onClick={() => setExpanded((value) => !value)}
            >
                <span className={cn("flex size-4 items-center justify-center rounded-full text-[10px] font-bold font-mono", message.result.ok ? "bg-emerald-500/10 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-400" : "bg-red-500/10 text-red-500")}>
                    {message.result.ok ? "✓" : "×"}
                </span>
                <span className="shrink-0 font-medium text-stone-700 dark:text-stone-200">{toolLabel(message.call.tool, t)}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-stone-400 dark:text-stone-500">{toolArgsSummary(message.call)}</span>
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-stone-400 dark:text-stone-500">
                    {toolResultSummary(message.result, t)}
                    {message.durationMs ? ` · ${(message.durationMs / 1000).toFixed(1)}s` : ""}
                </span>
                <ChevronDown className={cn("size-3.5 shrink-0 text-stone-400 transition-transform duration-200", expanded && "rotate-180")} />
            </button>
            {!message.result.ok && onRetry ? (
                <div className="flex justify-end">
                    <button
                        type="button"
                        className="rounded-full px-2.5 py-1 text-[11px] text-stone-500 transition hover:bg-black/[.05] hover:text-stone-700 dark:text-stone-400 dark:hover:bg-white/[.06] dark:hover:text-stone-200"
                        onClick={onRetry}
                    >
                        {t("chat.tools.retry")}
                    </button>
                </div>
            ) : null}
            <div className={cn("agent-collapse", expanded && "is-open")}>
                <div>
                    <pre className="mt-1.5 max-h-56 overflow-auto rounded-xl border border-stone-200/80 bg-stone-50 px-3 py-2 font-mono text-[10.5px] leading-5 text-stone-500 hover-scrollbar dark:border-stone-800 dark:bg-stone-900/60 dark:text-stone-400">
                        {JSON.stringify(message.call.arguments, null, 2)}
                    </pre>
                </div>
            </div>
            <ToolResultBody result={message.result} />
        </div>
    );
}

export function ChatMessage({ message, onRetry, onToolRetry }: { message: AgentMessage; onRetry?: () => void; onToolRetry?: (message: Extract<AgentMessage, { role: "tool" }>) => void }) {
    const { t } = useTranslation();
    if (message.role === "user") {
        return (
            <div className="agent-message-in flex flex-col items-end">
                <div className="max-w-[82%] whitespace-pre-wrap break-words rounded-2xl bg-[#f0eee6] px-4.5 py-2.5 font-serif text-[15px] leading-relaxed text-stone-900 shadow-none dark:bg-[#2b2926] dark:text-stone-100">
                    {message.text}
                </div>
                {message.attachments?.length ? <UserAttachments images={message.attachments} /> : null}
            </div>
        );
    }
    if (message.role === "assistant") {
        return (
            <div className="agent-message-in w-full space-y-3">
                {message.steps?.length ? (
                    <StepTrail steps={message.steps} running={false} defaultExpanded={false} />
                ) : null}
                {message.text ? (
                    <Streamdown className="agent-streamdown">
                        {normalizeMarkdownForChat(message.text)}
                    </Streamdown>
                ) : null}
                {message.promptBlocks.length ? (
                    <div className="max-w-xl space-y-2 pt-1">
                        {message.promptBlocks.map((text, index) => (
                            <PromptCard key={`${message.id}:prompt:${index}`} text={text} />
                        ))}
                    </div>
                ) : null}
            </div>
        );
    }
    if (message.role === "tool") return <ToolMessage message={message} onRetry={onToolRetry ? () => onToolRetry(message) : undefined} />;
    return (
        <div className="agent-message-in w-full">
            <div className="flex max-w-[85%] items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50/70 px-3.5 py-2.5 text-xs leading-5 text-amber-700 shadow-xs dark:border-amber-950 dark:bg-amber-950/20 dark:text-amber-300">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <div className="min-w-0 flex-1 break-words">
                    {message.text}
                    {onRetry ? (
                        <Button size="small" type="text" className="mt-1 !h-6 !px-1.5 text-amber-800 dark:text-amber-200" icon={<RefreshCw className="size-3" />} onClick={onRetry}>
                            {t("chat.actions.retry")}
                        </Button>
                    ) : null}
                </div>
            </div>
        </div>
    );
}
