import { Sparkles, Wand2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AgentToolCall } from "@/lib/conversation-agent/types";
import { cn } from "@/lib/utils";

import { ChatGptDotMatrix } from "./chatgpt-dot-matrix";

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
 * 模拟生图进度百分比（精确映射 ChatGPT DALL-E 3 生成节奏）：
 * 4 秒左右恰好处于 39%~42%，契合官方截图勾勒草图阶段。
 */
export function estimateProgress(elapsedSeconds: number, indexOffset = 0): number {
    const s = Math.max(0, elapsedSeconds - indexOffset * 0.4);
    if (s <= 1) return Math.min(14, Math.round(s * 14));
    if (s <= 4) return Math.min(42, Math.round(14 + (s - 1) * 9.3));
    if (s <= 8) return Math.min(70, Math.round(42 + (s - 4) * 7));
    if (s <= 15) return Math.min(90, Math.round(70 + (s - 8) * 2.85));
    return Math.min(98, Math.round(90 + (s - 15) * 0.5));
}

/**
 * ChatGPT 官方风格生图卡片组件：
 * 彻底移除浑浊彩色渐变光斑与突兀黄色 AI 星标，以极简黑白灰为衬底，突出纯净蓝色的波浪点阵起伏：
 * - 阶段 1（0 ~ 1.5s）：浅灰圆角卡片，左下角「正在思考」；
 * - 阶段 2（> 1.5s）：纯白卡片，左上角「正在勾勒草图」，中心是起伏波动的科技蓝点阵海浪，右下角展示「39%」白底胶囊。
 */
