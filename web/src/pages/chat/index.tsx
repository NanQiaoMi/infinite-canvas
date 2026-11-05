import { App, Button, Drawer, Spin } from "antd";
import { Menu, Sparkles } from "lucide-react";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Streamdown } from "streamdown";

import i18n from "@/i18n";
import { nativeToolCallsToAgent } from "@/lib/conversation-agent/protocol";
import { runAgentTurn } from "@/lib/conversation-agent/runtime";
import { agentLocaleOf } from "@/lib/conversation-agent/system-prompt";
import { AGENT_TOOLS, executeAgentTool } from "@/lib/conversation-agent/tools";
import type { AgentContextInput, AgentEvent, AgentImageRef, AgentMessage, AgentModelCall } from "@/lib/conversation-agent/types";
import { requestConversationTurn } from "@/services/api/image";
import { uploadImage } from "@/services/image-storage";
import { selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { useConversationAgentStore } from "@/stores/use-conversation-agent-store";
import { useQuotaStore } from "@/stores/use-quota-store";
import { cn } from "@/lib/utils";

import { ChatComposer } from "./components/chat-composer";
import { ChatMessage } from "./components/chat-message";
import { ChatSessionList } from "./components/chat-session-list";
import { GenerationWaiting, ThinkingLine } from "./components/generation-waiting";

const modelLabelOf = (option: string) => option.split("::").pop() || option;
const NETWORK_ERROR_PATTERN = /network error|failed to fetch|load failed|networkerror|econnreset|socket hang up|fetch failed/i;
const isNetworkError = (error: unknown) => NETWORK_ERROR_PATTERN.test(error instanceof Error ? error.message : String(error));

export default function ChatPage() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const hydrated = useConversationAgentStore((state) => state.hydrated);
    const sessions = useConversationAgentStore((state) => state.sessions);
    const activeSessionId = useConversationAgentStore((state) => state.activeSessionId);
    const streamingText = useConversationAgentStore((state) => state.streamingText);
    const running = useConversationAgentStore((state) => state.running);
    const runningTool = useConversationAgentStore((state) => state.runningTool);
    const launchContext = useConversationAgentStore((state) => state.launchContext);
    const hydrate = useConversationAgentStore((state) => state.hydrate);
    const createSession = useConversationAgentStore((state) => state.createSession);
    const deleteSession = useConversationAgentStore((state) => state.deleteSession);
    const renameSession = useConversationAgentStore((state) => state.renameSession);
    const setActiveSession = useConversationAgentStore((state) => state.setActiveSession);
    const appendMessages = useConversationAgentStore((state) => state.appendMessages);
    const setStreamingText = useConversationAgentStore((state) => state.setStreamingText);
    const setRunning = useConversationAgentStore((state) => state.setRunning);
    const setRunningTool = useConversationAgentStore((state) => state.setRunningTool);
    const setLaunchContext = useConversationAgentStore((state) => state.setLaunchContext);
    const textModel = useConfigStore((state) => state.config.textModel);
    const quotaStatus = useQuotaStore((state) => state.status);
    const imageUsage = quotaStatus?.capabilities?.image;
    const quotaHint = imageUsage && imageUsage.dailyLimit > 0 ? t("chat.quotaHint", { used: imageUsage.dailyUsed, limit: imageUsage.dailyLimit }) : "";
    const [input, setInput] = useState("");
    const [references, setReferences] = useState<AgentImageRef[]>([]);
    const [turnStartedAt, setTurnStartedAt] = useState(0);
    const [pageContext, setPageContext] = useState<string | undefined>(undefined);
    const [listOpen, setListOpen] = useState(false);
    const controllerRef = useRef<AbortController | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;

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

    useLayoutEffect(() => {
        const node = scrollRef.current;
        if (node) node.scrollTop = node.scrollHeight;
    }, [activeSession?.messages.length, streamingText, runningTool]);

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

    const callModel: AgentModelCall = useCallback(
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
            let turn;
            try {
                turn = await run();
            } catch (error) {
                if (signal.aborted || !isNetworkError(error)) throw error;
                await new Promise((resolve) => setTimeout(resolve, 900));
                turn = await run();
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
            if (useConversationAgentStore.getState().running) return;
            if (text.startsWith("/")) {
                const [command, ...rest] = text.split(/\s+/);
                const payload = rest.join(" ").trim();
                if (command === "/new") {
                    createSession();
                    setInput("");
                    return;
                }
                if (command === "/help") {
                    let sessionId = useConversationAgentStore.getState().activeSessionId;
                    if (!sessionId) sessionId = createSession();
                    appendMessages(sessionId, [{ id: nanoid(), role: "assistant", text: t("chat.commands.helpText"), promptBlocks: [], createdAt: Date.now() }]);
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
            let sessionId = useConversationAgentStore.getState().activeSessionId;
            if (!sessionId) sessionId = createSession();
            const attachments = references.length ? references : undefined;
            appendMessages(sessionId, [{ id: nanoid(), role: "user", text, attachments, createdAt: Date.now() }]);
            setReferences([]);
            setInput("");
            setStreamingText("");
            setTurnStartedAt(Date.now());
            setRunning(true);
            const controller = new AbortController();
            controllerRef.current = controller;
            try {
                const history = useConversationAgentStore.getState().sessions.find((session) => session.id === sessionId)?.messages ?? [];
                const result = await runAgentTurn({
                    locale: agentLocaleOf(i18n.language),
                    messages: history,
                    tools: AGENT_TOOLS,
                    buildContext,
                    callModel,
                    executeTool: (call, context) => executeAgentTool(call, context),
                    onEvent: (event: AgentEvent) => {
                        if (event.type === "assistant-stream") setStreamingText(event.text);
                        else if (event.type === "tool-start") {
                            setStreamingText("");
                            setRunningTool(event.call);
                        }
                        else if (event.type === "tool-end") setRunningTool(null);
                    },
                    signal: controller.signal,
                    references: attachments,
                });
                appendMessages(sessionId, result.messages);
                if (result.roundLimitReached) appendMessages(sessionId, [{ id: nanoid(), role: "error", text: t("chat.errors.tooManyRounds"), createdAt: Date.now() }]);
            } catch (error) {
                const aborted = controller.signal.aborted;
                const partial = useConversationAgentStore.getState().streamingText;
                if (aborted) {
                    if (partial.trim()) appendMessages(sessionId, [{ id: nanoid(), role: "assistant", text: partial, promptBlocks: [], createdAt: Date.now() }]);
                } else {
                    const raw = error instanceof Error ? error.message : String(error);
                    appendMessages(sessionId, [{ id: nanoid(), role: "error", text: isNetworkError(error) ? t("chat.errors.network") : raw, createdAt: Date.now() }]);
                }
            } finally {
                controllerRef.current = null;
                setRunning(false);
                setStreamingText("");
                setRunningTool(null);
                setTurnStartedAt(0);
                useQuotaStore.getState().scheduleRefresh();
            }
        },
        [appendMessages, buildContext, callModel, createSession, input, references, setRunning, setRunningTool, setStreamingText, t],
    );

    const stop = () => {
        controllerRef.current?.abort();
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

    const useReference = (image: AgentImageRef) => {
        setReferences((current) => (current.some((item) => item.storageKey === image.storageKey) ? current : [...current, { ...image, id: nanoid() }]));
    };

    const retryMessage = (index: number) => {
        const messages = activeSession?.messages ?? [];
        const previous = messages.slice(0, index).reverse().find((item) => item.role === "user");
        if (previous?.text) void send(previous.text);
    };

    const createAndClose = () => {
        createSession();
        setListOpen(false);
    };

    const sessionList = (
        <ChatSessionList
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelect={(id) => {
                setActiveSession(id);
                setListOpen(false);
            }}
            onCreate={createAndClose}
            onDelete={deleteSession}
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
        <div className="flex flex-1 flex-col items-center justify-center gap-6 py-12 text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl border border-stone-200 bg-gradient-to-br from-white to-stone-100 shadow-sm dark:border-stone-800 dark:from-stone-900 dark:to-stone-950">
                <Sparkles className="size-6 text-stone-600 dark:text-stone-300" />
            </div>
            <div className="space-y-2">
                <h2 className="text-lg font-semibold text-stone-950 dark:text-stone-100">{t("chat.welcome.title")}</h2>
                <p className="mx-auto max-w-md text-sm leading-6 text-stone-500 dark:text-stone-400">{t("chat.welcome.description")}</p>
            </div>
            <div className="flex flex-wrap justify-center gap-1.5">
                {[t("chat.welcome.capabilities.prompts"), t("chat.welcome.capabilities.images"), t("chat.welcome.capabilities.edit"), t("chat.welcome.capabilities.workbench")].map((capability) => (
                    <span key={capability} className="rounded-full border border-stone-200 px-2.5 py-1 text-[11px] text-stone-500 dark:border-stone-700 dark:text-stone-400">
                        {capability}
                    </span>
                ))}
            </div>
            <div className="w-full max-w-md space-y-1 text-left font-mono text-xs">
                {[t("chat.welcome.examples.prompt"), t("chat.welcome.examples.image"), t("chat.welcome.examples.edit")].map((command) => (
                    <button
                        key={command}
                        type="button"
                        className="group flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-stone-500 transition hover:bg-black/[.03] hover:text-stone-800 dark:text-stone-400 dark:hover:bg-white/[.05] dark:hover:text-stone-100"
                        onClick={() => setInput(command)}
                    >
                        <span className="text-emerald-600 dark:text-emerald-400">❯</span>
                        <span className="truncate">{command}</span>
                        <span className="ml-auto text-[10px] text-stone-300 opacity-0 transition group-hover:opacity-100 dark:text-stone-600">↵</span>
                    </button>
                ))}
            </div>
        </div>
    );

    return (
        <div className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden p-3 lg:grid-cols-[240px_minmax(0,1fr)]">
                <aside className="thin-scrollbar hidden min-h-0 flex-col overflow-hidden rounded-lg border border-stone-200 bg-card shadow-sm lg:flex dark:border-stone-800">{sessionList}</aside>
                <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-stone-200 bg-card shadow-sm dark:border-stone-800">
                    <div className="flex shrink-0 items-center gap-2.5 border-b border-stone-200 px-4 py-2.5 dark:border-stone-800">
                        <Button className="lg:!hidden" size="small" type="text" icon={<Menu className="size-4" />} onClick={() => setListOpen(true)} />
                        <span className="relative flex size-2">
                            <span className={cn("absolute inline-flex size-full rounded-full bg-emerald-400 opacity-60", running && "animate-ping")} />
                            <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
                        </span>
                        <span className="min-w-0 truncate text-sm font-medium text-stone-900 dark:text-stone-100">{activeSession?.title || t("chat.welcome.title")}</span>
                        <span className="hidden items-center gap-1 rounded border border-stone-200 px-1.5 py-px font-mono text-[10px] text-stone-400 sm:inline-flex dark:border-stone-700 dark:text-stone-500">
                            agent · {textModel ? modelLabelOf(textModel) : "-"}
                        </span>
                        <div className="ml-auto flex shrink-0 items-center gap-1.5">
                            <span className="hidden text-[11px] text-stone-400 md:inline dark:text-stone-500">{quotaHint}</span>
                            <Button size="small" icon={<Sparkles className="size-3.5" />} onClick={createAndClose}>
                                {t("chat.newSession")}
                            </Button>
                        </div>
                    </div>
                    <div ref={scrollRef} className="hover-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
                        <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-5">
                            {!activeSession || activeSession.messages.length === 0
                                ? welcome
                                : activeSession.messages.map((item, index) => (
                                      <ChatMessage key={item.id} message={item} onRetry={item.role === "error" ? () => retryMessage(index) : undefined} onUseReference={useReference} />
                                  ))}
                            {running && streamingText ? (
                                <div className="relative pl-6">
                                    <span className="absolute left-0 top-[7px] flex size-4 items-center justify-center">
                                        <span className="size-[7px] animate-pulse rounded-full bg-emerald-500" />
                                    </span>
                                    <div className="mb-1 flex items-center gap-2 text-[11px] text-stone-400 dark:text-stone-500">
                                        <span className="font-medium text-stone-500 dark:text-stone-400">Agent</span>
                                        <span>{t("chat.streaming")}</span>
                                    </div>
                                    <div className="agent-cursor">
                                        <Streamdown className="agent-streamdown text-sm leading-7 text-stone-800 dark:text-stone-200">{streamingText}</Streamdown>
                                    </div>
                                </div>
                            ) : null}
                            {runningTool && (runningTool.tool === "generate_image" || runningTool.tool === "edit_image") ? (
                                <GenerationWaiting call={runningTool} startedAt={turnStartedAt || Date.now()} />
                            ) : null}
                            {runningTool && runningTool.tool === "apply_prompt" ? (
                                <div className="flex items-center gap-2 pl-6 font-mono text-xs text-stone-400 dark:text-stone-500">
                                    <span className="inline-block size-2 animate-pulse rounded-full bg-amber-500" />
                                    apply_prompt · {t("chat.tools.names.apply_prompt")}
                                </div>
                            ) : null}
                            {running && !streamingText && !runningTool ? <ThinkingLine startedAt={turnStartedAt || Date.now()} /> : null}
                        </div>
                    </div>
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
                    />
                </section>
            </main>
            <Drawer open={listOpen} placement="left" width={280} onClose={() => setListOpen(false)} styles={{ body: { padding: 0 } }} title={t("chat.sessionList")}>
                {sessionList}
            </Drawer>
        </div>
    );
}
