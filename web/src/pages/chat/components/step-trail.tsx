import { ChevronDown, ChevronRight, LoaderCircle, Sparkles, Terminal } from "lucide-react";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AgentStep, AgentStepStatus } from "@/lib/conversation-agent/types";
import { cn } from "@/lib/utils";

export type { AgentStep, AgentStepStatus };

/**
 * 智能格式化步骤文本：
 * 识别文本中的文件名（如 1000287761.jpg、SKILL.md）、模型名、尺寸（1024x1024）或带引号的短语，
 * 将其渲染为 Claude 风格的 monospace 浅灰微型 Chip。
 */
export function formatStepLabel(text: string): React.ReactNode[] {
    if (!text) return [];

    const pattern = /(`[^`]+`|"[^"]+"|[“][^”]+[”]|(?:\b|\/)[a-zA-Z0-9_\-.]+\.(?:jpg|jpeg|png|webp|gif|svg|md|ts|tsx|js|json|py|csv|xlsx|pdf)\b|\b(?:gpt-[a-z0-9.-]+|dall-e-\d+|\d{3,4}x\d{3,4})\b)/g;

    const nodes: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
        if (match.index > lastIndex) {
            nodes.push(text.slice(lastIndex, match.index));
        }
        let chipText = match[0];
        if (
            (chipText.startsWith('"') && chipText.endsWith('"')) ||
            (chipText.startsWith('“') && chipText.endsWith('”')) ||
            (chipText.startsWith('`') && chipText.endsWith('`'))
        ) {
            chipText = chipText.slice(1, -1);
        }
        nodes.push(
            <span
                key={`${match.index}-${chipText}`}
                className="mx-1 inline-flex items-center rounded-md border border-stone-300/60 bg-stone-200/70 px-1.5 py-0.5 font-mono text-[11px] font-normal leading-tight text-stone-800 shadow-2xs dark:border-stone-700/70 dark:bg-stone-800/90 dark:text-stone-200"
            >
                {chipText}
            </span>,
        );
        lastIndex = pattern.lastIndex;
    }
    if (lastIndex < text.length) {
        nodes.push(text.slice(lastIndex));
    }

    return nodes;
}

export function StepTrail({
    steps,
    running,
    defaultExpanded,
}: {
    steps: AgentStep[];
    running: boolean;
    defaultExpanded?: boolean;
}) {
    const { t } = useTranslation();

    // 默认折叠策略：进行中时展开让用户看实时进度；完成态默认收起，只留精致摘要
    const isExpandedByDefault = defaultExpanded ?? running;
    const [expanded, setExpanded] = useState(isExpandedByDefault);

    const toolCount = useMemo(() => steps.filter((s) => s.kind === "tool").length, [steps]);
    const hasSpecialStatus = useMemo(
        () => steps.some((s) => s.status === "correction" || s.status === "waiting-retry" || s.status === "error"),
        [steps],
    );

    // 过滤策略：如果回合已结束，且没有任何工具调用或异常重试（仅普通闲聊），
    // 则不展示空洞卡片，避免冗余打扰用户。
    if (!steps.length || (!running && toolCount === 0 && !hasSpecialStatus)) {
        return null;
    }

    // 动态生成 Claude 风格的折叠条文案
    const summaryText = running
        ? t("chat.steps.summaryRunning", { count: steps.length })
        : t("chat.steps.summaryDone", {
              count: steps.length,
              tools: toolCount > 0 ? t("chat.steps.summaryToolsPart", { count: toolCount }) : "",
          });

    return (
        <div className="agent-message-in w-full space-y-3.5 pt-2 sm:pt-4 select-none">
            {/* 顶部折叠摘要栏：极简、灵动、带微倒三角指示 */}
            <button
                type="button"
                onClick={() => setExpanded((prev) => !prev)}
                className="group inline-flex items-center gap-2 text-[13px] font-normal text-stone-500 transition-colors hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-200"
            >
                {running ? (
                    <span className="relative flex size-2 items-center justify-center">
                        <span className="absolute inline-flex size-full animate-ping rounded-full bg-stone-400 opacity-75 dark:bg-stone-500" />
                        <span className="relative inline-flex size-1.5 rounded-full bg-stone-600 dark:bg-stone-300" />
                    </span>
                ) : null}
                <span>{summaryText}</span>
                <ChevronDown
                    className={cn(
                        "size-3.5 text-stone-400 transition-transform duration-200 group-hover:text-stone-600 dark:text-stone-500 dark:group-hover:text-stone-300",
                        expanded && "rotate-180",
                    )}
                />
            </button>

            {/* 卡片本体：从容宽敞的呼吸空间 + 垂直思维链时间轴（Timeline Beam） */}
            {expanded ? (
                <div className="agent-fade-in mt-1 rounded-2xl border border-[#e5e3dc] bg-[#faf9f5]/90 p-5 shadow-xs transition-all duration-200 sm:p-6 dark:border-[#2f2d29] dark:bg-[#1e1d1b]/90">
                    <ol className="relative space-y-4">
                        {steps.map((step, index) => {
                            const isRunning = step.status === "running";
                            const isCorrection = step.status === "correction";
                            const isWaitingRetry = step.status === "waiting-retry";
                            const isError = step.status === "error";
                            const isLast = index === steps.length - 1;

                            return (
                                <li
                                    key={step.id}
                                    className="relative flex items-start gap-3.5 text-[13.5px] leading-relaxed text-stone-700 dark:text-stone-200"
                                >
                                    {/* 垂直时间轴导轨（Timeline Beam）：连接每一个思维链节点 */}
                                    {!isLast ? (
                                        <div
                                            className="absolute left-[8px] top-[18px] bottom-[-16px] w-[1px] bg-stone-200/90 dark:bg-stone-800"
                                            aria-hidden="true"
                                        />
                                    ) : null}

                                    {/* 节点图标：清晰展现思维链节点与执行状态 */}
                                    <div className="relative z-10 flex size-4.5 shrink-0 items-center justify-center pt-0.5">
                                        {isRunning ? (
                                            <div className="flex size-4.5 items-center justify-center">
                                                <span className="absolute size-4 animate-ping rounded-full bg-stone-400/30 opacity-75 dark:bg-stone-500/30" />
                                                <LoaderCircle className="size-3.5 animate-spin text-stone-700 dark:text-stone-200" />
                                            </div>
                                        ) : isCorrection ? (
                                            <span className="size-2 rounded-full bg-amber-500 ring-4 ring-amber-500/15" />
                                        ) : isWaitingRetry ? (
                                            <span className="size-2 animate-pulse rounded-full bg-orange-500 ring-4 ring-orange-500/15" />
                                        ) : isError ? (
                                            <span className="size-2 rounded-full bg-red-500 ring-4 ring-red-500/15" />
                                        ) : step.kind === "tool" ? (
                                            <div className="flex size-4 items-center justify-center rounded-md bg-stone-200/80 text-stone-700 dark:bg-stone-800 dark:text-stone-300">
                                                <Terminal className="size-2.5" />
                                            </div>
                                        ) : (
                                            <span className="size-1.5 rounded-full bg-stone-400/90 dark:bg-stone-500" />
                                        )}
                                    </div>

                                    {/* 思维链文本内容（宽松行高与自动 chip 格式化） */}
                                    <div
                                        className={cn(
                                            "min-w-0 flex-1 break-words font-sans pt-0.5",
                                            isRunning
                                                ? "font-medium text-stone-900 dark:text-stone-100"
                                                : "text-stone-700 dark:text-stone-300",
                                        )}
                                    >
                                        {formatStepLabel(step.label)}
                                    </div>

                                    {/* 右侧微型状态与交互指示符 */}
                                    <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
                                        {isRunning ? (
                                            <span className="text-[11px] font-mono text-stone-400 dark:text-stone-500">
                                                {t("chat.steps.running")}
                                            </span>
                                        ) : null}
                                        {isCorrection ? (
                                            <span className="rounded bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-600 dark:bg-amber-400/15 dark:text-amber-400">
                                                {t("chat.steps.correctionRetry")}
                                            </span>
                                        ) : isWaitingRetry ? (
                                            <span className="rounded bg-orange-500/10 px-1.5 py-0.5 font-mono text-[10px] text-orange-600 dark:bg-orange-400/15 dark:text-orange-400">
                                                {t("chat.steps.waitingRetry")}
                                            </span>
                                        ) : step.kind === "tool" ? (
                                            <ChevronRight className="size-3.5 text-stone-300 dark:text-stone-600" />
                                        ) : null}
                                    </div>
                                </li>
                            );
                        })}
                    </ol>
                </div>
            ) : null}
        </div>
    );
}