function ChatGptImageWaitingCard({
    index,
    total,
    aspect,
    isEdit,
    elapsedSeconds,
}: {
    index: number;
    total: number;
    aspect: number;
    isEdit: boolean;
    elapsedSeconds: number;
}) {
    const { t } = useTranslation();
    const progress = estimateProgress(elapsedSeconds, index);

    // 阶段文字演变
    const phase = useMemo(() => {
        if (isEdit) {
            if (elapsedSeconds < 1.6) return t("chat.waiting.thinking");
            if (elapsedSeconds < 7) return t("chat.waiting.phaseEditSketch");
            if (elapsedSeconds < 14) return t("chat.waiting.phaseEditDetails");
            return t("chat.waiting.phaseRender");
        }
        if (elapsedSeconds < 1.6) return t("chat.waiting.thinking");
        if (elapsedSeconds < 7) return t("chat.waiting.phaseSketch");
        if (elapsedSeconds < 14) return t("chat.waiting.phaseDetails");
        return t("chat.waiting.phaseRender");
    }, [elapsedSeconds, isEdit, t]);

    const isEarlyThinking = elapsedSeconds < 1.5;

    return (
        <div
            className={cn(
                "group relative overflow-hidden rounded-2xl transition-all duration-300 sm:rounded-3xl",
                isEarlyThinking
                    ? "border border-stone-200/70 bg-stone-100/90 dark:border-stone-800 dark:bg-stone-850"
                    : "border border-stone-200/80 bg-white p-4 shadow-[0_2px_14px_rgba(0,0,0,0.03)] sm:p-5 dark:border-stone-800 dark:bg-stone-900 dark:shadow-[0_2px_14px_rgba(0,0,0,0.25)]",
            )}
            style={{ aspectRatio: String(aspect) }}
        >
            {isEarlyThinking ? (
                /* 阶段 1：极简思考态（对应参考图 2） */
                <div className="absolute inset-0 flex flex-col justify-end p-5">
                    <div className="flex items-center gap-1.5 text-sm text-stone-400 dark:text-stone-500">
                        <span>{t("chat.waiting.thinking")}</span>
                        <span className="flex items-center gap-0.5">
                            <span className="agent-dot" />
                            <span className="agent-dot" />
                            <span className="agent-dot" />
                        </span>
                    </div>
                </div>
            ) : (
                /* 阶段 2：波浪点阵与进度胶囊（严格还原参考图 1） */
                <div className="agent-fade-in flex h-full w-full flex-col justify-between">
                    {/* 左上角干净的阶段文字（无任何杂乱图标） */}
                    <div className="flex items-center justify-between">
                        <span
                            key={phase}
                            className="agent-fade-in text-sm font-medium tracking-tight text-stone-700 dark:text-stone-300"
                        >
                            {phase}
                        </span>
                        {total > 1 ? (
                            <span className="font-mono text-[10px] uppercase tracking-wider text-stone-400 dark:text-stone-500">
                                {index + 1} / {total}
                            </span>
                        ) : null}
                    </div>

                    {/* 真正起伏如波浪的纯净蓝点阵 */}
                    <div className="relative min-h-0 flex-1 py-1">
                        <ChatGptDotMatrix aspect={aspect} />
                    </div>

                    {/* 右下角极简白底百分比胶囊 */}
                    <div className="flex items-center justify-end">
                        <div className="rounded-full border border-stone-200/90 bg-white/95 px-2.5 py-0.5 font-mono text-xs font-semibold tabular-nums text-blue-600 shadow-xs dark:border-stone-700/80 dark:bg-stone-800 dark:text-blue-400">
                            {progress}%
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
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
    const count = Math.max(1, Math.min(4, Number(call.arguments.count) || 1));
    const aspect = parseAspect(call.arguments.size);
    const isEdit = call.tool === "edit_image";
    const prompt = typeof call.arguments.prompt === "string" ? call.arguments.prompt : "";
    const size = typeof call.arguments.size === "string" ? call.arguments.size : "";
    const columns = useMemo(() => (count <= 1 ? 1 : 2), [count]);

    return (
        <div className="agent-message-in flex gap-3">
            {/* 极简助手头像：纯正素雅灰阶 */}
            <div className="mt-0.5 flex size-7.5 shrink-0 items-center justify-center rounded-full border border-stone-200/90 bg-stone-100/90 text-stone-600 shadow-xs dark:border-stone-800 dark:bg-stone-800/90 dark:text-stone-300">
                <Sparkles className="size-3.5 text-stone-500 dark:text-stone-400" />
            </div>

            <div className="min-w-0 flex-1">
                {/* 顶部标题与元数据：克制纯净的排版风格 */}
                <div className="flex items-center gap-2 text-xs">
                    <span className="flex items-center gap-1.5 font-medium text-stone-700 dark:text-stone-300">
                        {isEdit ? <Wand2 className="size-3.5 text-stone-500 dark:text-stone-400" /> : <Sparkles className="size-3.5 text-stone-500 dark:text-stone-400" />}
                        {isEdit ? t("chat.tools.names.edit_image") : t("chat.tools.names.generate_image")}
                    </span>

                    {size ? (
                        <span className="rounded-md border border-stone-200/80 bg-stone-100/70 px-1.5 py-0.5 font-mono text-[10px] text-stone-500 dark:border-stone-800 dark:bg-stone-800/60 dark:text-stone-400">
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

                {/* 卡片区域（纯净白底 + 蓝色海浪波点 + 39% 胶囊） */}
                <div
                    className="mt-3 grid max-w-[460px] gap-3"
                    style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
                >
                    {Array.from({ length: count }).map((_, index) => (
                        <ChatGptImageWaitingCard
                            key={index}
                            index={index}
                            total={count}
                            aspect={aspect}
                            isEdit={isEdit}
                            elapsedSeconds={elapsedSeconds}
                        />
                    ))}
                </div>

                {/* 底部微信息栏 */}
                <div className="mt-2.5 flex items-center justify-between text-[11px] text-stone-400 dark:text-stone-500">
                    <span className="flex items-center gap-1.5">
                        <span className="size-1.5 animate-pulse rounded-full bg-blue-500" />
                        {isEdit ? t("chat.waiting.editing") : t("chat.waiting.generating")}
                    </span>
                    <span className="font-mono text-[10px] tabular-nums">
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
            <div className="mt-0.5 flex size-7.5 shrink-0 items-center justify-center rounded-full border border-stone-200/90 bg-stone-100/90 text-stone-500 shadow-xs dark:border-stone-800 dark:bg-stone-800/90 dark:text-stone-400">
                <Sparkles className="size-3.5 text-stone-400 dark:text-stone-500" />
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
