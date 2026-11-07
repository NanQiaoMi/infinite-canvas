import { ChevronDown, ChevronRight, LoaderCircle } from "lucide-react";
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

    // 正则捕获：
    // 1. 引号短语: "..." 或 “...”
    // 2. 文件名: xxx.jpg, xxx.png, xxx.md, xxx.ts 等
    // 3. 模型与尺寸: gpt-xxx, dall-e-3, 1024x1024
    // 4. 反引号代码: `...`
    const pattern = /(`[^`]+`|"[^"]+"|[“][^”]+[”]|(?:\b|\/)[a-zA-Z0-9_\-.]+\.(?:jpg|jpeg|png|webp|gif|svg|md|ts|tsx|js|json|py|csv|xlsx|pdf)\b|\b(?:gpt-[a-z0-9.-]+|dall-e-\d+|\d{3,4}x\d{3,4})\b)/g;

    const nodes: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
        if (match.index > lastIndex) {
            nodes.push(text.slice(lastIndex, match.index));
        }
        let chipText = match[0];
        if ((chipText.startsWith('"') && chipText.endsWith('"')) || (chipText.startsWith('“') && chipText.endsWith('”')) || (chipText.startsWith('`') && chipText.endsWith('`'))) {
            chipText = chipText.slice(1, -1);
        }
        nodes.push(
            <span
                key={`${match.index}-${chipText}`}
                className="mx-1 inline-flex items-center rounded-md border border-stone-300/40 bg-stone-200/60 px-1.5 py-0.5 font-mono text-[11px] leading-tight text-stone-700 dark:border-stone-700/50 dark:bg-stone-800/80 dark:text-stone-300"
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
    defaultExpanded = true,
}: {
    steps: AgentStep[];
    running: boolean;
    defaultExpanded?: boolean;
}) {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(defaultExpanded);

    const toolCount = useMemo(() => steps.filter((s) => s.kind === "tool").length, [steps]);

    if (!steps.length) return null;

    // 动态生成 Claude 风格的折叠条文案
    const summaryText = running
        ? t("chat.steps.summaryRunning", { count: steps.length })
        : t("chat.steps.summaryDone", {
              count: steps.length,
              tools: toolCount > 0 ? t("chat.steps.summaryToolsPart", { count: toolCount }) : "",
          });

    return (
        <div className="agent-message-in w-full space-y-2 select-none">
            {/* 顶部折叠摘要栏：极简、灵动、带微倒三角指示 */}
            <button
                type="button"
                onClick={() => setExpanded((prev) => !prev)}
                className="group inline-flex items-center gap-1.5 text-[13px] font-normal text-stone-500 transition-colors hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-200"
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

            {/* 卡片本体：圆润微浅底容器，细灰边框，Claude 典雅出版级风格 */}
            {expanded ? (
                <div className="agent-fade-in rounded-2xl border border-stone-200/80 bg-[#fbfaf8]/90 p-3.5 shadow-none transition-all duration-200 sm:p-4 dark:border-stone-800/80 dark:bg-[#1f1e1c]/80">
                    <ol className="space-y-2.5">
                        {steps.map((step) => {
                            const isRunning = step.status === "running";
                            const isCorrection = step.status === "correction";
                            const isWaitingRetry = step.status === "waiting-retry";
                            const isError = step.status === "error";

                            return (
                                <li
                                    key={step.id}
                                    className="flex items-center gap-2.5 border-b border-stone-200/40 pb-2.5 text-[13px] leading-relaxed last:border-b-0 last:pb-0 dark:border-stone-800/40"
                                >
                                    {/* 极简单色状态点 */}
                                    <div className="flex size-3.5 shrink-0 items-center justify-center">
                                        {isRunning ? (
                                            <LoaderCircle className="size-3 animate-spin text-stone-500 dark:text-stone-400" />
                                        ) : isCorrection ? (
                                            <span className="size-1.5 rounded-full bg-amber-500" />
                                        ) : isWaitingRetry ? (
                                            <span className="size-1.5 animate-pulse rounded-full bg-orange-500" />
                                        ) : isError ? (
                                            <span className="size-1.5 rounded-full bg-red-500" />
                                        ) : (
                                            <span className="size-1 rounded-full bg-stone-300 dark:bg-stone-600" />
                                        )}
                                    </div>

                                    {/* 自然排版内容（含自动 chip 渲染） */}
                                    <div
                                        className={cn(
                                            "min-w-0 flex-1 break-words font-sans",
                                            isRunning
                                                ? "font-medium text-stone-800 dark:text-stone-100"
                                                : "text-stone-600 dark:text-stone-300",
                                        )}
                                    >
                                        {formatStepLabel(step.label)}
                                    </div>

                                    {/* 状态徽标与尖角符号 */}
                                    {isCorrection ? (
                                        <span className="shrink-0 rounded bg-stone-200/60 px-1.5 py-0.5 font-mono text-[10px] text-stone-600 dark:bg-stone-800 dark:text-stone-400">
                                            {t("chat.steps.correctionRetry")}
                                        </span>
                                    ) : isWaitingRetry ? (
                                        <span className="shrink-0 rounded bg-stone-200/60 px-1.5 py-0.5 font-mono text-[10px] text-stone-600 dark:bg-stone-800 dark:text-orange-400">
                                            {t("chat.steps.waitingRetry")}
                                        </span>
                                    ) : step.kind === "tool" ? (
                                        <ChevronRight className="size-3 shrink-0 text-stone-300 dark:text-stone-600" />
                                    ) : null}
                                </li>
                            );
                        })}
                    </ol>
                </div>
            ) : null}
        </div>
    );
}
