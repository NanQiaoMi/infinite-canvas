import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AgentToolCall } from "@/lib/conversation-agent/types";
import { cn } from "@/lib/utils";
import { useImageTaskStore, type PersistedImageTask } from "@/stores/use-image-task-store";

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
 * 解析生图等待卡片要展示的进度信息：优先使用服务端任务返回的真实进度（0~1），
 * 未拿到真实进度时退回真实已用时（秒），不做任何模拟插值，避免出现「假百分比」。
 */
export type WaitingProgress = { kind: "percent"; value: number } | { kind: "elapsed"; value: number };

export function resolveWaitingProgress(progress: number | undefined, elapsedSeconds: number): WaitingProgress {
    if (typeof progress === "number" && Number.isFinite(progress)) {
        return { kind: "percent", value: Math.min(99, Math.max(1, Math.round(progress * 100))) };
    }
    return { kind: "elapsed", value: Math.max(0, Math.floor(elapsedSeconds)) };
}

/**
 * ChatGPT 官方同款无框生图卡片：
 * 彻底去除外框、白色底色与投影，直接在聊天流背景中自然流动呈现：
 * - 阶段 1（0 ~ 1.5s）：直接在背景中显示「正在思考」；
 * - 阶段 2（> 1.5s）：左上角干净文字「正在勾勒草图」，中心是暖石墨单色波浪点阵，
 *   右下角进度胶囊只展示服务端返回的真实百分比；拿不到时展示真实已用时（如 12s），绝不模拟。
 */
