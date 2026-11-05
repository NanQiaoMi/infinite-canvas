import { Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AgentToolCall } from "@/lib/conversation-agent/types";

function parseAspect(size: unknown) {
    if (typeof size !== "string") return 1;
    const match = size.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
    if (!match) return 1;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) return 1;
    return Math.min(2, Math.max(0.5, width / height));
}

export function GenerationWaiting({ call, startedAt }: { call: AgentToolCall; startedAt: number }) {
    const { t } = useTranslation();
    const [elapsedMs, setElapsedMs] = useState(() => Date.now() - startedAt);
    useEffect(() => {
        setElapsedMs(Date.now() - startedAt);
        const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
        return () => window.clearInterval(timer);
    }, [startedAt]);
    const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
    const phase = elapsedSeconds < 3 ? t("chat.waiting.phasePrepare") : elapsedSeconds < 15 ? t("chat.waiting.phaseRequest") : t("chat.waiting.phaseRender");
    const count = Math.max(1, Math.min(4, Number(call.arguments.count) || 1));
    const aspect = parseAspect(call.arguments.size);
    const isEdit = call.tool === "edit_image";
    const prompt = typeof call.arguments.prompt === "string" ? call.arguments.prompt : "";
    const columns = useMemo(() => (count <= 1 ? 1 : 2), [count]);
    return (
        <div className="flex gap-3">
            <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400">
                <Sparkles className="agent-spin size-3.5" />
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-xs">
                    <span className="font-medium text-stone-700 dark:text-stone-200">{isEdit ? t("chat.tools.names.edit_image") : t("chat.tools.names.generate_image")}</span>
                    <span className="min-w-0 flex-1 truncate text-stone-400 dark:text-stone-500">{prompt}</span>
                    <span className="shrink-0 tabular-nums text-[11px] text-stone-400 dark:text-stone-500">0:{String(elapsedSeconds).padStart(2, "0")}</span>
                </div>
                <div className="mt-2 grid max-w-[360px] gap-2" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
                    {Array.from({ length: count }).map((_, index) => (
                        <div key={index} className="agent-shimmer relative overflow-hidden rounded-xl border border-stone-200/80 dark:border-stone-800" style={{ aspectRatio: String(aspect) }}>
                            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                                <div className="size-5 animate-spin rounded-full border-2 border-stone-300 border-t-stone-500 dark:border-stone-700 dark:border-t-stone-300" />
                                <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">img {index + 1}</span>
                            </div>
                        </div>
                    ))}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-stone-400 dark:text-stone-500">
                    <span className="inline-flex items-center gap-1.5">
                        <span className="size-1.5 animate-pulse rounded-full bg-amber-500" />
                        {isEdit ? t("chat.waiting.editing") : t("chat.waiting.generating")}
                    </span>
                    <span>{phase}</span>
                    <span className="ml-auto tabular-nums">{t("chat.waiting.elapsed", { seconds: elapsedSeconds })}</span>
                </div>
            </div>
        </div>
    );
}

export function ThinkingLine({ startedAt }: { startedAt: number }) {
    const { t } = useTranslation();
    const [elapsedMs, setElapsedMs] = useState(() => Date.now() - startedAt);
    useEffect(() => {
        setElapsedMs(Date.now() - startedAt);
        const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
        return () => window.clearInterval(timer);
    }, [startedAt]);
    const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
    return (
        <div className="flex gap-3">
            <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400">
                <Sparkles className="agent-spin size-3.5" />
            </div>
            <div className="flex flex-1 items-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                <span className="agent-shimmer-text">{t("chat.thinking")}</span>
                <span className="flex items-center gap-0.5 text-stone-300 dark:text-stone-600">
                    <span className="agent-dot" />
                    <span className="agent-dot" />
                    <span className="agent-dot" />
                </span>
                <span className="ml-auto text-[11px] tabular-nums text-stone-400 dark:text-stone-500">{t("chat.waiting.elapsed", { seconds: elapsedSeconds })}</span>
            </div>
        </div>
    );
}
