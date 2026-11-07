import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";

import { normalizeMarkdownForChat } from "@/lib/conversation-agent/markdown-normalizer";
import { cn } from "@/lib/utils";

type SmoothStreamTextProps = {
    rawText?: string;
    text?: string;
    running?: boolean;
    isRun?: boolean;
    onComplete?: () => void;
};

/**
 * 计算自适应步长与帧跳过策略：
 * - 少量字符时匀速输出（~20ms/字），模拟极其细腻真实的打字手感；
 * - 突发大块内容自适应动态加速平滑追赶（150~300ms 内追齐），彻底消除画面生硬跳动；
 * - 运行结束时加速收尾，避免用户等待。
 */
export function calculateStreamStep(
    remaining: number,
    isRun: boolean,
    deltaMs: number,
): { stepChars: number; skipFrame: boolean } {
    if (remaining <= 0) return { stepChars: 0, skipFrame: false };
    if (!isRun) {
        return { stepChars: Math.max(3, Math.ceil(remaining / 4)), skipFrame: false };
    }
    if (remaining > 80) {
        return { stepChars: Math.ceil(remaining / 5), skipFrame: false };
    }
    if (remaining > 25) {
        return { stepChars: Math.max(2, Math.ceil(remaining / 7)), skipFrame: false };
    }
    if (remaining > 6) {
        return { stepChars: deltaMs > 24 ? 2 : 1, skipFrame: false };
    }
    if (deltaMs < 20) {
        return { stepChars: 0, skipFrame: true };
    }
    return { stepChars: 1, skipFrame: false };
}

/**
 * 平滑流式打字渲染组件：
 * 针对大模型 SSE chunk 输出不均匀、中文无空格分词导致的断续卡顿，
 * 采用客户端自适应步长缓冲推进器（Adaptive Smooth Buffer）：
 * - 少量字符时匀速逐字输出（~24ms/字），模拟极其细腻真实的打字机手感；
 * - 突发大块 chunk 时自适应动态加速平滑追赶（150~300ms 内追齐），彻底消除画面生硬跳动；
 * - 配合尾随呼吸光标与精致排版，带来 Claude 级别丝滑流畅的视觉体验。
 */
export function SmoothStreamText(props: SmoothStreamTextProps) {
    const rawText = (props.rawText ?? props.text ?? "") || "";
    const running = Boolean(props.running ?? props.isRun);
    const onComplete = props.onComplete;
    const [displayedLength, setDisplayedLength] = useState(0);
    const targetLengthRef = useRef(rawText.length);
    targetLengthRef.current = rawText.length;
    const runningRef = useRef(running);
    runningRef.current = running;

    useEffect(() => {
        let animId: number;
        let lastTimestamp = performance.now();

        const tick = (now: number) => {
            const deltaMs = now - lastTimestamp;
            const target = targetLengthRef.current;
            const isRun = runningRef.current;

            setDisplayedLength((current) => {
                if (current >= target) {
                    if (!isRun && current > 0 && target > 0) {
                        onComplete?.();
                    }
                    return target;
                }

                const remaining = target - current;
                const { stepChars, skipFrame } = calculateStreamStep(remaining, isRun, deltaMs);
                if (skipFrame) return current;

                lastTimestamp = now;
                const next = Math.min(target, current + stepChars);
                return next;
            });

            animId = requestAnimationFrame(tick);
        };

        animId = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(animId);
    }, [onComplete]);

    // 会话切换或重置时快速同步
    useEffect(() => {
        if (!rawText) {
            setDisplayedLength(0);
        } else if (displayedLength > rawText.length) {
            setDisplayedLength(rawText.length);
        }
    }, [rawText, displayedLength]);

    const visibleText = rawText.slice(0, displayedLength);
    const isActivelyTyping = displayedLength < rawText.length;

    return (
        <div className="relative leading-relaxed">
            <Streamdown className="agent-streamdown">
                {normalizeMarkdownForChat(visibleText)}
            </Streamdown>
            {/* 丝滑尾随光标：输出中常亮/呼吸，完成时优雅隐退 */}
            {running || isActivelyTyping ? (
                <span
                    className={cn(
                        "inline-block ml-0.5 h-[1.15em] w-[2px] align-[-0.15em] rounded-full bg-stone-700/90 shadow-[0_0_8px_rgba(0,0,0,0.15)] transition-opacity duration-150 dark:bg-stone-300 dark:shadow-[0_0_8px_rgba(255,255,255,0.25)]",
                        isActivelyTyping ? "opacity-100" : "animate-pulse opacity-70",
                    )}
                />
            ) : null}
        </div>
    );
}
