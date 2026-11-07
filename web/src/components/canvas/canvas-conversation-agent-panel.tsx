import React, { useCallback, useEffect, useRef, useState } from "react";
import { App, Button, Tooltip } from "antd";
import {
    ArrowUp,
    Bot,
    Maximize2,
    Minimize2,
    PanelRightClose,
    Plus,
    RefreshCw,
    Send,
    Settings,
    Sparkles,
    Square,
    Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { nanoid } from "nanoid";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useConversationAgentStore } from "@/stores/use-conversation-agent-store";
import { useConfigStore, selectableModelsByCapability } from "@/stores/use-config-store";
import { useQuotaStore } from "@/stores/use-quota-store";
import { requestConversationTurn } from "@/services/api/image";
import { runAgentTurn } from "@/lib/conversation-agent/runtime";
import { ALL_AGENT_TOOLS, executeAgentTool } from "@/lib/conversation-agent/tools";
import { agentLocaleOf } from "@/lib/conversation-agent/system-prompt";
import { formatAgentToolStepLabel, getInitialUnderstandStepLabel } from "@/lib/conversation-agent/formatters";
import { detectAgentIntent } from "@/lib/conversation-agent/intent";
import type { AgentEvent, AgentStep, AgentToolCall } from "@/lib/conversation-agent/types";
import { nativeToolCallsToAgent } from "@/lib/conversation-agent/protocol";
import { ChatMessage } from "@/pages/chat/components/chat-message";
import { StepTrail } from "@/pages/chat/components/step-trail";
import { SmoothStreamText } from "@/pages/chat/components/smooth-stream-text";
import { cn } from "@/lib/utils";

const QUICK_PROMPTS = [
    { label: "🎨 拆解海报多素材", text: "帮我做一张科幻机甲海报，把任务拆分为主体机甲、装饰边框和微标等透明底素材在画布上排开生成" },
    { label: "✨ 批量生成4张头像", text: "在画布上批量生成4张不同风格的赛博朋克猫咪头像，并排排开" },
    { label: "📦 生成透明底图标", text: "在画布上生成一套 3 个透明底游戏魔法药水图标（红色生命、蓝色魔法、绿色体力）" },
    { label: "🔍 查看画布节点", text: "获取当前画布的状态和所有节点信息" },
];

const NETWORK_ERROR_PATTERN = /network error|failed to fetch|load failed|networkerror|econnreset|socket hang up|fetch failed/i;
const isNetworkError = (error: unknown) => NETWORK_ERROR_PATTERN.test(error instanceof Error ? error.message : String(error));

