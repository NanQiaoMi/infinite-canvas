import { Sparkles, Wand2 } from "lucide-react";
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

/**
 * 模拟生成进度（从 0% 流畅走向 98%），赋予用户清晰的生成心理预期
 */
function estimateProgress(elapsedSeconds: number): number {
    if (elapsedSeconds <= 2) return Math.min(25, Math.round(elapsedSeconds * 12));
    if (elapsedSeconds <= 8) return Math.min(68, Math.round(25 + (elapsedSeconds - 2) * 7));
    if (elapsedSeconds <= 16) return Math.min(90, Math.round(68 + (elapsedSeconds - 8) * 2.75));
    return Math.min(98, Math.round(90 + (elapsedSeconds - 16) * 0.5));
}

export function GenerationWaiting({ call, startedAt }: { call: AgentToolCall; startedAt: number }) {
    const { t } = useTranslation();
    const [elapsedMs, setElapsedMs] = useState(() => Date.now() - startedAt);

    useEffect(() => {
        setElapsedMs(Date.now() - startedAt);
        const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 250);
        return () => window.clearInterval(timer);
    }, [startedAt]);

    const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
    const progress = estimateProgress(elapsedSeconds);

    const phase =
        elapsedSeconds < 3
            ? t("chat.waiting.phasePrepare")
            : elapsedSeconds < 14
              ? t("chat.waiting.phaseRequest")
              : t("chat.waiting.phaseRender");

    const count = Math.max(1, Math.min(4, Number(call.arguments.count) || 1));
    const aspect = parseAspect(call.arguments.size);
    const isEdit = call.tool === "edit_image";
    const prompt = typeof call.arguments.prompt === "string" ? call.arguments.prompt : "";
    const size = typeof call.arguments.size === "string" ? call.arguments.size : "";
    const columns = useMemo(() => (count <= 1 ? 1 : 2), [count]);

    return (
        <div className="agent-message-in flex gap-3">
            {/* 助手头像：微光呼吸星标 */}
            <div className="mt-0.5 flex size-7.5 shrink-0 items-center justify-center rounded-full border border-stone-200/90 bg-gradient-to-b from-stone-50 to-stone-100 text-stone-600 shadow-xs dark:border-stone-700/80 dark:from-stone-800 dark:to-stone-900 dark:text-stone-300">
                <Sparkles className="agent-spin size-3.5 text-amber-500/90 dark:text-amber-400" />
            </div>

            <div className="min-w-0 flex-1">
                {/* 状态与进度信息栏 */}
                <div className="flex items-center gap-2 text-xs">
                    <span className="flex items-center gap-1.5 font-medium text-stone-800 dark:text-stone-200">
                        {isEdit ? <Wand2 className="size-3 text-amber-500" /> : <Sparkles className="size-3 text-amber-500" />}
                        {isEdit ? t("chat.tools.names.edit_image") : t("chat.tools.names.generate_image")}
                    </span>

                    {size ? (
                        <span className="font-mono text-[10px] text-stone-400 dark:text-stone-500">
                            {size}
                        </span>
                    ) : null}

                    {prompt ? (
                        <span className="min-w-0 flex-1 truncate text-stone-400 dark:text-stone-500" title={prompt}>
                            · {prompt}
                        </span>
                    ) : (
                        <span className="flex-1" />
                    )}

                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-stone-400 dark:text-stone-500">
                        0:{String(elapsedSeconds).padStart(2, "0")}
                    </span>
                </div>

                {/* 骨架生成屏（现代感极光与光圈动效） */}
                <div
                    className="mt-2.5 grid max-w-[420px] gap-2.5"
                    style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
                >
                    {Array.from({ length: count }).map((_, index) => (
                        <div
                            key={index}
                            className="group relative overflow-hidden rounded-2xl border border-stone-200/90 bg-gradient-to-br from-stone-100 via-stone-50 to-stone-100/60 p-1 shadow-xs dark:border-stone-800 dark:from-stone-900/90 dark:via-stone-900/40 dark:to-stone-950"
                            style={{
                                aspectRatio: String(aspect),
                                animationDelay: `${index * 0.15}s`,
                            }}
                        >
                            {/* 流动微光背景层 */}
                            <div className="agent-shimmer absolute inset-0 opacity-80 dark:opacity-60" />

                            {/* 聚能光环与中心微光星标 */}
                            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 p-4 text-center">
                                <div className="relative flex size-12 items-center justify-center">
                                    {/* 外圈缓慢旋转光晕 */}
                                    <div className="absolute inset-0 animate-[spin_6s_linear_infinite] rounded-full border border-dashed border-stone-400/40 dark:border-stone-600/40" />
                                    {/* 内圈反向脉动光环 */}
                                    <div className="absolute inset-1.5 animate-[spin_3s_linear_infinite_reverse] rounded-full border-t-2 border-stone-500/70 dark:border-stone-400/80" />
                                    {/* 核心微光四芒星 */}
                                    <Sparkles className="size-4 animate-pulse text-stone-600 dark:text-stone-300" />
                                </div>

                                <div className="space-y-0.5">
                                    <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-stone-400 dark:text-stone-500">
                                        img {index + 1}
                                    </span>
                                    <div className="font-mono text-[11px] font-medium tabular-nums text-stone-600 dark:text-stone-300">
                                        {progress}%
                                    </div>
                                </div>
                            </div>

                            {/* 底部微型进度条 */}
                            <div className="absolute inset-x-0 bottom-0 h-1 bg-stone-200/50 dark:bg-stone-800/60">
                                <div
                                    className="h-full bg-gradient-to-r from-stone-400 to-amber-500/90 transition-all duration-300 dark:from-stone-500 dark:to-amber-400"
                                    style={{ width: `${progress}%` }}
                                />
                            </div>
                        </div>
                    ))}
                </div>

                {/* 阶段状态与流逝时间提示 */}
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-stone-500 dark:text-stone-400">
                    <span className="inline-flex items-center gap-1.5">
                        <span className="size-1.5 animate-pulse rounded-full bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.6)]" />
                        {isEdit ? t("chat.waiting.editing") : t("chat.waiting.generating")}
                    </span>
                    <span className="text-stone-300 dark:text-stone-700">·</span>
                    <span key={phase} className="agent-fade-in font-medium text-stone-600 dark:text-stone-300">
                        {phase}
                    </span>
                    <span className="ml-auto font-mono text-[10px] tabular-nums text-stone-400 dark:text-stone-500">
                        {t("chat.waiting.elapsed", { seconds: elapsedSeconds })}
                    </span>
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
        <div className="agent-fade-in flex gap-3">
            <div className="mt-0.5 flex size-7.5 shrink-0 items-center justify-center rounded-full border border-stone-200/90 bg-gradient-to-b from-stone-50 to-stone-100 text-stone-500 shadow-xs dark:border-stone-700/80 dark:from-stone-800 dark:to-stone-900 dark:text-stone-400">
                <Sparkles className="agent-spin size-3.5 text-stone-400 dark:text-stone-500" />
            </div>
            <div className="flex flex-1 items-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                <span className="agent-shimmer-text font-serif text-[13px] tracking-wide">
                    {t("chat.thinking")}
                </span>
                <span className="flex items-center gap-1 text-stone-400 dark:text-stone-600">
                    <span className="agent-dot" />
                    <span className="agent-dot" />
                    <span className="agent-dot" />
                </span>
                <span className="ml-auto font-mono text-[10px] tabular-nums text-stone-400 dark:text-stone-500">
                    {t("chat.waiting.elapsed", { seconds: elapsedSeconds })}
                </span>
            </div>
        </div>
    );
}
