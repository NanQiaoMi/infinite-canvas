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
 * ChatGPT & Claude 风格生图等待态：
 * - 摒弃机械呆板的齿轮虚线旋转与伪百分比倒数；
 * - 采用多层流体生成极光（Generative Ambient Aurora Mesh）与潜在空间微粒子网格；
 * - 居中悬浮极简毛玻璃胶囊徽章，配合随阶段演进的诗意视觉生成文案与三点呼吸律动；
 * - 营造出深邃、灵动且高级的 AI 艺术创作沉浸感。
 */
export function GenerationWaiting({ call, startedAt }: { call: AgentToolCall; startedAt: number }) {
    const { t } = useTranslation();
    const [elapsedMs, setElapsedMs] = useState(() => Date.now() - startedAt);

    useEffect(() => {
        setElapsedMs(Date.now() - startedAt);
        const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 250);
        return () => window.clearInterval(timer);
    }, [startedAt]);

    const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));

    // 根据生成时长平滑演进生成阶段状态
    const phase = useMemo(() => {
        if (elapsedSeconds < 3) return t("chat.waiting.phasePrepare");
        if (elapsedSeconds < 9) return t("chat.waiting.phaseRequest");
        if (elapsedSeconds < 16) return t("chat.waiting.phaseTexture");
        return t("chat.waiting.phaseRender");
    }, [elapsedSeconds, t]);

    const count = Math.max(1, Math.min(4, Number(call.arguments.count) || 1));
    const aspect = parseAspect(call.arguments.size);
    const isEdit = call.tool === "edit_image";
    const prompt = typeof call.arguments.prompt === "string" ? call.arguments.prompt : "";
    const size = typeof call.arguments.size === "string" ? call.arguments.size : "";
    const columns = useMemo(() => (count <= 1 ? 1 : 2), [count]);

    return (
        <div className="agent-message-in flex gap-3">
            {/* 助手头像：灵动微光星标 */}
            <div className="mt-0.5 flex size-7.5 shrink-0 items-center justify-center rounded-full border border-stone-200/90 bg-gradient-to-b from-stone-50 to-stone-100 text-stone-600 shadow-xs dark:border-stone-700/80 dark:from-stone-800 dark:to-stone-900 dark:text-stone-300">
                <Sparkles className="size-3.5 text-amber-500/90 dark:text-amber-400" />
            </div>

            <div className="min-w-0 flex-1">
                {/* 顶部标题栏：工具名、尺寸与提示词 */}
                <div className="flex items-center gap-2 text-xs">
                    <span className="flex items-center gap-1.5 font-medium text-stone-800 dark:text-stone-200">
                        {isEdit ? <Wand2 className="size-3.5 text-amber-500" /> : <Sparkles className="size-3.5 text-amber-500" />}
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

                {/* 生成画布骨架屏（ChatGPT DALL-E 流体极光 + 潜在空间微粒子网格） */}
                <div
                    className="mt-3 grid max-w-[460px] gap-3"
                    style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
                >
                    {Array.from({ length: count }).map((_, index) => (
                        <div
                            key={index}
                            className="group relative overflow-hidden rounded-2xl border border-stone-200/90 bg-gradient-to-br from-stone-100/90 via-[#f7f5f0] to-stone-100/70 shadow-xs dark:border-stone-800/90 dark:from-stone-900/90 dark:via-[#191816] dark:to-stone-950"
                            style={{
                                aspectRatio: String(aspect),
                            }}
                        >
                            {/* 流体极光光晕 1：暖琥珀与蜜桃辉光（缓慢对角浮动） */}
                            <div
                                className="agent-ambient-float-1 absolute -left-12 -top-12 size-48 rounded-full bg-gradient-to-tr from-amber-300/40 via-rose-300/35 to-amber-200/20 blur-3xl dark:from-amber-500/20 dark:via-rose-600/15 dark:to-transparent"
                                style={{ animationDelay: `${index * 1.5}s` }}
                            />

                            {/* 流体极光光晕 2：淡青蓝与薰衣草紫辉光（逆向回旋浮动） */}
                            <div
                                className="agent-ambient-float-2 absolute -bottom-12 -right-12 size-52 rounded-full bg-gradient-to-br from-indigo-300/30 via-purple-300/25 to-sky-300/35 blur-3xl dark:from-indigo-600/20 dark:via-purple-700/15 dark:to-transparent"
                                style={{ animationDelay: `${index * 2}s` }}
                            />

                            {/* 潜在空间微粒子点阵网格（ChatGPT 经典采样质感） */}
                            <div
                                className="pointer-events-none absolute inset-0 opacity-[0.18] dark:opacity-[0.22]"
                                style={{
                                    backgroundImage: "radial-gradient(circle, currentColor 1px, transparent 1px)",
                                    backgroundSize: "18px 18px",
                                }}
                            />

                            {/* 柔光光泽扫掠层 */}
                            <div className="agent-shimmer pointer-events-none absolute inset-0 opacity-40 dark:opacity-25" />

                            {/* 居中悬浮极简毛玻璃胶囊（Claude & ChatGPT 高级质感） */}
                            <div className="absolute inset-0 flex flex-col items-center justify-center p-4">
                                <div className="flex items-center gap-2.5 rounded-full border border-white/70 bg-white/80 px-4 py-2 shadow-[0_4px_24px_-2px_rgba(0,0,0,0.06)] backdrop-blur-xl transition-all duration-300 dark:border-stone-700/60 dark:bg-stone-900/80 dark:shadow-[0_4px_24px_-2px_rgba(0,0,0,0.4)]">
                                    {/* 呼吸微光图标 */}
                                    <div className="relative flex size-4 items-center justify-center">
                                        <div className="agent-glow-breathe absolute inset-0 rounded-full bg-amber-400/35 blur-xs dark:bg-amber-400/25" />
                                        {isEdit ? (
                                            <Wand2 className="relative size-3.5 text-amber-600 dark:text-amber-400" />
                                        ) : (
                                            <Sparkles className="relative size-3.5 text-amber-600 dark:text-amber-400" />
                                        )}
                                    </div>

                                    {/* 阶段性演化文案 */}
                                    <span
                                        key={phase}
                                        className="agent-fade-in text-[12px] font-medium tracking-wide text-stone-700 dark:text-stone-200"
                                    >
                                        {phase}
                                    </span>

                                    {/* 节奏感三点呼吸微动效 */}
                                    <span className="flex items-center gap-0.5 text-stone-400 dark:text-stone-500">
                                        <span className="agent-dot" />
                                        <span className="agent-dot" />
                                        <span className="agent-dot" />
                                    </span>
                                </div>

                                {count > 1 ? (
                                    <div className="mt-2 text-[10px] font-mono uppercase tracking-widest text-stone-400 dark:text-stone-500">
                                        {index + 1} / {count}
                                    </div>
                                ) : null}
                            </div>
                        </div>
                    ))}
                </div>

                {/* 底部微信息栏 */}
                <div className="mt-2.5 flex items-center justify-between text-[11px] text-stone-400 dark:text-stone-500">
                    <span className="flex items-center gap-1.5">
                        <span className="size-1.5 animate-pulse rounded-full bg-amber-500/80" />
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
            <div className="mt-0.5 flex size-7.5 shrink-0 items-center justify-center rounded-full border border-stone-200/90 bg-gradient-to-b from-stone-50 to-stone-100 text-stone-500 shadow-xs dark:border-stone-700/80 dark:from-stone-800 dark:to-stone-900 dark:text-stone-400">
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
