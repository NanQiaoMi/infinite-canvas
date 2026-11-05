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
import type { AgentContextInput, AgentEvent, AgentImageRef, AgentMessage, AgentModelCall } from "@/lib/conversation-agent/types";
import { requestConversationTurn } from "@/services/api/image";
import { uploadImage } from "@/services/image-storage";
import { selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { useConversationAgentStore } from "@/stores/use-conversation-agent-store";
import { useQuotaStore } from "@/stores/use-quota-store";

import { ChatComposer } from "./components/chat-composer";
import { ChatMessage } from "./components/chat-message";
import { ChatSessionList } from "./components/chat-session-list";

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
            const text = (rawText ?? input).trim();
            if (!text) return;
            if (useConversationAgentStore.getState().running) return;
            let sessionId = useConversationAgentStore.getState().activeSessionId;
            if (!sessionId) sessionId = createSession();
            const attachments = references.length ? references : undefined;
            appendMessages(sessionId, [{ id: nanoid(), role: "user", text, attachments, createdAt: Date.now() }]);
            setReferences([]);
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

    return (
        <div className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden p-3 lg:grid-cols-[260px_minmax(0,1fr)]">
                <aside className="thin-scrollbar hidden min-h-0 flex-col overflow-hidden rounded-lg border border-stone-200 bg-card shadow-sm lg:flex dark:border-stone-800">{sessionList}</aside>
                <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-stone-200 bg-card shadow-sm dark:border-stone-800">
                    <div className="flex shrink-0 items-center gap-2 border-b border-stone-200 px-4 py-3 dark:border-stone-800">
                        <Button className="lg:!hidden" size="small" type="text" icon={<Menu className="size-4" />} onClick={() => setListOpen(true)} />
                        <div className="min-w-0">
                            <div className="flex items-center gap-2">
                                <MessagesSquare className="size-4 text-stone-400 dark:text-stone-500" />
                                <h1 className="text-base font-semibold text-stone-950 dark:text-stone-100">{t("chat.title")}</h1>
                            </div>
                            <p className="mt-0.5 hidden truncate text-xs text-stone-500 sm:block dark:text-stone-400">{t("chat.subtitle")}</p>
                        </div>
                        <div className="ml-auto flex shrink-0 items-center gap-1.5">
                            <Button size="small" icon={<Sparkles className="size-3.5" />} onClick={createAndClose}>
                                {t("chat.newSession")}
                            </Button>
                        </div>
                    </div>
                    <div ref={scrollRef} className="hover-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-5">
                        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
                            {!activeSession || activeSession.messages.length === 0 ? (
                                <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
                                    <div className="flex size-12 items-center justify-center rounded-lg border border-stone-200 bg-background dark:border-stone-800">
                                        <MessagesSquare className="size-5 text-stone-400 dark:text-stone-500" />
                                    </div>
                                    <div className="space-y-1">
                                        <div className="text-base font-semibold text-stone-900 dark:text-stone-100">{t("chat.emptyTitle")}</div>
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
                                    <ChatMessage key={item.id} message={item} onRetry={item.role === "error" ? () => retryMessage(index) : undefined} onUseReference={useReference} />
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
                                <div className="flex items-center gap-2 rounded-md bg-black/[.025] px-3 py-2 text-xs text-stone-500 dark:bg-white/[.05] dark:text-stone-400">
                                    <Spin size="small" />
                                    {runningTool.tool === "generate_image" ? t("chat.tools.names.generate_image") : runningTool.tool === "edit_image" ? t("chat.tools.names.edit_image") : runningTool.tool === "apply_prompt" ? t("chat.tools.names.apply_prompt") : runningTool.tool}
                                    {typeof runningTool.arguments.prompt === "string" ? <span className="truncate">：{runningTool.arguments.prompt}</span> : null}
                                </div>
                            ) : null}
                            {running && !streamingText && !runningTool ? (
                                <div className="flex items-center gap-2 text-xs text-stone-400 dark:text-stone-500">
                                    <Spin size="small" />
                                    {t("chat.thinking")}
                                </div>
                            ) : null}
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
