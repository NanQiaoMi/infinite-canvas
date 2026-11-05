import { App, Button } from "antd";
import { ArrowUpRight, Copy, RefreshCw, SlidersHorizontal, TriangleAlert, Wrench } from "lucide-react";
import { Streamdown } from "streamdown";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { useCopyText } from "@/hooks/use-copy-text";
import type { AgentMessage, AgentToolResult } from "@/lib/conversation-agent/types";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";

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
        <div className="overflow-hidden rounded-xl border border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-900/60">
            <div className="flex items-center justify-between gap-2 border-b border-stone-200 px-3 py-1.5 text-[11px] text-stone-500 dark:border-stone-800 dark:text-stone-400">
                <span>{t("chat.promptCard")}</span>
                <span className="tabular-nums">{text.length}</span>
            </div>
            <div className="whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[13px] leading-6 text-stone-800 dark:text-stone-100">{text}</div>
            <div className="flex items-center justify-end gap-1 border-t border-stone-200 px-2 py-1 dark:border-stone-800">
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
    if (tool === "apply_prompt") return t("chat.tools.names.apply_prompt");
    return tool || t("chat.tools.names.unknown");
}

function ToolResultBody({ result }: { result: AgentToolResult }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    if (!result.ok) {
        return (
            <div className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-300">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span className="break-words">{result.error}</span>
            </div>
        );
    }
    if (result.tool === "generate_image") {
        return (
            <div className="space-y-2">
                <div className="text-xs text-stone-500 dark:text-stone-400">
                    {t("chat.tools.generated", { count: result.count, model: result.model, size: result.size })}
                    {result.quota ? ` · ${t("chat.tools.quota", { used: result.quota.dailyUsed, limit: result.quota.dailyLimit })}` : ""}
                </div>
                <ImageResultGrid images={result.images} />
            </div>
        );
    }
    const target = result.target === "video" ? t("chat.tools.videoWorkbench") : t("chat.tools.imageWorkbench");
    return (
        <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
            <span>{t("chat.tools.applied", { target })}</span>
            <Button size="small" type="text" icon={<ArrowUpRight className="size-3.5" />} onClick={() => navigate(result.target === "video" ? "/video" : "/image")}>
                {t("chat.tools.open", { target })}
            </Button>
        </div>
    );
}

export function ChatMessage({ message, onRetry }: { message: AgentMessage; onRetry?: () => void }) {
    const { t } = useTranslation();
    if (message.role === "user") {
        return (
            <div className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-stone-900 px-3.5 py-2 text-sm leading-6 text-white dark:bg-stone-100 dark:text-stone-900">{message.text}</div>
            </div>
        );
    }
    if (message.role === "assistant") {
        return (
            <div className="flex justify-start">
                <div className="w-full min-w-0 space-y-2">
                    {message.text ? <Streamdown className="agent-streamdown text-sm leading-7">{message.text}</Streamdown> : null}
                    {message.promptBlocks.map((text, index) => (
                        <PromptCard key={`${message.id}:prompt:${index}`} text={text} />
                    ))}
                </div>
            </div>
        );
    }
    if (message.role === "tool") {
        return (
            <div className="flex justify-start">
                <div className="w-full min-w-0 space-y-2 rounded-xl border border-stone-200 bg-stone-50/70 px-3 py-2 dark:border-stone-800 dark:bg-stone-900/40">
                    <div className="flex items-center gap-2 text-xs font-medium text-stone-600 dark:text-stone-300">
                        <Wrench className="size-3.5" />
                        {toolLabel(message.call.tool, t)}
                        <span className={message.result.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-500"}>{message.result.ok ? t("chat.tools.success") : t("chat.tools.failed")}</span>
                    </div>
                    {typeof message.call.arguments.prompt === "string" ? <div className="truncate text-[11px] text-stone-400">{message.call.arguments.prompt}</div> : null}
                    <ToolResultBody result={message.result} />
                </div>
            </div>
        );
    }
    return (
        <div className="flex justify-start">
            <div className="flex max-w-[90%] items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <div className="min-w-0 flex-1 break-words">
                    {message.text}
                    {onRetry ? (
                        <Button size="small" type="text" className="mt-1 !px-1" icon={<RefreshCw className="size-3.5" />} onClick={onRetry}>
                            {t("chat.actions.retry")}
                        </Button>
                    ) : null}
                </div>
            </div>
        </div>
    );
}
