import { App, Button, Drawer, Spin } from "antd";
import { Menu, MessagesSquare, Sparkles } from "lucide-react";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Streamdown } from "streamdown";

import i18n from "@/i18n";
import { nativeToolCallsToAgent } from "@/lib/conversation-agent/protocol";
import { runAgentTurn } from "@/lib/conversation-agent/runtime";
import { agentLocaleOf } from "@/lib/conversation-agent/system-prompt";
import { AGENT_TOOLS, executeAgentTool } from "@/lib/conversation-agent/tools";
import type { AgentContextInput, AgentEvent, AgentMessage, AgentModelCall, AgentToolCall } from "@/lib/conversation-agent/types";
import { requestConversationTurn } from "@/services/api/image";
import { selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { useConversationAgentStore } from "@/stores/use-conversation-agent-store";
import { useQuotaStore } from "@/stores/use-quota-store";

import { ChatComposer } from "./components/chat-composer";
import { ChatMessage } from "./components/chat-message";
import { ChatSessionList } from "./components/chat-session-list";

const modelLabelOf = (option: string) => option.split("::").pop() || option;

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
    const [input, setInput] = useState("");
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

    const callModel: AgentModelCall = useCallback(async ({ systemPrompt, messages, tools, signal, onDelta }) => {
        const config = useConfigStore.getState().config;
        if (!config.textModel) throw new Error(t("chat.errors.noTextModel"));
        const turn = await requestConversationTurn(
            { ...config, model: config.textModel },
            messages.map((item) => ({ role: item.role, content: item.content })),
            { systemPrompt, tools: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })), onDelta, signal },
        );
        const native = nativeToolCallsToAgent(turn.toolCalls.map((call) => ({ name: call.name, arguments: call.arguments })));
        return { content: turn.content, toolCalls: native.calls, toolCallErrors: native.errors };
    }, [t]);

    const send = useCallback(
        async (rawText?: string) => {
            const text = (rawText ?? input).trim();
            if (!text) return;
            if (useConversationAgentStore.getState().running) return;
            let sessionId = useConversationAgentStore.getState().activeSessionId;
            if (!sessionId) sessionId = createSession();
            appendMessages(sessionId, [{ id: nanoid(), role: "user", text, createdAt: Date.now() }]);
            setInput("");
            setStreamingText("");
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
                        else if (event.type === "tool-start") setRunningTool(event.call);
                        else if (event.type === "tool-end") setRunningTool(null);
                    },
                    signal: controller.signal,
                });
                appendMessages(sessionId, result.messages);
                if (result.roundLimitReached) appendMessages(sessionId, [{ id: nanoid(), role: "error", text: t("chat.errors.tooManyRounds"), createdAt: Date.now() }]);
            } catch (error) {
                const aborted = controller.signal.aborted;
                const partial = useConversationAgentStore.getState().streamingText;
                if (aborted) {
                    if (partial.trim()) appendMessages(sessionId, [{ id: nanoid(), role: "assistant", text: partial, promptBlocks: [], createdAt: Date.now() }]);
                } else {
                    appendMessages(sessionId, [{ id: nanoid(), role: "error", text: error instanceof Error ? error.message : String(error), createdAt: Date.now() }]);
                }
            } finally {
                controllerRef.current = null;
                setRunning(false);
                setStreamingText("");
                setRunningTool(null);
                useQuotaStore.getState().scheduleRefresh();
            }
        },
        [appendMessages, buildContext, callModel, createSession, input, setRunning, setRunningTool, setStreamingText, t],
    );

    const stop = () => {
        controllerRef.current?.abort();
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

    return (
        <div className="flex h-full min-h-0 bg-background text-foreground">
            <div className="hidden md:flex">{sessionList}</div>
            <Drawer open={listOpen} placement="left" width={260} onClose={() => setListOpen(false)} styles={{ body: { padding: 0 } }}>
                {sessionList}
            </Drawer>
            <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex h-12 shrink-0 items-center gap-2 border-b border-stone-200 px-4 dark:border-stone-800">
                    <Button className="md:hidden" size="small" type="text" icon={<Menu className="size-4" />} onClick={() => setListOpen(true)} />
                    <MessagesSquare className="size-4 text-stone-500" />
                    <span className="text-sm font-medium">{t("chat.title")}</span>
                    <span className="hidden truncate text-xs text-stone-400 sm:inline">{t("chat.subtitle")}</span>
                    <div className="ml-auto flex items-center gap-2">
                        <span className="hidden text-xs text-stone-400 sm:inline">{t("chat.internalOnly")}</span>
                        <Button size="small" icon={<Sparkles className="size-3.5" />} onClick={createAndClose}>
                            {t("chat.newSession")}
                        </Button>
                    </div>
                </div>
                <div ref={scrollRef} className="hover-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-5">
                    <div className="mx-auto flex max-w-3xl flex-col gap-4">
                        {!activeSession || activeSession.messages.length === 0 ? (
                            <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
                                <div className="rounded-2xl bg-stone-100 p-3 dark:bg-stone-800">
                                    <MessagesSquare className="size-6 text-stone-500" />
                                </div>
                                <div className="space-y-1">
                                    <div className="text-base font-medium">{t("chat.emptyTitle")}</div>
                                    <div className="text-sm text-stone-500 dark:text-stone-400">{t("chat.emptyHint")}</div>
                                </div>
                                <div className="flex flex-wrap justify-center gap-2">
                                    {[
                                        { key: "write", text: t("chat.example.write") },
                                        { key: "optimize", text: t("chat.example.optimize") },
                                        { key: "generate", text: t("chat.example.generate") },
                                    ].map((item) => (
                                        <Button key={item.key} size="small" onClick={() => setInput(item.text)}>
                                            {item.text}
                                        </Button>
                                    ))}
                                </div>
                            </div>
                        ) : (
                            activeSession.messages.map((item, index) => (
                                <ChatMessage key={item.id} message={item} onRetry={item.role === "error" ? () => retryMessage(index) : undefined} />
                            ))
                        )}
                        {running && streamingText ? (
                            <div className="flex justify-start">
                                <div className="w-full min-w-0">
                                    <Streamdown className="agent-streamdown text-sm leading-7">{streamingText}</Streamdown>
                                </div>
                            </div>
                        ) : null}
                        {runningTool ? (
                            <div className="flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                                <Spin size="small" />
                                {runningTool.tool === "generate_image" ? t("chat.tools.names.generate_image") : runningTool.tool === "apply_prompt" ? t("chat.tools.names.apply_prompt") : runningTool.tool}
                                {typeof runningTool.arguments.prompt === "string" ? <span className="truncate">：{runningTool.arguments.prompt}</span> : null}
                            </div>
                        ) : null}
                        {running && !streamingText && !runningTool ? (
                            <div className="flex items-center gap-2 text-xs text-stone-400">
                                <Spin size="small" />
                                {t("chat.thinking")}
                            </div>
                        ) : null}
                    </div>
                </div>
                <ChatComposer value={input} onChange={setInput} onSend={() => void send()} onStop={stop} running={running} modelLabel={textModel ? modelLabelOf(textModel) : ""} />
            </div>
        </div>
    );
}
