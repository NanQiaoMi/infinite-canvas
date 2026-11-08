import { App, Button, Drawer, Modal, Spin } from "antd";
import { ArrowRight, ImageIcon, Menu, PenLine, Sparkles, WandSparkles } from "lucide-react";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { nativeToolCallsToAgent, serializeToolResult } from "@/lib/conversation-agent/protocol";
import { runAgentTurn } from "@/lib/conversation-agent/runtime";
import { agentLocaleOf } from "@/lib/conversation-agent/system-prompt";
import { AGENT_TOOLS, executeAgentTool } from "@/lib/conversation-agent/tools";
import type { AgentContextInput, AgentEvent, AgentImageRef, AgentMessage, AgentModelCall, AgentToolCall, AgentToolResult } from "@/lib/conversation-agent/types";
import { requestConversationTurn } from "@/services/api/image";
import { uploadImage } from "@/services/image-storage";
import { decodeChannelModel, findModelOptionByQuery, modelOptionLabel, selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { useConversationAgentStore } from "@/stores/use-conversation-agent-store";
import { useQuotaStore } from "@/stores/use-quota-store";
import { cn } from "@/lib/utils";

import { ChatComposer } from "./components/chat-composer";
import { ChatMessage, ToolResultBody } from "./components/chat-message";
import { ChatSessionList } from "./components/chat-session-list";
import { ArtifactPanel } from "./components/artifact-panel";
import { CommandPalette } from "./components/command-palette";
import { StepTrail, type AgentStep } from "./components/step-trail";
import { GenerationWaiting, ThinkingLine } from "./components/generation-waiting";
import { SmoothStreamText } from "./components/smooth-stream-text";

const modelLabelOf = (option: string) => option.split("::").pop() || option;
import { formatAgentToolStepLabel, getInitialUnderstandStepLabel } from "@/lib/conversation-agent/formatters";
import { detectAgentIntent, type AgentIntent } from "@/lib/conversation-agent/intent";
import { consumeLaunchPageContext, isSessionRunning, selectActiveChatSession, selectChatSessions, sessionSwitchResetPlan } from "@/lib/conversation-agent/session-view";
import {
    clearDiagnostics,
    formatDiagnosticsReport,
    getDiagnosticEvents,
    hydrateDiagnostics,
    recordDiagnostic,
    subscribeDiagnostics,
    summarizeDiagnostics,
    summarizeDiagnosticsByDay,
    type DiagnosticEvent,
} from "@/lib/conversation-agent/diagnostics";

const NETWORK_ERROR_PATTERN = /network error|failed to fetch|load failed|networkerror|econnreset|socket hang up|fetch failed|timeout|timed out|超时|无响应|\b50[234]\b/i;
const isNetworkError = (error: unknown) => NETWORK_ERROR_PATTERN.test(error instanceof Error ? error.message : String(error));

export default function ChatPage() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    // 生成诊断：内存环形缓冲，记录生图/模型失败，可复制报告用于排查
    const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
    const [diagnosticEvents, setDiagnosticEvents] = useState<DiagnosticEvent[]>(() => getDiagnosticEvents());
    useEffect(() => {
        void hydrateDiagnostics();
        return subscribeDiagnostics(() => setDiagnosticEvents(getDiagnosticEvents()));
    }, []);
    const diagnosticSummary = summarizeDiagnostics(diagnosticEvents);
    const diagnosticDaily = summarizeDiagnosticsByDay(diagnosticEvents, 7);
    const hydrated = useConversationAgentStore((state) => state.hydrated);
    const sessions = useConversationAgentStore((state) => state.sessions);
    const activeSessionId = useConversationAgentStore((state) => state.activeSessionId);
    const sessionRuns = useConversationAgentStore((state) => state.sessionRuns);
    const setSessionRun = useConversationAgentStore((state) => state.setSessionRun);
    const clearSessionRun = useConversationAgentStore((state) => state.clearSessionRun);
    const launchContext = useConversationAgentStore((state) => state.launchContext);
    const pendingReference = useConversationAgentStore((state) => state.pendingReference);
    const pendingReferences = useConversationAgentStore((state) => state.pendingReferences);
    const consumeReference = useConversationAgentStore((state) => state.consumeReference);
    const consumeReferences = useConversationAgentStore((state) => state.consumeReferences);
    const composerDraft = useConversationAgentStore((state) => state.composerDraft);
    const consumeComposerDraft = useConversationAgentStore((state) => state.consumeComposerDraft);
    const closeArtifact = useConversationAgentStore((state) => state.closeArtifact);
    const hydrate = useConversationAgentStore((state) => state.hydrate);
    const createSession = useConversationAgentStore((state) => state.createSession);
    const deleteSession = useConversationAgentStore((state) => state.deleteSession);
    const renameSession = useConversationAgentStore((state) => state.renameSession);
    const setActiveSession = useConversationAgentStore((state) => state.setActiveSession);
    const appendMessages = useConversationAgentStore((state) => state.appendMessages);
    const setLaunchContext = useConversationAgentStore((state) => state.setLaunchContext);
    const textModel = useConfigStore((state) => state.config.textModel);
    const quotaStatus = useQuotaStore((state) => state.status);
    const imageUsage = quotaStatus?.capabilities?.image;
    const quotaHint = imageUsage && imageUsage.dailyLimit > 0 ? t("chat.quotaHint", { used: imageUsage.dailyUsed, limit: imageUsage.dailyLimit }) : "";
    const [input, setInput] = useState("");
    const [references, setReferences] = useState<AgentImageRef[]>([]);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [pageContext, setPageContext] = useState<string | undefined>(undefined);
    const [listOpen, setListOpen] = useState(false);

    const controllersRef = useRef<Map<string, AbortController>>(new Map());
    const scrollRef = useRef<HTMLDivElement | null>(null);
    // 会话视图只展示 chat 会话；当前会话严格按 store 的 activeSessionId 命中，失效时显示空态而不是静默切到另一个会话。
    const chatSessions = useMemo(() => selectChatSessions(sessions), [sessions]);
    const activeSession = useMemo(() => selectActiveChatSession(sessions, activeSessionId), [sessions, activeSessionId]);

    // 当前活跃对话的独立执行状态切片，彻底消除跨对话交叉污染
    const activeRun = activeSession?.id ? sessionRuns[activeSession.id] : undefined;
    const running = activeRun?.running ?? false;
    const streamingText = activeRun?.streamingText ?? "";
    const runningTool = activeRun?.runningTool ?? null;
    const steps = activeRun?.steps ?? [];
    const completedToolResults = activeRun?.completedToolResults ?? [];
    const turnStartedAt = activeRun?.turnStartedAt ?? 0;
    const runningIntent = activeRun?.intent ?? null;

    useEffect(() => {
        void hydrate();
    }, [hydrate]);

    useEffect(() => {
        if (!launchContext) return;
        const prompt = launchContext.prompt?.trim() || "";
        if (prompt) setInput(prompt);
        const pageName = launchContext.page === "video" ? t("chat.context.videoPage") : t("chat.context.imagePage");
        setPageContext(prompt ? t("chat.context.pageWithPrompt", { page: pageName, prompt: prompt.slice(0, 300) }) : pageName);
        setLaunchContext(null);
    }, [launchContext, setLaunchContext, t]);

    useEffect(() => {
        const handler = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
                event.preventDefault();
                setPaletteOpen((value) => !value);
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, []);

    const lastSessionRef = useRef<string | null | undefined>(undefined);
    useLayoutEffect(() => {
        const node = scrollRef.current;
        const currentActiveId = activeSession?.id ?? null;
        // 切换会话时统一清理跨会话残留：输入框、启动上下文、参考图、全局信箱与产物面板，A 会话的内容不再注入 B 会话。
        const reset = sessionSwitchResetPlan(lastSessionRef.current, currentActiveId);
        lastSessionRef.current = currentActiveId;
        if (reset) {
            if (reset.composer) setInput("");
            if (reset.pageContext) setPageContext(undefined);
            if (reset.references) setReferences([]);
            if (reset.mailboxes) {
                consumeReferences();
                consumeReference();
                consumeComposerDraft();
            }
            if (reset.artifact) closeArtifact();
            if (node) node.scrollTop = node.scrollHeight;
            return;
        }
        if (!node) return;
        if (node.scrollHeight - node.scrollTop - node.clientHeight < 160) {
            node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
        }
    }, [activeSession?.id, activeSession?.messages.length, runningTool, closeArtifact, consumeComposerDraft, consumeReference, consumeReferences]);

    useLayoutEffect(() => {
        const node = scrollRef.current;
        if (!node || !streamingText) return;
        if (node.scrollHeight - node.scrollTop - node.clientHeight < 200) node.scrollTop = node.scrollHeight;
    }, [streamingText]);

    const buildContext = useCallback((): AgentContextInput => {
        const config = useConfigStore.getState().config;
        const imageOptions = selectableModelsByCapability(config, "image");
        const usage = useQuotaStore.getState().status?.capabilities?.image;
        return {
            imageModels: imageOptions.map(modelLabelOf).slice(0, 20),
            defaultImageModel: config.imageModel ? modelLabelOf(config.imageModel) : "",
            defaultSize: config.size,
            defaultQuality: config.quality,
            defaultCount: config.count,
            quota: usage ? { dailyUsed: usage.dailyUsed, dailyLimit: usage.dailyLimit, weeklyUsed: usage.weeklyUsed, weeklyLimit: usage.weeklyLimit } : undefined,
            pageContext,
            toolChannel: "text",
        };
    }, [pageContext]);

    const createModelCaller = useCallback(
        (targetSessionId: string): AgentModelCall =>
            async ({ systemPrompt, messages, tools, signal, onDelta }) => {
                const config = useConfigStore.getState().config;
                if (!config.textModel) throw new Error(t("chat.errors.noTextModel"));
                // chatgpt2api 不支持原生 function calling：声明 tools 会让模型声称「后端不支持」，
                // 因此只有管理员把渠道工具协议设为 native 时才发送原生 tools，其余走系统提示词的文本协议。
                const textChannel = config.channels.find((channel) => channel.id === (config.textModel.split("::")[0] || ""));
                const nativeTools = textChannel?.toolProtocol === "native";
                const run = () =>
                    requestConversationTurn(
                        { ...config, model: config.textModel },
                        messages.map((item) => ({ role: item.role, content: item.content })),
                        { systemPrompt, tools: nativeTools ? tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) : [], onDelta, signal },
                    );
                let turn: Awaited<ReturnType<typeof requestConversationTurn>>;
                const maxRetries = 2;
                for (let attempt = 0; ; attempt += 1) {
                    try {
                        turn = await run();
                        break;
                    } catch (error) {
                        if (signal.aborted || !isNetworkError(error) || attempt >= maxRetries) throw error;
                        // 网络抖动自动重试：最多 2 次，退避 900ms / 1800ms，并在思维链里明确展示第几次重试
                        useConversationAgentStore.getState().setSessionRun(targetSessionId, (current) => ({
                            ...current,
                            steps: [
                                ...current.steps,
                                {
                                    id: `retry-${Date.now()}-${attempt}`,
                                    kind: "retry" as const,
                                    label: `${t("chat.steps.networkWaitRetry")}（${attempt + 1}/${maxRetries}）`,
                                    status: "waiting-retry" as const,
                                },
                            ],
                        }));
                        await new Promise((resolve) => setTimeout(resolve, 900 * (attempt + 1)));
                        useConversationAgentStore.getState().setSessionRun(targetSessionId, (current) => ({
                            ...current,
                            steps: current.steps.map((s) => (s.status === "waiting-retry" ? { ...s, status: "done" as const } : s)),
                        }));
                    }
                }
                const native = nativeToolCallsToAgent(turn.toolCalls.map((call) => ({ name: call.name, arguments: call.arguments })));
                return { content: turn.content, toolCalls: native.calls, toolCallErrors: native.errors };
            },
        [t],
    );

    const send = useCallback(
        async (rawText?: string) => {
            let text = (rawText ?? input).trim();
            if (!text) return;
            // 本会话指 store 当前 activeSessionId 命中的 chat 会话（与页面严格选择一致）；失效时发送会自动新建。
            const storeAtSend = useConversationAgentStore.getState();
            const storeActiveChat = storeAtSend.sessions.find((item) => item.id === storeAtSend.activeSessionId && item.scope !== "canvas");
            const currentSessionId = activeSession?.id ?? storeActiveChat?.id ?? null;
            const ensureSessionId = () => currentSessionId ?? createSession({ scope: "chat" });
            // 重复提交守卫只看本会话的运行态：全局 running 会被其它会话/面板的运行态覆盖，不能作为本会话依据。
            if (isSessionRunning(storeAtSend.sessionRuns, currentSessionId)) return;
            if (text.startsWith("/")) {
                const [command, ...rest] = text.split(/\s+/);
                const payload = rest.join(" ").trim();
                if (command === "/new") {
                    createSession();
                    setInput("");
                    return;
                }
                if (command === "/help") {
                    const sessionId = ensureSessionId();
                    appendMessages(sessionId, [{ id: nanoid(), role: "assistant", text: t("chat.commands.helpText"), promptBlocks: [], createdAt: Date.now() }]);
                    setInput("");
                    return;
                }
                if (command === "/model") {
                    const config = useConfigStore.getState().config;
                    const options = selectableModelsByCapability(config, "text");
                    if (!payload) {
                        const sessionId = ensureSessionId();
                        const models = options
                            .map((option) => {
                                const decoded = decodeChannelModel(option);
                                const channel = config.channels.find((c) => c.id === decoded?.channelId);
                                return channel ? `${channel.name}/${decoded?.model}` : (decoded?.model || option);
                            })
                            .join("、");
                        appendMessages(sessionId, [
                            {
                                id: nanoid(),
                                role: "assistant",
                                text: t("chat.commands.modelList", { current: modelOptionLabel(config, config.textModel), models }),
                                promptBlocks: [],
                                createdAt: Date.now(),
                            },
                        ]);
                        setInput("");
                        return;
                    }
                    const matchResult = findModelOptionByQuery(payload, config, "text");
                    if (!matchResult.matched) {
                        if (matchResult.suggestions?.length) {
                            message.warning(t("chat.commands.channelModelSuggestions", { channel: matchResult.channel?.name, models: matchResult.suggestions.join("、") }));
                        } else {
                            message.warning(t("chat.commands.unknownModel", { name: payload }));
                        }
                        return;
                    }
                    useConfigStore.getState().updateConfig("textModel", matchResult.matched);
                    message.success(t("chat.commands.modelSwitched", { model: modelOptionLabel(config, matchResult.matched) }));
                    setInput("");
                    return;
                }
                if (command === "/prompt" && payload) text = t("chat.commands.promptPrefix", { text: payload });
                else if (command === "/image" && payload) text = t("chat.commands.imagePrefix", { text: payload });
                else if (command === "/edit") {
                    if (!references.length) {
                        message.warning(t("chat.commands.editNeedsReference"));
                        return;
                    }
                    if (payload) text = t("chat.commands.editPrefix", { text: payload });
                }
            }
            const sessionId = ensureSessionId();
            // targetSessionId 在进入 await 前固定，后续 appendMessages/setSessionRun 全部按它归属，多会话并发不混流。
            const targetSessionId = sessionId;
            const turnId = `turn_${nanoid()}`;
            const attachments = references.length ? references : undefined;

            appendMessages(targetSessionId, [
                {
                    id: nanoid(),
                    threadId: targetSessionId,
                    turnId,
                    itemId: nanoid(),
                    role: "user",
                    text,
                    attachments,
                    createdAt: Date.now(),
                },
            ]);
            setReferences([]);
            setInput("");

            const history = useConversationAgentStore.getState().sessions.find((session) => session.id === targetSessionId)?.messages ?? [];
            // 从生图/视频工作台带入的草稿提示词只注入本轮（启动后的首轮），随后清空，避免常驻 system prompt 影响后续轮次。
            const turnPageContext = consumeLaunchPageContext(pageContext);
            if (turnPageContext.clear) setPageContext(undefined);
            const intent = detectAgentIntent(text, { hasReferences: Boolean(attachments?.length), history });
            const initialLabel = getInitialUnderstandStepLabel(text, intent);

            setSessionRun(targetSessionId, {
                running: true,
                streamingText: "",
                runningTool: null,
                steps: [{ id: "understand", kind: "understand", label: initialLabel, status: "running" }],
                completedToolResults: [],
                turnStartedAt: Date.now(),
                intent,
                turnId,
            });

            const controller = new AbortController();
            controllersRef.current.set(targetSessionId, controller);
            let stepSeq = 0;
            const activeToolStepsMap = new Map<string, string>();

            try {
                const result = await runAgentTurn({
                    locale: agentLocaleOf(i18n.language),
                    messages: history,
                    tools: AGENT_TOOLS,
                    // 本轮真正运行的会话 id：apply_prompt 等工具按它归属工作台命令，而不是全局 activeSessionId
                    sessionId: targetSessionId,
                    buildContext: () => ({ ...buildContext(), pageContext: turnPageContext.pageContext }),
                    callModel: createModelCaller(targetSessionId),
                    executeTool: (call, context) => executeAgentTool(call, context),
                    onEvent: (event: AgentEvent) => {
                        if (event.type === "assistant-stream") {
                            setSessionRun(targetSessionId, (prev) => {
                                const hasTool = prev.steps.some((step) => step.kind === "tool");
                                const isActionIntent = intent.kind === "generate_image" || intent.kind === "edit_image";
                                let nextSteps = prev.steps;
                                if (!isActionIntent || hasTool) {
                                    nextSteps = prev.steps.map((step) =>
                                        (step.status === "running" && step.kind === "understand") || step.status === "correction"
                                            ? { ...step, status: "done" as const }
                                            : step,
                                    );
                                    if (!nextSteps.some((step) => step.status === "running")) {
                                        nextSteps = [
                                            ...nextSteps,
                                            {
                                                id: `respond-${nextSteps.length}`,
                                                kind: hasTool ? "summarize" : "respond",
                                                label: hasTool ? t("chat.steps.summarize") : t("chat.steps.respond"),
                                                status: "running",
                                            },
                                        ];
                                    }
                                }
                                return { ...prev, streamingText: event.text, steps: nextSteps };
                            });
                        } else if (event.type === "tool-start") {
                            stepSeq += 1;
                            const stepId = `tool-${stepSeq}`;
                            const callKey = `${event.call.tool}:${event.call.arguments.title || event.call.arguments.prompt || JSON.stringify(event.call.arguments)}`;
                            activeToolStepsMap.set(callKey, stepId);
                            setSessionRun(targetSessionId, (prev) => {
                                const nextSteps = prev.steps.map((step) =>
                                    step.status === "running" || step.status === "correction" || step.status === "waiting-retry"
                                        ? { ...step, status: "done" as const }
                                        : step,
                                );
                                return {
                                    ...prev,
                                    streamingText: "",
                                    runningTool: event.call,
                                    steps: [...nextSteps, { id: stepId, kind: "tool" as const, label: formatAgentToolStepLabel(event.call), status: "running" as const }],
                                };
                            });
                        } else if (event.type === "correction-start") {
                            stepSeq += 1;
                            setSessionRun(targetSessionId, (prev) => {
                                const nextSteps = prev.steps.map((step) => (step.status === "running" ? { ...step, status: "done" as const } : step));
                                return {
                                    ...prev,
                                    steps: [
                                        ...nextSteps,
                                        {
                                            id: `correction-${stepSeq}`,
                                            kind: "correction" as const,
                                            label: t("chat.steps.correctionLabel"),
                                            status: "correction" as const,
                                        },
                                    ],
                                };
                            });
                        } else if (event.type === "tool-end") {
                            const callKey = `${event.call.tool}:${event.call.arguments.title || event.call.arguments.prompt || JSON.stringify(event.call.arguments)}`;
                            const stepId = activeToolStepsMap.get(callKey);
                            activeToolStepsMap.delete(callKey);
                            setSessionRun(targetSessionId, (prev) => {
                                const nextSteps = prev.steps.map((step) =>
                                    (step.id === stepId || (!stepId && step.kind === "tool" && step.status === "running"))
                                        ? { ...step, status: "done" as const }
                                        : step,
                                );
                                const isImageTool = event.call.tool === "generate_image" || event.call.tool === "edit_image";
                                const completed = isImageTool
                                    ? [...prev.completedToolResults, { id: nanoid(), call: event.call, result: event.result }]
                                    : prev.completedToolResults;
                                return {
                                    ...prev,
                                    runningTool: null,
                                    steps: nextSteps,
                                    completedToolResults: completed,
                                };
                            });
                        }
                    },
                    signal: controller.signal,
                    references: attachments,
                });

                const currentRun = useConversationAgentStore.getState().sessionRuns[targetSessionId];
                const finalSteps = (currentRun?.steps || []).map((s) => (s.status === "running" ? { ...s, status: "done" as const } : s));
                let messagesWithSteps = [...result.messages].map((m) => ({
                    ...m,
                    threadId: targetSessionId,
                    turnId,
                    itemId: m.id,
                }));
                if (finalSteps.length > 0) {
                    const firstToolIdx = messagesWithSteps.findIndex((m) => m.role === "tool");
                    const firstAssistantIdx = messagesWithSteps.findIndex((m) => m.role === "assistant");
                    // 确保步骤思维链（StepTrail）永远置顶呈现在本轮消息的最上方，保持生成中与生成完成后的视觉布局绝对稳定
                    if (firstToolIdx !== -1 && (firstAssistantIdx === -1 || firstToolIdx < firstAssistantIdx)) {
                        messagesWithSteps.unshift({
                            id: nanoid(),
                            threadId: targetSessionId,
                            turnId,
                            itemId: nanoid(),
                            role: "assistant",
                            text: "",
                            steps: finalSteps,
                            promptBlocks: [],
                            createdAt: Date.now(),
                        });
                    } else if (firstAssistantIdx !== -1) {
                        messagesWithSteps = messagesWithSteps.map((msg, idx) =>
                            idx === firstAssistantIdx ? { ...msg, steps: finalSteps } : msg,
                        );
                    } else {
                        messagesWithSteps.unshift({
                            id: nanoid(),
                            threadId: targetSessionId,
                            turnId,
                            itemId: nanoid(),
                            role: "assistant",
                            text: "",
                            steps: finalSteps,
                            promptBlocks: [],
                            createdAt: Date.now(),
                        });
                    }
                }
                appendMessages(targetSessionId, messagesWithSteps);
                if (result.roundLimitReached) {
                    appendMessages(targetSessionId, [
                        {
                            id: nanoid(),
                            threadId: targetSessionId,
                            turnId,
                            itemId: nanoid(),
                            role: "error",
                            text: t("chat.errors.tooManyRounds"),
                            createdAt: Date.now(),
                        },
                    ]);
                }
            } catch (error) {
                const aborted = controller.signal.aborted;
                const currentRun = useConversationAgentStore.getState().sessionRuns[targetSessionId];
                const partial = currentRun?.streamingText || "";
                if (aborted) {
                    if (partial.trim()) {
                        appendMessages(targetSessionId, [
                            {
                                id: nanoid(),
                                threadId: targetSessionId,
                                turnId,
                                itemId: nanoid(),
                                role: "assistant",
                                text: partial,
                                promptBlocks: [],
                                createdAt: Date.now(),
                            },
                        ]);
                    }
                } else {
                    const raw = error instanceof Error ? error.message : String(error);
                    recordDiagnostic({
                        category: "model",
                        level: "error",
                        message: isNetworkError(error) ? `model network error: ${raw}` : `model failed: ${raw}`,
                        detail: { sessionId: targetSessionId, model: useConfigStore.getState().config.textModel },
                    });
                    appendMessages(targetSessionId, [
                        {
                            id: nanoid(),
                            threadId: targetSessionId,
                            turnId,
                            itemId: nanoid(),
                            role: "error",
                            text: isNetworkError(error) ? t("chat.errors.network") : raw,
                            createdAt: Date.now(),
                        },
                    ]);
                }
            } finally {
                clearSessionRun(targetSessionId);
                controllersRef.current.delete(targetSessionId);
                useQuotaStore.getState().scheduleRefresh();
            }
        },
        [activeSession?.id, appendMessages, buildContext, createModelCaller, clearSessionRun, createSession, input, pageContext, references, setSessionRun, t],
    );

    const stop = () => {
        if (!activeSession?.id) return;
        const controller = controllersRef.current.get(activeSession.id);
        if (controller) {
            controller.abort();
            controllersRef.current.delete(activeSession.id);
        }
    };

    const addReferenceFiles = async (files: File[]) => {
        const added = await Promise.all(
            files.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), storageKey: image.storageKey, width: image.width, height: image.height, prompt: "", model: "" } satisfies AgentImageRef;
            }),
        );
        setReferences((current) => [...current, ...added]);
    };

    useEffect(() => {
        // 直接读 store 的当前值：切会话的 layout effect 可能已在同一提交里清空信箱，避免旧会话参考图被注入新会话。
        const store = useConversationAgentStore.getState();
        const incoming = store.pendingReferences?.length ? store.pendingReferences : store.pendingReference ? [store.pendingReference] : [];
        if (!incoming.length) return;
        setReferences((current) => {
            const existingKeys = new Set(current.map((item) => item.storageKey));
            const toAdd = incoming.filter((item) => !existingKeys.has(item.storageKey)).map((item) => ({ ...item, id: nanoid() }));
            return [...current, ...toAdd];
        });
        store.consumeReferences();
        store.consumeReference();
    }, [pendingReference, pendingReferences]);

    useEffect(() => {
        const draft = useConversationAgentStore.getState().composerDraft;
        if (draft === null) return;
        setInput(draft);
        useConversationAgentStore.getState().consumeComposerDraft();
    }, [composerDraft]);

    const retryMessage = (index: number) => {
        const messages = activeSession?.messages ?? [];
        const previous = messages.slice(0, index).reverse().find((item) => item.role === "user");
        if (previous?.text) void send(previous.text);
    };

    /** 工具失败（如生成中断/网络异常）后就地重试同一工具调用，无需让用户重新描述需求。 */
    const retryTool = useCallback(
        async (message: Extract<AgentMessage, { role: "tool" }>) => {
            const sessionId = activeSession?.id;
            if (!sessionId || isSessionRunning(useConversationAgentStore.getState().sessionRuns, sessionId)) return;
            const controller = new AbortController();
            controllersRef.current.set(sessionId, controller);
            const startedAt = Date.now();
            try {
                const result = await executeAgentTool(message.call, { signal: controller.signal, sessionId });
                appendMessages(sessionId, [
                    {
                        id: nanoid(),
                        role: "tool",
                        call: message.call,
                        result,
                        text: serializeToolResult(message.call, result),
                        createdAt: Date.now(),
                        durationMs: Date.now() - startedAt,
                    },
                ]);
                useQuotaStore.getState().scheduleRefresh();
            } catch (error) {
                appendMessages(sessionId, [{ id: nanoid(), role: "error", text: error instanceof Error ? error.message : String(error), createdAt: Date.now() }]);
            } finally {
                controllersRef.current.delete(sessionId);
            }
        },
        [activeSession?.id, appendMessages],
    );

    const createAndClose = () => {
        createSession({ scope: "chat" });
        setListOpen(false);
    };

    const handleDeleteSession = useCallback(
        (id: string) => {
            const controller = controllersRef.current.get(id);
            if (controller) {
                controller.abort();
                controllersRef.current.delete(id);
            }
            deleteSession(id);
        },
        [deleteSession],
    );

    const sessionList = (
        <ChatSessionList
            sessions={chatSessions}
            activeSessionId={activeSession?.id ?? null}
            modelLabel={textModel ? modelLabelOf(textModel) : ""}
            quotaHint={quotaHint}
            onSelect={(id) => {
                setActiveSession(id);
                setListOpen(false);
            }}
            onCreate={createAndClose}
            onDelete={handleDeleteSession}
            onRename={renameSession}
        />
    );

    if (!hydrated) {
        return (
            <div className="flex h-full items-center justify-center">
                <Spin />
            </div>
        );
    }

    const welcome = (
        <div className="agent-fade-in flex flex-1 flex-col items-center justify-center px-4 py-16 text-center">
            {/* 灵动星芒徽章，带呼吸光晕 */}
            <div className="relative mb-6 flex size-14 items-center justify-center">
                <div className="absolute inset-0 animate-[pulse_3s_ease-in-out_infinite] rounded-full bg-stone-200/60 blur-md dark:bg-stone-700/40" />
                <div className="relative flex size-12 items-center justify-center rounded-2xl border border-stone-200/90 bg-gradient-to-b from-white to-stone-100/90 shadow-xs dark:border-stone-700/80 dark:from-stone-800 dark:to-stone-900">
                    <Sparkles className="size-6 text-stone-700 dark:text-stone-200" />
                </div>
            </div>

            <h1 className="font-serif text-[32px] font-normal leading-tight tracking-tight text-stone-900 dark:text-stone-100">
                {t("chat.welcome.title")}
            </h1>
            <p className="mt-3.5 max-w-md text-sm leading-relaxed text-stone-500 dark:text-stone-400">
                {t("chat.welcome.description")}
            </p>

            <div className="mt-10 grid w-full max-w-md gap-2.5">
                {[
                    { command: t("chat.welcome.examples.prompt"), icon: PenLine },
                    { command: t("chat.welcome.examples.image"), icon: ImageIcon },
                    { command: t("chat.welcome.examples.edit"), icon: WandSparkles },
                ].map(({ command, icon: Icon }) => (
                    <button
                        key={command}
                        type="button"
                        className="group flex items-center gap-3.5 rounded-2xl border border-stone-200/90 bg-white/70 px-4 py-3 text-left text-[13px] text-stone-600 shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:border-stone-300 hover:bg-white hover:shadow-sm dark:border-stone-800 dark:bg-stone-900/40 dark:text-stone-300 dark:hover:border-stone-700 dark:hover:bg-stone-900/80"
                        onClick={() => setInput(command)}
                    >
                        <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-stone-100 text-stone-500 transition group-hover:bg-stone-200/70 dark:bg-stone-800 dark:text-stone-400 dark:group-hover:bg-stone-700/70">
                            <Icon className="size-3.5" />
                        </div>
                        <span className="min-w-0 flex-1 truncate font-medium">{command}</span>
                        <ArrowRight className="size-3.5 shrink-0 text-stone-400 opacity-40 transition-all duration-200 group-hover:translate-x-0.5 group-hover:opacity-90 dark:text-stone-500" />
                    </button>
                ))}
            </div>
        </div>
    );

    return (
        <div className="agent-page-in flex h-full min-h-0 bg-[#faf9f5] text-stone-900 dark:bg-[#1c1b19] dark:text-stone-100">
            <aside className="hidden w-[276px] shrink-0 border-r border-stone-200/70 bg-[#f2efe8] lg:block dark:border-stone-800 dark:bg-[#171614]">{sessionList}</aside>
            <main className="flex min-w-0 flex-1 flex-col">
                <div className="flex h-12 shrink-0 items-center gap-2 px-3 lg:hidden">
                    <Button size="small" type="text" icon={<Menu className="size-4" />} onClick={() => setListOpen(true)} />
                    <span className="text-sm font-semibold">{t("meta.title")}</span>
                </div>
                <div className="relative flex min-h-0 flex-1 flex-col">
                    <div ref={scrollRef} className="hover-scrollbar min-h-0 flex-1 overflow-y-auto">
                        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-8 px-4 pb-14 pt-8 sm:px-6">
                            {!activeSession || activeSession.messages.length === 0
                                ? welcome
                                : activeSession.messages.map((item, index) => (
                                      <ChatMessage key={item.id} message={item} onRetry={item.role === "error" ? () => retryMessage(index) : undefined} onToolRetry={item.role === "tool" ? (message) => void retryTool(message) : undefined} />
                                  ))}
                            {steps.length ? <StepTrail steps={steps} running={running} startedAt={turnStartedAt || undefined} /> : null}
                            {completedToolResults.map((item) => (
                                <div key={item.id} className="agent-message-in w-full space-y-2">
                                    <ToolResultBody result={item.result} />
                                </div>
                            ))}
                            {running && streamingText && completedToolResults.length === 0 && !runningTool && !(runningIntent?.kind === "generate_image" || runningIntent?.kind === "edit_image") ? (
                                <div className="agent-message-in w-full">
                                    <SmoothStreamText rawText={streamingText} running={running} />
                                </div>
                            ) : null}
                            {runningTool && (runningTool.tool === "generate_image" || runningTool.tool === "edit_image") ? (
                                <GenerationWaiting call={runningTool} startedAt={turnStartedAt || Date.now()} />
                            ) : null}
                            {running && streamingText && completedToolResults.length > 0 ? (
                                <div className="agent-message-in w-full">
                                    <SmoothStreamText rawText={streamingText} running={running} />
                                </div>
                            ) : null}
                            {runningTool && runningTool.tool === "apply_prompt" ? (
                                <div className="agent-fade-in w-full">
                                    <div className="inline-flex items-center gap-2 rounded-xl border border-stone-200/80 bg-white/70 px-3 py-1.5 text-xs text-stone-500 shadow-xs dark:border-stone-800 dark:bg-stone-900/40 dark:text-stone-400">
                                        <span className="inline-block size-2 animate-pulse rounded-full bg-amber-500" />
                                        apply_prompt · {t("chat.tools.names.apply_prompt")}
                                    </div>
                                </div>
                            ) : null}
                            {running && !streamingText && !runningTool && completedToolResults.length === 0 && !steps.length ? <ThinkingLine startedAt={turnStartedAt || Date.now()} /> : null}
                        </div>
                    </div>
                    {/* 底部向上渐变遮罩，使接近输入框的文字柔和淡化，不再生硬切断 */}
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-[#faf9f5] to-transparent dark:from-[#1c1b19] z-10" />
                </div>
                <div className="shrink-0 px-3 pb-4 sm:px-6">
                    <div className="mx-auto w-full max-w-3xl">
                        <ChatComposer
                            value={input}
                            onChange={setInput}
                            onSend={() => void send()}
                            onStop={stop}
                            running={running}
                            modelLabel={textModel ? modelLabelOf(textModel) : ""}
                            references={references}
                            onAddFiles={(files) => void addReferenceFiles(files)}
                            onRemoveReference={(id) => setReferences((current) => current.filter((item) => item.id !== id))}
                            quotaHint={quotaHint}
                            onOpenDiagnostics={() => setDiagnosticsOpen(true)}
                        />
                    </div>
                </div>
            </main>
            <Drawer open={listOpen} placement="left" width={272} onClose={() => setListOpen(false)} styles={{ body: { padding: 0, background: "var(--color-card)" } }}>
                {sessionList}
            </Drawer>
            <ArtifactPanel />
            <CommandPalette
                open={paletteOpen}
                onClose={() => setPaletteOpen(false)}
                sessions={chatSessions}
                activeSessionId={activeSession?.id ?? null}
                onSelectSession={(id) => setActiveSession(id)}
                onNewChat={createAndClose}
                onCommand={(command) => {
                    setInput(`${command} `);
                }}
            />
            <Modal open={diagnosticsOpen} onCancel={() => setDiagnosticsOpen(false)} footer={null} width={720} title="生成诊断">
                <div className="space-y-3">
                    <div className="grid grid-cols-4 gap-2 text-center">
                        {[
                            { label: "生成尝试", value: diagnosticSummary.attempts },
                            { label: "成功", value: diagnosticSummary.successes },
                            { label: "失败", value: diagnosticSummary.failures },
                            { label: "模型错误", value: diagnosticSummary.modelErrors },
                        ].map((item) => (
                            <div key={item.label} className="rounded-xl border border-stone-200/80 px-2 py-2 dark:border-stone-800">
                                <div className="text-lg font-semibold tabular-nums text-stone-700 dark:text-stone-200">{item.value}</div>
                                <div className="text-[11px] text-stone-400">{item.label}</div>
                            </div>
                        ))}
                    </div>
                    <div className="rounded-xl border border-stone-200/80 p-3 dark:border-stone-800">
                        <div className="mb-2 flex items-center justify-between text-[11px] text-stone-400">
                            <span>最近 7 天生成失败率</span>
                            <span>仅统计本浏览器记录</span>
                        </div>
                        <div className="space-y-1.5">
                            {diagnosticDaily.map((bucket) => (
                                <div key={bucket.day} className="flex items-center gap-2 text-[11px]">
                                    <span className="w-10 shrink-0 font-mono text-stone-400">{bucket.day}</span>
                                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/[.04] dark:bg-white/[.08]">
                                        <div
                                            className={bucket.failures > 0 ? "h-full rounded-full bg-red-400/80" : "h-full rounded-full bg-emerald-400/70"}
                                            style={{ width: `${bucket.attempts ? Math.max(4, bucket.failureRate) : 0}%` }}
                                        />
                                    </div>
                                    <span className="w-28 shrink-0 text-right font-mono text-stone-400">
                                        {bucket.attempts} 次 · 失败 {bucket.failures}（{bucket.failureRate}%）
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                    <div className="max-h-[320px] space-y-1 overflow-y-auto rounded-xl border border-stone-200/80 p-2 dark:border-stone-800">
                        {diagnosticEvents.length === 0 ? (
                            <div className="py-6 text-center text-xs text-stone-400">暂无诊断记录，生成或对话后会在这里记录</div>
                        ) : (
                            [...diagnosticEvents].reverse().map((event) => (
                                <div key={event.id} className="rounded-lg px-2 py-1.5 text-[11px]">
                                    <div className="flex items-center gap-2 font-mono">
                                        <span className={event.level === "error" ? "text-red-500" : event.level === "warn" ? "text-amber-500" : "text-emerald-500"}>{event.level.toUpperCase()}</span>
                                        <span className="text-stone-400">{new Date(event.at).toLocaleTimeString()}</span>
                                        <span className="text-stone-500">{event.category}</span>
                                    </div>
                                    <div className="mt-0.5 break-all text-stone-600 dark:text-stone-300">{event.message}</div>
                                    {event.detail ? <div className="mt-0.5 truncate text-[10px] text-stone-400">{JSON.stringify(event.detail)}</div> : null}
                                </div>
                            ))
                        )}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-stone-400">共 {diagnosticEvents.length} 条，仅保存在本浏览器内存、不会上传；复制后可直接发给开发者排查</span>
                        <div className="flex shrink-0 gap-2">
                            <Button
                                size="small"
                                disabled={!diagnosticEvents.length}
                                onClick={async () => {
                                    await navigator.clipboard.writeText(formatDiagnosticsReport(diagnosticEvents));
                                    message.success("诊断报告已复制");
                                }}
                            >
                                复制诊断报告
                            </Button>
                            <Button
                                size="small"
                                danger
                                disabled={!diagnosticEvents.length}
                                onClick={() => {
                                    clearDiagnostics();
                                    message.success("已清空诊断记录");
                                }}
                            >
                                清空
                            </Button>
                        </div>
                    </div>
                </div>
            </Modal>
        </div>
    );
}