export function CanvasConversationAgentPanel({ onSwitchToCodex }: { onSwitchToCodex?: () => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const closePanel = useAgentStore((state) => state.closePanel);
    const canvasContext = useAgentStore((state) => state.canvasContext);
    const projectId = canvasContext?.snapshot?.projectId;

    const hydrated = useConversationAgentStore((state) => state.hydrated);
    const sessions = useConversationAgentStore((state) => state.sessions);
    const streamingText = useConversationAgentStore((state) => state.streamingText);
    const running = useConversationAgentStore((state) => state.running);
    const runningTool = useConversationAgentStore((state) => state.runningTool);
    const hydrate = useConversationAgentStore((state) => state.hydrate);
    const createSession = useConversationAgentStore((state) => state.createSession);
    const appendMessages = useConversationAgentStore((state) => state.appendMessages);
    const setStreamingText = useConversationAgentStore((state) => state.setStreamingText);
    const setRunning = useConversationAgentStore((state) => state.setRunning);
    const setRunningTool = useConversationAgentStore((state) => state.setRunningTool);

    const [input, setInput] = useState("");
    const [steps, setStepsState] = useState<AgentStep[]>([]);
    const currentStepsRef = useRef<AgentStep[]>([]);
    const setSteps = useCallback((action: AgentStep[] | ((current: AgentStep[]) => AgentStep[])) => {
        setStepsState((prev) => {
            const next = typeof action === "function" ? action(prev) : action;
            currentStepsRef.current = next;
            return next;
        });
    }, []);

    const stepSeqRef = useRef(0);
    const controllerRef = useRef<AbortController | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);

    const canvasSessions = sessions.filter((s) => s.scope === "canvas");
    const activeSession = (projectId ? canvasSessions.find((s) => s.canvasProjectId === projectId) : null) ?? canvasSessions[0] ?? null;

    useEffect(() => {
        void hydrate();
    }, [hydrate]);

    const lastSessionRef = useRef<string | null | undefined>(undefined);
    useEffect(() => {
        const curId = activeSession?.id;
        if (lastSessionRef.current && lastSessionRef.current !== curId) {
            if (controllerRef.current) {
                controllerRef.current.abort();
                controllerRef.current = null;
            }
            setRunning(false);
            setStreamingText("");
            setRunningTool(null);
            setSteps([]);
        }
        lastSessionRef.current = curId;
    }, [activeSession?.id, setSteps, setRunning, setStreamingText, setRunningTool]);

    useEffect(() => {
        if (!scrollRef.current) return;
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }, [activeSession?.messages, streamingText, steps]);

    const buildContext = useCallback(() => {
        const config = useConfigStore.getState().config;
        const imageModels = selectableModelsByCapability(config, "image");
        const defaultImageModel = config.imageModel || imageModels[0] || "";
        const quotaStatus = useQuotaStore.getState().status;
        const quota = quotaStatus?.capabilities?.image
            ? {
                  dailyUsed: quotaStatus.capabilities.image.dailyUsed,
                  dailyLimit: quotaStatus.capabilities.image.dailyLimit,
                  weeklyUsed: quotaStatus.capabilities.image.weeklyUsed,
                  weeklyLimit: quotaStatus.capabilities.image.weeklyLimit,
              }
            : undefined;
        return {
            imageModels,
            defaultImageModel,
            defaultSize: config.size || "1024x1024",
            defaultQuality: config.quality || "standard",
            defaultCount: config.count || "1",
            quota,
            pageContext: "canvas" as const,
            toolChannel: "text" as const,
        };
    }, []);

    const callModel = useCallback(
        async (req: {
            systemPrompt: string;
            messages: Array<{ role: "user" | "assistant"; content: string }>;
            tools: typeof ALL_AGENT_TOOLS;
            signal: AbortSignal;
            onDelta: (text: string) => void;
        }) => {
            const config = useConfigStore.getState().config;
            const textOptions = selectableModelsByCapability(config, "text");
            const effectiveModel = config.textModel || textOptions[0] || "";
            if (!effectiveModel) {
                throw new Error("请先在设置中配置文本对话模型");
            }
            const textChannel = config.channels.find((channel) => channel.id === (effectiveModel.split("::")[0] || ""));
            const nativeTools = textChannel?.toolProtocol === "native";

            const run = () =>
                requestConversationTurn(
                    { ...config, model: effectiveModel },
                    req.messages.map((item) => ({ role: item.role, content: item.content })),
                    {
                        systemPrompt: req.systemPrompt,
                        tools: nativeTools ? req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) : [],
                        onDelta: req.onDelta,
                        signal: req.signal,
                    },
                );

            let turn;
            try {
                turn = await run();
            } catch (error) {
                if (req.signal.aborted || !isNetworkError(error)) throw error;
                // Wait briefly and retry once on network error
                await new Promise((resolve) => setTimeout(resolve, 900));
                turn = await run();
            }

            const native = nativeToolCallsToAgent(turn.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })));
            return { content: turn.content, toolCalls: native.calls, toolCallErrors: native.errors };
        },
        [],
    );

    const send = useCallback(
        async (rawText?: string) => {
            const text = (rawText ?? input).trim();
            if (!text || running) return;

            let sessionId = activeSession?.id;
            if (!sessionId) {
                sessionId = createSession({ scope: "canvas", canvasProjectId: projectId });
            }
            lastSessionRef.current = sessionId;

            appendMessages(sessionId, [{ id: nanoid(), role: "user", text, createdAt: Date.now() }]);
            setInput("");
            setStreamingText("");

            const history = useConversationAgentStore.getState().sessions.find((s) => s.id === sessionId)?.messages ?? [];
            const intent = detectAgentIntent(text, { history });
            const initialLabel = getInitialUnderstandStepLabel(text, intent);
            setSteps([{ id: "understand", kind: "understand", label: initialLabel, status: "running" }]);
            setRunning(true);

            const controller = new AbortController();
            controllerRef.current = controller;

            try {
                const result = await runAgentTurn({
                    locale: agentLocaleOf("zh-CN"),
                    messages: history,
                    tools: ALL_AGENT_TOOLS,
                    buildContext,
                    callModel,
                    executeTool: (call, ctx) => executeAgentTool(call, ctx),
                    onEvent: (event: AgentEvent) => {
                        if (event.type === "assistant-stream") {
                            setStreamingText(event.text);
                            if (event.text.trim()) {
                                setSteps((current) => {
                                    const hasTool = current.some((s) => s.kind === "tool");
                                    const isActionIntent = intent.kind === "generate_image" || intent.kind === "edit_image" || intent.isCanvas;
                                    if (isActionIntent && !hasTool) return current;

                                    const next = current.map((s) =>
                                        (s.status === "running" && s.kind === "understand") || s.status === "correction"
                                            ? { ...s, status: "done" as const }
                                            : s,
                                    );
                                    if (!next.some((s) => s.status === "running")) {
                                        next.push({ id: `respond-${next.length}`, kind: "respond", label: "组织回复与排版说明", status: "running" });
                                    }
                                    return next;
                                });
                            }
                        } else if (event.type === "tool-start") {
                            setStreamingText("");
                            setRunningTool(event.call);
                            setSteps((current) => {
                                const next = current.map((s) => (s.status === "running" || s.status === "correction" ? { ...s, status: "done" as const } : s));
                                stepSeqRef.current += 1;
                                return [...next, { id: `tool-${stepSeqRef.current}`, kind: "tool" as const, label: formatAgentToolStepLabel(event.call), status: "running" as const }];
                            });
                        } else if (event.type === "correction-start") {
                            setSteps((current) => {
                                const next = current.map((s) => (s.status === "running" ? { ...s, status: "done" as const } : s));
                                stepSeqRef.current += 1;
                                return [
                                    ...next,
                                    {
                                        id: `correction-${stepSeqRef.current}`,
                                        kind: "correction" as const,
                                        label: "检测到指令偏差 · 重新解析并执行",
                                        status: "correction" as const,
                                    },
                                ];
                            });
                        } else if (event.type === "tool-end") {
                            setRunningTool(null);
                            setSteps((current) => current.map((s) => (s.status === "running" ? { ...s, status: "done" as const } : s)));
                        }
                    },
                    signal: controller.signal,
                    maxRounds: 8,
                });

                const finalSteps = currentStepsRef.current.map((s) => (s.status === "running" ? { ...s, status: "done" as const } : s));
                if (result.messages.length) {
                    let messagesToAppend = [...result.messages];
                    if (finalSteps.length > 0) {
                        const firstToolIdx = messagesToAppend.findIndex((m) => m.role === "tool");
                        const firstAssistantIdx = messagesToAppend.findIndex((m) => m.role === "assistant");
                        if (firstToolIdx !== -1 && (firstAssistantIdx === -1 || firstToolIdx < firstAssistantIdx)) {
                            messagesToAppend.unshift({
                                id: nanoid(),
                                role: "assistant",
                                text: "",
                                steps: finalSteps,
                                promptBlocks: [],
                                createdAt: Date.now(),
                            });
                        } else if (firstAssistantIdx !== -1) {
                            messagesToAppend = messagesToAppend.map((msg, idx) =>
                                idx === firstAssistantIdx ? { ...msg, steps: finalSteps } : msg,
                            );
                        } else {
                            messagesToAppend.unshift({
                                id: nanoid(),
                                role: "assistant",
                                text: "",
                                steps: finalSteps,
                                promptBlocks: [],
                                createdAt: Date.now(),
                            });
                        }
                    }
                    appendMessages(sessionId, messagesToAppend);
                }
                if (result.roundLimitReached) {
                    appendMessages(sessionId, [{ id: nanoid(), role: "error", text: "已达最大循环轮次，任务中止", createdAt: Date.now() }]);
                }
            } catch (err: unknown) {
                const aborted = controller.signal.aborted;
                const partial = useConversationAgentStore.getState().streamingText;
                const isCurrentSession = useConversationAgentStore.getState().activeSessionId === sessionId;
                if (aborted) {
                    if (partial.trim() && isCurrentSession) {
                        appendMessages(sessionId, [{ id: nanoid(), role: "assistant", text: partial, promptBlocks: [], createdAt: Date.now() }]);
                    }
                } else if (isCurrentSession) {
                    const raw = err instanceof Error ? err.message : String(err);
                    const errorMsg = isNetworkError(err) ? "网络连接异常，请重试" : raw;
                    appendMessages(sessionId, [{ id: nanoid(), role: "error", text: errorMsg, createdAt: Date.now() }]);
                    message.error(errorMsg);
                }
            } finally {
                const isCurrentSession = useConversationAgentStore.getState().activeSessionId === sessionId;
                if (isCurrentSession) {
                    setRunning(false);
                    setRunningTool(null);
                    setStreamingText("");
                    controllerRef.current = null;
                }
            }
        },
        [input, running, createSession, appendMessages, setStreamingText, setSteps, setRunning, buildContext, callModel, setRunningTool, message],
    );

    const handleStop = () => {
        if (controllerRef.current) {
            controllerRef.current.abort();
            controllerRef.current = null;
        }
        setRunning(false);
        setRunningTool(null);
        setStreamingText("");
    };

    return (
        <div className="flex h-full w-full flex-col select-text" style={{ background: theme.node.panel, color: theme.node.text }}>
            {/* Header */}
            <div className="flex h-12 shrink-0 items-center justify-between border-b px-3.5" style={{ borderColor: theme.node.stroke }}>
                <div className="flex items-center gap-2">
                    <span className="flex size-7 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-400">
                        <Bot className="size-4" />
                    </span>
                    <div className="flex flex-col">
                        <span className="text-xs font-semibold leading-tight">AI 画布助手</span>
                        <span className="text-[10px] text-stone-400 leading-tight">对话生图 · 批量排布 · 节点控制</span>
                    </div>
                </div>

                <div className="flex items-center gap-1">
                    <Tooltip title="新对话">
                        <Button
                            type="text"
                            size="small"
                            className="!h-7 !w-7 !p-0"
                            style={{ color: theme.node.muted }}
                            icon={<Plus className="size-3.5" />}
                            onClick={() => createSession({ scope: "canvas", canvasProjectId: projectId })}
                        />
                    </Tooltip>
                    {onSwitchToCodex ? (
                        <Tooltip title="切换至本地 Codex 模式">
                            <Button
                                type="text"
                                size="small"
                                className="!h-7 !w-7 !p-0"
                                style={{ color: theme.node.muted }}
                                icon={<Settings className="size-3.5" />}
                                onClick={onSwitchToCodex}
                            />
                        </Tooltip>
                    ) : null}
                    <Tooltip title="收起面板">
                        <Button
                            type="text"
                            size="small"
                            className="!h-7 !w-7 !p-0"
                            style={{ color: theme.node.muted }}
                            icon={<PanelRightClose className="size-3.5" />}
                            onClick={closePanel}
                        />
                    </Tooltip>
                </div>
            </div>

            {/* Messages Area */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-3.5 py-4 space-y-4">
                {(!activeSession || activeSession.messages.length === 0) && (
                    <div className="flex flex-col items-center justify-center py-10 text-center">
                        <div className="flex size-12 items-center justify-center rounded-2xl bg-stone-100 dark:bg-stone-800 text-stone-400">
                            <Sparkles className="size-6" />
                        </div>
                        <h3 className="mt-3 text-sm font-medium">随时吩咐我操作画布</h3>
                        <p className="mt-1 max-w-[260px] text-xs text-stone-400 leading-relaxed">
                            支持对话生成图片、多任务拆解批量排布、节点修改与连线
                        </p>
                    </div>
                )}

                {activeSession?.messages.map((msg) => (
                    <ChatMessage key={msg.id} message={msg} />
                ))}

                {running && (
                    <div className="space-y-2">
                        {steps.length > 0 && <StepTrail steps={steps} running={running} defaultExpanded />}
                        {runningTool && (
                            <div className="agent-fade-in rounded-xl border border-stone-200/90 bg-stone-50/70 p-3 text-xs dark:border-stone-800 dark:bg-stone-900/60">
                                <div className="flex items-center gap-2 text-stone-700 dark:text-stone-300 font-medium">
                                    <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
                                    <span>{formatAgentToolStepLabel(runningTool)}</span>
                                </div>
                                <div className="mt-1 text-[11px] text-stone-400">
                                    {runningTool.tool === "canvas_batch_generate_nodes"
                                        ? `正在画布排布并并行生成 ${Array.isArray(runningTool.arguments.tasks) ? runningTool.arguments.tasks.length : 4} 个节点...`
                                        : "正在画布创建节点并启动精细渲染..."}
                                </div>
                            </div>
                        )}
                        {streamingText && !runningTool && <SmoothStreamText rawText={streamingText} running={running} />}
                    </div>
                )}
            </div>

            {/* Quick Prompts */}
            <div className="shrink-0 border-t px-3 pt-2 pb-1" style={{ borderColor: theme.node.stroke }}>
                <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1">
                    {QUICK_PROMPTS.map((qp, i) => (
                        <button
                            key={i}
                            type="button"
                            className="shrink-0 rounded-full border border-stone-200/80 bg-white/50 px-2.5 py-1 text-[11px] text-stone-600 transition hover:border-stone-300 hover:bg-stone-50 dark:border-stone-800 dark:bg-stone-900/40 dark:text-stone-300 dark:hover:bg-stone-800"
                            onClick={() => send(qp.text)}
                            disabled={running}
                        >
                            {qp.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Composer */}
            <div className="shrink-0 p-3 pt-1">
                <div className="relative rounded-xl border border-stone-200/90 bg-white p-2 shadow-2xs dark:border-stone-800 dark:bg-stone-900">
                    <textarea
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                void send();
                            }
                        }}
                        placeholder="给画布 Agent 发送指令或创作需求..."
                        rows={2}
                        className="w-full resize-none border-none bg-transparent p-1 text-xs outline-none placeholder:text-stone-400"
                        style={{ color: theme.node.text }}
                        disabled={running}
                    />

                    <div className="flex items-center justify-between pt-1">
                        <span className="text-[10px] text-stone-400">Enter 发送 · Shift+Enter 换行</span>
                        {running ? (
                            <Button
                                size="small"
                                danger
                                type="primary"
                                shape="circle"
                                className="!size-7 !min-w-7"
                                icon={<Square className="size-3 fill-current" />}
                                onClick={handleStop}
                            />
                        ) : (
                            <Button
                                size="small"
                                type="primary"
                                shape="circle"
                                className="!size-7 !min-w-7 bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900"
                                disabled={!input.trim()}
                                icon={<ArrowUp className="size-3.5" />}
                                onClick={() => void send()}
                            />
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