function ChatGptImageWaitingCard({
    index,
    total,
    aspect,
    isEdit,
    elapsedSeconds,
    task,
}: {
    index: number;
    total: number;
    aspect: number;
    isEdit: boolean;
    elapsedSeconds: number;
    task?: PersistedImageTask;
}) {
    const { t } = useTranslation();
    const isQueued = task?.status === "queued";
    const progressInfo = resolveWaitingProgress(task?.progress, elapsedSeconds);

    // 阶段文字演变
    const phase = useMemo(() => {
        if (isQueued) {
            return `排队等待中 · 前方还有 ${task?.queuePosition || 1} 人`;
        }
        if (task?.status === "processing") {
            return t("workbench.processing", "正在绘制中...");
        }
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
    }, [elapsedSeconds, isEdit, isQueued, task?.queuePosition, task?.status, t]);

    const isEarlyThinking = !isQueued && !task?.status && elapsedSeconds < 1.5;

    return (
        <div
            className={cn(
                "group relative overflow-hidden transition-all duration-300",
                // 彻底去除边框、阴影与白色填充卡片，直接融入页面背景
                "bg-transparent border-0 shadow-none p-0",
            )}
            style={{ aspectRatio: String(aspect) }}
        >
            {isEarlyThinking ? (
                /* 阶段 1：极简思考态，直接在背景中浮现 */
                <div className="flex h-full w-full flex-col justify-end py-3">
                    <div className="flex items-center gap-1.5 text-sm text-stone-500 dark:text-stone-400">
                        <span>{t("chat.waiting.thinking")}</span>
                        <span className="flex items-center gap-0.5 opacity-70">
                            <span className="agent-dot" />
                            <span className="agent-dot" />
                            <span className="agent-dot" />
                        </span>
                    </div>
                </div>
            ) : (
                /* 阶段 2：波浪点阵与进度胶囊，直接在背景中展现波浪 */
                <div className="agent-fade-in flex h-full w-full flex-col justify-between py-1">
                    {/* 左上角阶段文字，直接在背景中浮现 */}
                    <div className="flex items-center justify-between pb-1">
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

                    {/* 纯单色科技蓝波浪点阵，直接在背景中起伏流动 */}
                    <div className="relative min-h-0 flex-1">
                        <ChatGptDotMatrix aspect={aspect} />
                    </div>

                    {/* 右下角真实百分比 / 排队预计（拿不到真实数字时展示真实已用时） */}
                    <div className="flex items-center justify-end pt-1">
                        {isQueued ? (
                            <div
                                title={typeof task?.estimatedWaitSeconds === "number" ? "服务端预估排队时间" : "等待服务端返回排队信息"}
                                className="rounded-full border border-amber-300/80 bg-amber-50/80 px-2.5 py-0.5 font-mono text-xs font-semibold tabular-nums text-amber-700 shadow-xs backdrop-blur-sm dark:border-amber-700/80 dark:bg-amber-950/80 dark:text-amber-300"
                            >
                                {typeof task?.estimatedWaitSeconds === "number" ? `约 ${task.estimatedWaitSeconds}s` : "排队中"}
                            </div>
                        ) : (
                            <div
                                title={progressInfo.kind === "percent" ? "服务端返回的生成进度" : "已用时（服务端尚未返回进度）"}
                                className="rounded-full border border-stone-300/80 bg-white/80 px-2.5 py-0.5 font-mono text-xs font-semibold tabular-nums text-stone-600 shadow-xs backdrop-blur-sm dark:border-stone-700/80 dark:bg-stone-800/80 dark:text-stone-300"
                            >
                                {progressInfo.kind === "percent" ? `${progressInfo.value}%` : `${progressInfo.value}s`}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

export function GenerationWaiting({ call, startedAt }: { call: AgentToolCall; startedAt: number }) {
    const [elapsedMs, setElapsedMs] = useState(() => Date.now() - startedAt);
    const activeTasks = useImageTaskStore((state) => state.activeTasks);
    const activeChatTask = useMemo(() => {
        return Object.values(activeTasks).find((t) => t.source === "chat" && (t.status === "queued" || t.status === "processing"));
    }, [activeTasks]);

    useEffect(() => {
        setElapsedMs(Date.now() - startedAt);
        const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 250);
        return () => window.clearInterval(timer);
    }, [startedAt]);

    const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
    const count = Math.max(1, Math.min(12, Number(call.arguments.count) || 1));
    const aspect = parseAspect(call.arguments.size);
    const isEdit = call.tool === "edit_image";
    const prompt = typeof call.arguments.prompt === "string" ? call.arguments.prompt : "";
    const size = typeof call.arguments.size === "string" ? call.arguments.size : "";
    const columns = useMemo(() => (count <= 1 ? 1 : count <= 4 ? 2 : 3), [count]);

    return (
        <div className="agent-message-in w-full space-y-2">
            {/* 顶部微信息：仅在有 prompt 或尺寸时展现极其克制的元数据 */}
            {prompt || size ? (
                <div className="mb-2 flex items-center gap-2 text-xs text-stone-400 dark:text-stone-500">
                    {size ? (
                        <span className="rounded border border-stone-200/80 bg-stone-100/70 px-1.5 py-0.2 font-mono text-[10px] text-stone-500 dark:border-stone-800 dark:bg-stone-800/60 dark:text-stone-400">
                            {size}
                        </span>
                    ) : null}
                    {prompt ? (
                        <span className="min-w-0 truncate" title={prompt}>
                            {prompt}
                        </span>
                    ) : null}
                </div>
            ) : null}

            {/* 卡片主体：彻底遵循无框标准，直接在背景中起伏流动 */}
            <div
                className="grid max-w-[420px] gap-3"
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
                        task={activeChatTask}
                    />
                ))}
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
        <div className="agent-fade-in flex items-center gap-2 py-1 text-sm text-stone-500 dark:text-stone-400">
            <span className="font-serif text-[13.5px] tracking-wide text-stone-500 dark:text-stone-400">
                {t("chat.thinking")}
            </span>
            <span className="flex items-center gap-1 text-stone-400 dark:text-stone-600 opacity-70">
                <span className="agent-dot" />
                <span className="agent-dot" />
                <span className="agent-dot" />
            </span>
            <span className="ml-auto font-mono text-[10px] tabular-nums text-stone-400 dark:text-stone-500">
                {t("chat.waiting.elapsed", { seconds: elapsedSeconds })}
            </span>
        </div>
    );
}
