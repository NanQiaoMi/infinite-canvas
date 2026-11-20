import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { App, Button, Dropdown, Tooltip } from "antd";
import { Bot, ChevronDown, History, MessageSquare, PanelRightClose, PlugZap, Plus, Sparkles, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { readAgentUrlBootstrap } from "@/lib/agent/agent-url-bootstrap";
import { canvasThemes } from "@/lib/canvas-theme";
import { upscaleDataUrl } from "@/lib/canvas/canvas-image-data";
import { resolveCanvasReferenceImages } from "@/lib/canvas/canvas-resource-references";
import { readImageMeta } from "@/lib/image-utils";
import { randomId } from "@/lib/utils";
import { useThemeStore } from "@/stores/use-theme-store";
import { useAgentSkillStore } from "@/stores/use-agent-skill-store";
import { useShallow } from "zustand/react/shallow";
import { isAgentUrl, useAgentStore, type AgentAttachment, type AgentCanvasContext, type AgentCanvasReference, type AgentChatItem, type AgentConversationState, type AgentModel, type AgentPendingApproval, type AgentPendingToolCall, type AgentPermissionMode, type AgentReasoningEffort, type AgentRuntimeName } from "@/stores/use-agent-store";
import { isAgentThreadEvent as isCurrentThreadToolCall } from "@/lib/agent/agent-event-formatters";
import { activateAgentClient, AgentApiError, agentPath, discoverAgentConfig, fetchAgentJson, interruptCodexTurn, postCodexApproval, postState, resetAgentThread } from "@/services/api/canvas-agent";
import { AgentChatTimeline, AgentTaskProgress, AgentUsageBar } from "./agent-chat";
import { AgentChatComposer } from "./agent-chat-composer";
import { AgentConnectView } from "./agent-connect-view";
import {
    agentAttachmentToChatAttachment,
    attachmentPayloadBytes,
    compactText,
    formatBytes,
    bindPendingTurnMessages,
    isConnectionErrorMessage,
    isCurrentThreadEvent,
    parseEventData,
    promptWithAttachments,
    promptWithCanvasReferences,
    registerLiveAgentTurn,
    scopeChatItem,
    upsertAgentMessage,
    type AgentEventPayload,
} from "./agent-event-formatters";
import { AgentHistoryView } from "./agent-history-view";
import { AgentLogView } from "./agent-log-view";
import { AgentPanelTabs } from "./agent-panel-tabs";
import { AgentSkillsView } from "./agent-skills-view";
import { agentErrorState, connectionColor, createId, readDataUrl, rt } from "./agent-panel-utils";
import { useAgentEvents } from "./use-agent-events";
import { syncRuntime, useAgentThreads, type AgentWorkspaceEvent } from "./use-agent-threads";
import { useAgentToolCalls } from "./use-agent-tool-calls";

const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_PAYLOAD_BYTES = 28 * 1024 * 1024;
const MESSAGE_PREVIEW_LONG_EDGE = 192;
const MESSAGE_PREVIEW_MAX_LENGTH = 500_000;
const DEFAULT_AGENT_URL = "http://127.0.0.1:17371";
const AGENT_PROTOCOL_VERSION = 7;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const AGENT_REASONING_EFFORTS = new Set<AgentReasoningEffort>(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

type AgentTurnResponse = { ok?: boolean; threadId?: string };
type AgentModelsResponse = { ok?: boolean; data?: AgentModel[] };
type AgentCodexState = { busy?: boolean; threadId?: string; turnId?: string };
type AgentHelloEvent = { ok?: boolean; protocolVersion?: number; clientId?: string; workspace?: { activeThreadId?: string; runtime?: AgentRuntimeName }; conversation?: AgentConversationState; codex?: AgentCodexState; pendingApprovals?: AgentPendingApproval[] };
type AgentChatEvent = { threadId?: string; turnId?: string; sourceClientId?: string; replayed?: boolean; message?: AgentChatItem };
type AgentBootstrapEvent = { type?: "codex.preparing" | "codex.prepare_failed" | "mcp.startup" | "mcp.complete"; phase?: "preheat" | "runtime"; threadId?: string; name?: string; status?: "starting" | "ready" | "failed" | "cancelled"; error?: string | null; failureReason?: string | null };
type AgentClientGlobal = typeof globalThis & { __infiniteCanvasAgentClientIdPromise?: Promise<string> };

export function LocalAgentPanel({ embedded, headless, autoConnect }: { embedded?: boolean; headless?: boolean; autoConnect?: boolean }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { message, modal } = App.useApp();
    const { hash } = useLocation();
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    // Field-level selectors with useShallow rerender only when these fields change.
    // canvasContext is intentionally excluded because project updates it every frame during dragging and resizing.
    // The panel uses it only for ref synchronization and debounced postState calls, never during rendering.
    // Subscribing here would rerender the panel every frame and amplify the #185 crash, so it is observed imperatively below.
    const { width, url, token, connected, enabled, prompt, attachments, sending, waiting, tokenUsage, eventLogs, threads, threadsNextCursor, pinnedThreadIds, threadSearch, activeThreadId, workspacePath, loadingThreads, activeTab, confirmTools, runtime, permissionMode, models, model, reasoningEffort, activity, conversation, connectError, reconnectAttempt, pendingTool, pendingApprovals } = useAgentStore(
        useShallow((state) => ({
            width: state.width,
            url: state.url,
            token: state.token,
            connected: state.connected,
            enabled: state.enabled,
            prompt: state.prompt,
            attachments: state.attachments,
            sending: state.sending,
            waiting: state.waiting,
            tokenUsage: state.tokenUsage,
            eventLogs: state.eventLogs,
            threads: state.threads,
            threadsNextCursor: state.threadsNextCursor,
            pinnedThreadIds: state.pinnedThreadIds,
            threadSearch: state.threadSearch,
            activeThreadId: state.activeThreadId,
            workspacePath: state.workspacePath,
            loadingThreads: state.loadingThreads,
            activeTab: state.activeTab,
            confirmTools: state.confirmTools,
            runtime: state.runtime,
            permissionMode: state.permissionMode,
            models: state.models,
            model: state.model,
            reasoningEffort: state.reasoningEffort,
            activity: state.activity,
            conversation: state.conversation,
            connectError: state.connectError,
            reconnectAttempt: state.reconnectAttempt,
            pendingTool: state.pendingTool,
            pendingApprovals: state.pendingApprovals,
        })),
    );
    const setAgentState = useAgentStore((state) => state.setAgentState);
    const conversationReady = conversation.status === "ready" || conversation.status === "warning";
    const conversationBusy = conversation.status === "preparing" || conversation.status === "running";
    const closePanel = useAgentStore((state) => state.closePanel);
    const clearEventLogs = useAgentStore((state) => state.clearEventLogs);
    const loadSkills = useAgentSkillStore((state) => state.loadSkills);
    const clearSkillSelection = useAgentSkillStore((state) => state.clearSelection);
    const skillCount = useAgentSkillStore((state) => state.skills.length);
    const messageCount = useAgentStore((state) => state.messages.length);
    const canvasContextRef = useRef<AgentCanvasContext | null>(useAgentStore.getState().canvasContext);
    const confirmToolsRef = useRef(confirmTools);
    const pendingToolRef = useRef<AgentPendingToolCall | null>(null);
    const autoConnectRef = useRef(false);
    const connectedRef = useRef(false);
    const errorLoggedRef = useRef(false);
    const attachmentUrlsRef = useRef(new Set<string>());
    const clientIdRef = useRef("");
    const [clientReady, setClientReady] = useState(false);
    const [reconnectNonce, setReconnectNonce] = useState(0);
    const reconnectAttemptRef = useRef(0);
    const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const reconnectNow = () => {
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
        setReconnectNonce((nonce) => nonce + 1);
    };
    const liveTurnKeysRef = useRef(new Set<string>());
    const endpoint = useMemo(() => url.trim().replace(/\/$/, ""), [url]);
    const { addMessage, addEventLog, showAgentError, handleAgentEvent } = useAgentEvents({ endpoint, clientIdRef, canvasContextRef, liveTurnKeysRef });
    const { loadThreadsSequenceRef, threadMessagesRef, authoritativeHistoryTurnsRef, threadOperationRef, applyConversationState, applyWorkspaceChange, loadThreads, loadMoreThreads, searchThreads, switchRuntime, startNewThread, resumeThread, confirmDeleteThreads, renameThread, togglePinThread } = useAgentThreads({ endpoint, clientIdRef, connectedRef, pendingToolRef, liveTurnKeysRef, addEventLog });
    const urlAgentAutoConnect = searchParams.has("agentUrl") && searchParams.has("agentToken");
    useEffect(() => {
        let disposed = false;
        void acquireAgentClientId().then((clientId) => {
            if (!disposed) {
                clientIdRef.current = clientId;
                setClientReady(true);
            }
        });
        return () => { disposed = true; };
    }, []);
    // Imperatively subscribe to canvasContext to keep the ref current and debounce snapshot reports without rerendering the panel.
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const unsubscribe = useAgentStore.subscribe((state) => {
            if (state.canvasContext === canvasContextRef.current) return;
            canvasContextRef.current = state.canvasContext;
            if (!useAgentStore.getState().connected) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => void postState(endpoint, token, clientIdRef.current, canvasContextRef.current?.snapshot || null), 300);
        });
        return () => {
            unsubscribe();
            if (timer) clearTimeout(timer);
        };
    }, [endpoint, token]);
    useEffect(() => {
        confirmToolsRef.current = confirmTools;
    }, [confirmTools]);
    useEffect(() => {
        pendingToolRef.current = pendingTool;
    }, [pendingTool]);
    useEffect(() => () => attachmentUrlsRef.current.forEach((url) => URL.revokeObjectURL(url)), []);

    useEffect(() => {
        if (!clientReady || !enabled || !token.trim()) {
            reconnectAttemptRef.current = 0;
            return;
        }
        localStorage.setItem("canvas-agent-url", endpoint);
        localStorage.setItem("canvas-agent-token", token);
        const clientId = clientIdRef.current;
        let disposed = false;
        let protocolRejected = false;
        let eventQueue = Promise.resolve();
        const isCurrentConnection = () => !disposed && clientIdRef.current === clientId;
        const enqueueEvent = (task: () => void | Promise<void>) => {
            eventQueue = eventQueue.then(async () => {
                if (isCurrentConnection()) await task();
            }).catch((error) => {
                if (isCurrentConnection()) addEventLog(rt("conversationSyncFailed"), error);
            });
        };
        const source = new EventSource(`${endpoint}/events?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`);
        source.addEventListener("hello", (event) => {
            if (!isCurrentConnection()) return;
            const hello = parseEventData<AgentHelloEvent>(event);
            if (hello?.protocolVersion !== AGENT_PROTOCOL_VERSION) {
                const text = rt("agentOutdated");
                protocolRejected = true;
                source.close();
                connectedRef.current = false;
                setAgentState({ enabled: false, connected: false, waiting: false, sending: false, activity: rt("restartRequired"), connectError: text, reconnectAttempt: 0, silentConnect: false, fragmentBootstrap: false, pendingTool: null, pendingApprovals: [] });
                useAgentSkillStore.getState().reset();
                addEventLog(rt("versionMismatch"), text, hello);
                if (!headless) message.error(text);
                return;
            }
            if (hello?.workspace?.runtime) syncRuntime(hello.workspace.runtime);
            const codex = hello?.codex;
            const busy = Boolean(codex?.busy);
            const nextThreadId = hello?.conversation?.threadId ?? hello?.workspace?.activeThreadId ?? useAgentStore.getState().activeThreadId;
            if (hello?.conversation) applyConversationState(hello.conversation, true);
            else applyWorkspaceChange({ activeThreadId: nextThreadId });
            const current = useAgentStore.getState();
            const nextTurnId = codex?.threadId === nextThreadId ? codex.turnId ?? "" : "";
            if (nextTurnId) liveTurnKeysRef.current.add(`${nextThreadId}\0${nextTurnId}`);
            const activeTurnId = busy ? nextTurnId : "";
            const pendingApprovals = busy ? (hello?.pendingApprovals || []).filter((item) => !item.threadId || item.threadId === nextThreadId) : [];
            const messages = activeTurnId
                ? bindPendingTurnMessages(current.messages.filter((item) => !isConnectionErrorMessage(item)), nextThreadId, activeTurnId)
                : current.messages.filter((item) => !isConnectionErrorMessage(item));
            errorLoggedRef.current = false;
            connectedRef.current = true;
            reconnectAttemptRef.current = 0;
            setAgentState({
                connected: true,
                reconnectAttempt: 0,
                activity: pendingApprovals.length ? rt("awaitingApproval") : busy ? rt("codexRunning") : rt("connected"),
                waiting: busy,
                sending: false,
                connectError: "",
                silentConnect: false,
                fragmentBootstrap: false,
                activeThreadId: nextThreadId,
                activeTurnId,
                messages,
                pendingApprovals,
            });
            if (!headless) message.success(rt("localAgentConnected"));
            void postState(endpoint, token, clientId, canvasContextRef.current?.snapshot || null);
            if (document.visibilityState === "visible" && document.hasFocus()) void activateAgentClient(endpoint, token, clientId);
            if (!busy && !nextThreadId && (!hello?.conversation || hello.conversation.status === "idle")) {
                void resetAgentThread(endpoint, token, clientId, permissionMode)
                    .then((result) => result.conversation && applyConversationState(result.conversation))
                    .catch((error) => {
                        const state = agentErrorState(error);
                        if (state) applyConversationState(state);
                        addEventLog(rt("conversationInitFailed"), error);
                    });
            }
        });
        source.addEventListener("codex_state", (event) => {
            const data = parseEventData<AgentCodexState>(event);
            if (!data) return;
            enqueueEvent(async () => {
                const busy = Boolean(data.busy);
                const current = useAgentStore.getState();
                const appliesToCurrentThread = !data.threadId || data.threadId === current.activeThreadId;
                if (!appliesToCurrentThread) return;
                const turnId = data.turnId || current.activeTurnId;
                if (turnId) liveTurnKeysRef.current.add(`${current.activeThreadId}\0${turnId}`);
                const activeTurnId = busy ? turnId : "";
                const messages = activeTurnId ? bindPendingTurnMessages(current.messages, current.activeThreadId, activeTurnId) : current.messages;
                setAgentState({
                    activity: busy ? rt("codexRunning") : current.activity === rt("processingFailed") ? rt("processingFailed") : rt("completed"),
                    waiting: busy,
                    sending: false,
                    activeTurnId,
                    messages,
                });
                if (!busy && current.waiting) void loadThreads(false, turnId);
            });
        });
        source.addEventListener("tool_call", (event) => {
            if (!isCurrentConnection()) return;
            const data = parseEventData<AgentPendingToolCall>(event);
            if (!data) return;
            // 画布/站点工具只允许在发起该 tool_call 的对话里执行：切到其它对话后到达的旧调用直接丢弃并记录诊断；
            // 老版本服务端不发送 threadId/turnId 时按兼容策略放行。
            const current = useAgentStore.getState();
            if (!isCurrentThreadToolCall(data, { threadId: current.activeThreadId, turnId: current.activeTurnId })) {
                addEventLog(rt("log"), `已丢弃非当前线程的工具调用：${data.name}`, data);
                return;
            }
            void handleToolCall(endpoint, token, data);
        });
        source.addEventListener("codex_approval", (event) => {
            if (!isCurrentConnection()) return;
            const data = parseEventData<AgentPendingApproval>(event);
            if (!data || !isCurrentThreadEvent(data)) return;
            setAgentState({ pendingApprovals: [...useAgentStore.getState().pendingApprovals.filter((item) => item.requestId !== data.requestId), data], activity: rt("awaitingApproval") });
            addEventLog(rt("awaitingApproval"), data.reason || data.method, data);
        });
        source.addEventListener("codex_approval_resolved", (event) => {
            if (!isCurrentConnection()) return;
            const data = parseEventData<{ requestId?: string; decision?: "accept" | "acceptForSession" | "decline" | "cancel" }>(event);
            if (!data?.requestId) return;
            const current = useAgentStore.getState();
            const approval = current.pendingApprovals.find((item) => item.requestId === data.requestId);
            const pendingApprovals = current.pendingApprovals.filter((item) => item.requestId !== data.requestId);
            setAgentState({ pendingApprovals, activity: approvalActivity(pendingApprovals, current.waiting, current.activity) });
            const decision = data.decision || approval?.deciding;
            if (approval && decision) addEventLog(rt(decision === "accept" || decision === "acceptForSession" ? "approvalGranted" : "approvalCanceled"), approval.reason || approval.method, approval);
        });
        source.addEventListener("agent_event", (event) => {
            const data = parseEventData<AgentEventPayload>(event);
            if (data) enqueueEvent(() => {
                if (!isCurrentThreadEvent(data)) return;
                const shouldProcess = registerLiveAgentTurn(data, authoritativeHistoryTurnsRef.current, liveTurnKeysRef.current);
                if (data.type !== "usage.updated" && !shouldProcess) return;
                return handleAgentEvent(data);
            });
        });
        source.addEventListener("agent_bootstrap", (event) => {
            const data = parseEventData<AgentBootstrapEvent>(event);
            if (!data?.type) return;
            if (data.type === "codex.preparing") {
                addEventLog(rt("conversationInitializing"), rt("conversationCreating"), data);
                return;
            }
            if (data.type === "codex.prepare_failed") {
                addEventLog(rt("conversationInitFailed"), data.error, data);
                return;
            }
            if (data.type === "mcp.complete") {
                addEventLog(rt("mcpStatusComplete"), rt("mcpListRead"), data);
                return;
            }
            if (!data.name || !data.status) return;
            const label = data.name;
            const status = data.status === "starting"
                ? { text: rt("mcpStarting", { name: label }), detail: rt("mcpConnecting"), status: "running" as const }
                : data.status === "ready"
                    ? { text: rt("mcpReadyNamed", { name: label }), detail: rt("toolsReady"), status: "ready" as const }
                    : data.status === "failed"
                        ? { text: rt("mcpFailedNamed", { name: label }), detail: data.error || rt("toolInitFailed"), status: "error" as const }
                        : { text: rt("mcpCanceledNamed", { name: label }), detail: rt("toolInitCanceled"), status: "error" as const };
            addEventLog(status.text, status.detail, data);
        });
        source.addEventListener("conversation_changed", (event) => {
            const data = parseEventData<AgentConversationState>(event);
            if (data) enqueueEvent(() => { applyConversationState(data); });
        });
        source.addEventListener("workspace_changed", (event) => {
            const data = parseEventData<AgentWorkspaceEvent>(event);
            if (!data) return;
            enqueueEvent(() => {
                if (data.runtime) syncRuntime(data.runtime);
                if (data.conversation) applyConversationState(data.conversation);
                else applyWorkspaceChange(data);
                if (!data.draftThread) void loadThreads(Boolean(data.emptyThread));
            });
        });
        source.addEventListener("chat_message", (event) => {
            const data = parseEventData<AgentChatEvent>(event);
            if (!data?.message) return;
            enqueueEvent(() => {
                if (!isCurrentThreadEvent(data)) return;
                if (!registerLiveAgentTurn(data, authoritativeHistoryTurnsRef.current, liveTurnKeysRef.current)) return;
                const current = useAgentStore.getState();
                const threadId = data.threadId || data.message!.threadId || current.activeThreadId;
                const turnId = data.turnId ?? data.message!.turnId ?? "";
                const clientMessageId = data.message!.clientMessageId || data.message!.itemId || data.message!.id;
                if (current.activeThreadId !== threadId) return;
                const next = scopeChatItem(data.message!, threadId, turnId);
                const currentMessages = data.message!.role === "user" && clientMessageId
                    ? current.messages.filter((item) => item.role !== "user" || item.clientMessageId !== clientMessageId || item.id === next.id)
                    : current.messages;
                const messages = upsertAgentMessage(currentMessages, next);
                setAgentState({ messages });
            });
        });
        source.addEventListener("agent_log", (event) => {
            if (!isCurrentConnection()) return;
            const text = parseEventData<{ text?: unknown }>(event)?.text;
            addEventLog(rt("log"), text, text);
        });
        source.addEventListener("skills_changed", (event) => {
            if (!isCurrentConnection()) return;
            const data = parseEventData<{ forceReload?: boolean }>(event);
            void loadSkills(endpoint, token, Boolean(data?.forceReload));
        });
        source.addEventListener("agent_error", (event) => {
            const data = parseEventData<AgentEventPayload>(event);
            if (!data) return;
            enqueueEvent(() => {
                if (!isCurrentThreadEvent(data)) return;
                if (!registerLiveAgentTurn(data, authoritativeHistoryTurnsRef.current, liveTurnKeysRef.current)) return;
                showAgentError(data.message, data, !data.replayed);
            });
        });
        source.onerror = () => {
            if (disposed || protocolRejected) return;
            // 已连接过（或正在重连）的断开才自动重连；首次连接失败保持原行为。
            const reconnecting = reconnectAttemptRef.current > 0;
            const wasConnected = connectedRef.current || reconnecting;
            const silent = useAgentStore.getState().silentConnect && !wasConnected;
            const text = rt(wasConnected ? "connectionLostDescription" : "connectionFailedDescription");
            if (!reconnecting && (!errorLoggedRef.current || wasConnected)) {
                addEventLog(rt(wasConnected ? "connectionLost" : "connectionFailed"), text);
                if (!headless && !silent) message.error(text);
            }
            errorLoggedRef.current = true;
            connectedRef.current = false;
            pendingToolRef.current = null;
            useAgentSkillStore.getState().reset();
            if (wasConnected) {
                source.close();
                const attempt = ++reconnectAttemptRef.current;
                const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length) - 1];
                setAgentState({
                    activity: rt("reconnecting", { attempt, seconds: delay / 1000 }),
                    connected: false,
                    waiting: false,
                    sending: false,
                    silentConnect: false,
                    fragmentBootstrap: false,
                    pendingTool: null,
                    pendingApprovals: [],
                    reconnectAttempt: attempt,
                });
                reconnectTimerRef.current = setTimeout(() => {
                    reconnectTimerRef.current = null;
                    setReconnectNonce((nonce) => nonce + 1);
                }, delay);
                return;
            }
            setAgentState({
                activity: rt("connectionFailed"),
                connected: false,
                waiting: false,
                sending: false,
                connectError: silent ? "" : text,
                silentConnect: false,
                fragmentBootstrap: false,
                pendingTool: null,
                pendingApprovals: [],
            });
            source.close();
            setAgentState({ enabled: false });
        };
        return () => {
            disposed = true;
            source.close();
            if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
            connectedRef.current = false;
            loadThreadsSequenceRef.current += 1;
            useAgentSkillStore.getState().reset();
        };
    }, [applyConversationState, applyWorkspaceChange, clientReady, enabled, endpoint, loadSkills, loadThreads, message, reconnectNonce, setAgentState, token]);

    useEffect(() => {
        if (connected) void loadThreads();
    }, [connected, loadThreads]);

    useEffect(() => {
        if (connected) void loadSkills(endpoint, token);
    }, [connected, endpoint, loadSkills, runtime, token]);

    useEffect(() => {
        if (!connected) return;
        void fetchAgentJson<AgentModelsResponse>(endpoint, token, agentPath("/models")).then(({ data = [] }) => {
            const names = new Set<string>();
            const models = data.flatMap((item) => {
                const name = item.displayName || item.model;
                const efforts = item.supportedReasoningEfforts.filter(({ reasoningEffort }) => AGENT_REASONING_EFFORTS.has(reasoningEffort));
                if (item.model === "codex-auto-review" || names.has(name)) return [];
                names.add(name);
                const defaultReasoningEffort = !efforts.length ? "" : efforts.some((effort) => effort.reasoningEffort === item.defaultReasoningEffort) ? item.defaultReasoningEffort : efforts[0].reasoningEffort;
                return [{ ...item, supportedReasoningEfforts: efforts, defaultReasoningEffort }];
            });
            if (!models.length) return;
            const savedModel = localStorage.getItem(`canvas-agent-model:${runtime}`) || "";
            const current = models.find((item) => item.model === savedModel) || models.find((item) => item.isDefault) || models[0];
            const savedEffort = localStorage.getItem(`canvas-agent-reasoning-effort:${runtime}`) || "";
            const efforts = current.supportedReasoningEfforts.map((item) => item.reasoningEffort);
            const nextEffort: AgentReasoningEffort | "" = efforts.includes(savedEffort as AgentReasoningEffort) ? savedEffort as AgentReasoningEffort : current.defaultReasoningEffort || efforts[0] || "";
            localStorage.setItem(`canvas-agent-model:${runtime}`, current.model);
            localStorage.setItem(`canvas-agent-reasoning-effort:${runtime}`, nextEffort);
            setAgentState({ models, model: current.model, reasoningEffort: nextEffort });
        }).catch((error) => addEventLog(rt("modelListFailed"), error));
    }, [connected, endpoint, runtime, setAgentState, token]);

    useEffect(() => {
        if (!connected) return;
        const activate = () => void activateAgentClient(endpoint, token, clientIdRef.current);
        const activateVisible = () => {
            if (document.visibilityState === "visible") activate();
        };
        window.addEventListener("focus", activate);
        document.addEventListener("visibilitychange", activateVisible);
        return () => {
            window.removeEventListener("focus", activate);
            document.removeEventListener("visibilitychange", activateVisible);
        };
    }, [connected, endpoint, token]);
    // resendText 为重新生成时传入的历史用户消息文本：只重发文本，不复用当前输入框的附件、画布引用和 Skill，也不清空输入框草稿。
    const sendPrompt = async (resendText?: string) => {
        const resend = resendText !== undefined;
        const text = (resend ? resendText : prompt).trim();
        const files = resend ? [] : attachments;
        const skillState = useAgentSkillStore.getState();
        const selectedSkill = resend ? undefined : skillState.selectedSkill;
        const selectedSkillRevision = skillState.selectionRevision;
        const currentState = useAgentStore.getState();
        const canvasNodeIds = new Set(currentState.canvasContext?.snapshot.nodes.map((node) => node.id) || []);
        const canvasReferences = resend ? [] : currentState.canvasReferences.filter((item) => canvasNodeIds.has(item.nodeId));
        if (!resend && canvasReferences.length !== currentState.canvasReferences.length) {
            setAgentState({ canvasReferences });
            message.warning(rt(canvasReferences.length ? "someCanvasReferencesMissing" : "canvasReferencesMissing"));
        }
        const requestPrompt = promptWithCanvasReferences(promptWithAttachments(text, files), canvasReferences);
        const blockedReason = !currentState.connected ? "sendBlockedOffline" : currentState.sending || currentState.waiting ? "sendBlockedBusy" : currentState.loadingThreads || !["ready", "warning"].includes(currentState.conversation.status) ? "sendBlockedPreparing" : "";
        if (!requestPrompt) return;
        if (blockedReason) {
            message.info(rt(blockedReason));
            return;
        }
        let referenceImages: AgentAttachment[] = [];
        if (canvasReferences.some((item) => item.kind === "image")) {
            setAgentState({ sending: true, activity: rt("readingCanvasImages") });
            try {
                referenceImages = await resolveCanvasReferenceImages(canvasReferences, currentState.canvasContext?.snapshot.nodes || []);
            } catch (error) {
                setAgentState({ sending: false, activity: rt("canvasImageReadFailed") });
                addMessage({ role: "error", title: rt("canvasImageReadFailed"), text: error instanceof Error ? error.message : rt("canvasImageReadFailed") });
                return;
            }
        }
        const requestFiles = [...files, ...referenceImages.filter((reference) => !files.some((file) => file.dataUrl === reference.dataUrl))];
        if (requestFiles.length > MAX_ATTACHMENTS) {
            setAgentState({ sending: false, activity: rt("tooManyImages") });
            addMessage({ role: "error", title: rt("tooManyImages"), text: rt("imageCountLimit", { count: MAX_ATTACHMENTS }) });
            return;
        }
        if (attachmentPayloadBytes(requestFiles) > MAX_ATTACHMENT_PAYLOAD_BYTES) {
            setAgentState({ sending: false, activity: rt("imageTooLarge") });
            addMessage({ role: "error", title: rt("imageTooLarge"), text: rt("imagePayloadTooLarge") });
            return;
        }
        const messageId = createId();
        const userText = text || rt(files.length ? "imagesSent" : "canvasReferencesSent", { count: files.length || canvasReferences.length });
        const messageReferences: AgentCanvasReference[] = await Promise.all(canvasReferences.map(async ({ nodeId, label, title, kind, previewUrl, text }) => {
            const image = referenceImages.find((item) => item.id === `canvas:${nodeId}`);
            return { nodeId, label, title, kind, previewUrl: image ? (await createMessageAttachmentMetadata(image)).url : previewUrl, text };
        }));
        const messageSkill = selectedSkill ? { name: selectedSkill.name, path: selectedSkill.path, displayName: selectedSkill.interface?.displayName || undefined } : undefined;
        loadThreadsSequenceRef.current += 1;
        const currentBeforeSend = useAgentStore.getState();
        const requestThreadId = currentBeforeSend.activeThreadId;
        setAgentState({ ...(resend ? {} : { prompt: "", attachments: [], canvasReferences: [] }), activity: rt("sending"), sending: true, loadingThreads: false, activeTurnId: "", messages: currentBeforeSend.messages });
        addMessage({ id: messageId, itemId: "synthetic:user", clientMessageId: messageId, threadId: requestThreadId, turnId: "", role: "user", text: userText, attachments: files, canvasReferences: messageReferences, skill: messageSkill });
        let threadId = requestThreadId;
        try {
            const messageAttachments = await Promise.all(files.map(createMessageAttachmentMetadata));
            const messageMetadata = {
                ...(messageAttachments.length ? { attachments: messageAttachments } : {}),
                ...(messageReferences.length ? { canvasReferences: messageReferences } : {}),
                ...(messageSkill ? { skill: messageSkill } : {}),
            };
            const modelName = models.find((item) => item.model === model)?.displayName || model || rt("defaultModel");
            const effortName = reasoningEffort ? i18n.t(`agent.composer.effort.${reasoningEffort}`) : rt("defaultEffort");
            addEventLog(rt("sendTask"), `${modelName} · ${effortName}${selectedSkill ? ` · Skill ${selectedSkill.name}` : ""}${files.length ? ` · ${rt("attachmentCount", { count: files.length })}` : ""}${canvasReferences.length ? ` · ${rt("canvasReferenceCount", { count: canvasReferences.length })}` : ""} · ${compactText(text) || rt(canvasReferences.length ? "canvasReferencesOnly" : "attachmentsOnly")}`);
            const accepted = await fetchAgentJson<AgentTurnResponse>(endpoint, token, agentPath("/turn"), {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    prompt: requestPrompt,
                    messageText: userText,
                    messageId,
                    clientId: clientIdRef.current,
                    threadId,
                    conversationId: currentBeforeSend.conversation.conversationId,
                    expectedRevision: currentBeforeSend.conversation.revision,
                    permissionMode,
                    model,
                    ...(reasoningEffort ? { effort: reasoningEffort } : {}),
                    skill: selectedSkill ? { name: selectedSkill.name, path: selectedSkill.path } : undefined,
                    attachments: requestFiles.map(({ id, name, type, size, width, height, dataUrl }) => ({ id, name, type, size, width, height, dataUrl })),
                    messageMetadata,
                }),
            });
            threadId = accepted.threadId || threadId;
            if (!threadId) throw new Error(rt("startConversationFailed"));
            if (selectedSkill) clearSkillSelection(selectedSkillRevision);
            files.forEach((item) => {
                URL.revokeObjectURL(item.url);
                attachmentUrlsRef.current.delete(item.url);
            });
        } catch (error) {
            const text = error instanceof Error ? error.message : rt("sendFailed");
            const response = error instanceof AgentApiError ? error.response as { code?: string; state?: AgentConversationState } : undefined;
            if (response?.state) applyConversationState(response.state);
            const stale = response?.code === "CONVERSATION_STALE";
            const busy = response?.code === "CONVERSATION_BUSY";
            const state = useAgentStore.getState();
            const removeFailedPending = (messages: AgentChatItem[]) => messages.filter((item) => item.clientMessageId !== messageId || Boolean(item.turnId));
            threadMessagesRef.current.forEach((messages, cachedThreadId) => {
                const next = removeFailedPending(messages);
                if (next.length !== messages.length) threadMessagesRef.current.set(cachedThreadId, next);
            });
            const ownsCurrentThread = state.activeThreadId === (threadId || requestThreadId);
            const restoreDraft = resend || state.prompt || state.attachments.length || state.canvasReferences.length ? {} : { prompt, attachments: files, canvasReferences };
            if (ownsCurrentThread) {
                setAgentState({
                    activity: rt(stale ? "conversationSynced" : busy ? "codexRunning" : "sendFailed"),
                    sending: false,
                    messages: removeFailedPending(state.messages),
                    ...restoreDraft,
                });
                addMessage({ threadId: state.activeThreadId, turnId: "", role: "error", title: rt(stale ? "conversationSynced" : busy ? "taskStillRunning" : "sendFailed"), text });
            } else {
                setAgentState({ sending: false, messages: removeFailedPending(state.messages), ...restoreDraft });
            }
            addEventLog(rt("sendFailed"), error);
        }
    };

    const stopTurn = async () => {
        if (!connected || (!sending && !waiting)) return;
        setAgentState({ activity: rt("stopping") });
        try {
            await interruptCodexTurn(endpoint, token, useAgentStore.getState().activeThreadId || undefined);
            addEventLog(rt("stopTask"), rt("taskStopped"));
        } catch (error) {
            setAgentState({ activity: rt("stopFailed") });
            addEventLog(rt("stopFailed"), error);
        }
    };

    const addAttachments = async (files: FileList | File[] | null) => {
        if (!files) return;
        const images = Array.from(files).filter((file) => file.type.startsWith("image/"));
        const prev = useAgentStore.getState().attachments;
        try {
            const next = await Promise.all(
                images.slice(0, Math.max(0, MAX_ATTACHMENTS - prev.length)).map(async (file) => {
                    const dataUrl = await readDataUrl(file);
                    const meta = await readImageMeta(dataUrl);
                    const url = URL.createObjectURL(file);
                    attachmentUrlsRef.current.add(url);
                    return { id: createId(), name: file.name, type: file.type, size: file.size, width: meta.width, height: meta.height, url, dataUrl };
                }),
            );
            const merged = [...prev, ...next];
            if (attachmentPayloadBytes(merged) > MAX_ATTACHMENT_PAYLOAD_BYTES) {
                next.forEach((item) => {
                    URL.revokeObjectURL(item.url);
                    attachmentUrlsRef.current.delete(item.url);
                });
                addMessage({ role: "error", title: rt("imageTooLarge"), text: rt("imageLimit") });
                return;
            }
            if (next.length) setAgentState({ attachments: merged });
        } catch (error) {
            addMessage({ role: "error", title: rt("imageReadFailed"), text: error instanceof Error ? error.message : rt("imageReadFailed") });
        }
    };

    const removeAttachment = (id: string) => {
        const removed = attachments.find((item) => item.id === id);
        if (removed) {
            URL.revokeObjectURL(removed.url);
            attachmentUrlsRef.current.delete(removed.url);
        }
        setAgentState({ attachments: attachments.filter((item) => item.id !== id) });
    };

    const decideApproval = async (approval: AgentPendingApproval, decision: "accept" | "acceptForSession" | "decline") => {
        const current = useAgentStore.getState();
        const pending = current.pendingApprovals.find((item) => item.requestId === approval.requestId);
        if (!pending || pending.deciding) return;
        setAgentState({ pendingApprovals: current.pendingApprovals.map((item) => item.requestId === approval.requestId ? { ...item, deciding: decision } : item), activity: rt("submittingApproval") });
        try {
            await postCodexApproval(endpoint, token, approval.requestId, decision);
            const latest = useAgentStore.getState();
            if (latest.pendingApprovals.some((item) => item.requestId === approval.requestId)) setAgentState({ activity: rt("waitingCodexApproval") });
        } catch (error) {
            const latest = useAgentStore.getState();
            const expired = error instanceof AgentApiError && error.response.code === "APPROVAL_EXPIRED";
            const resolved = expired || !latest.pendingApprovals.some((item) => item.requestId === approval.requestId);
            const pendingApprovals = resolved
                ? latest.pendingApprovals.filter((item) => item.requestId !== approval.requestId)
                : latest.pendingApprovals.map((item) => item.requestId === approval.requestId ? { ...item, deciding: undefined } : item);
            setAgentState({ pendingApprovals, activity: approvalActivity(pendingApprovals, latest.waiting, latest.activity) });
            if (resolved) return;
            addEventLog(rt("approvalFailed"), error);
            message.error(error instanceof Error ? error.message : rt("approvalFailed"));
        }
    };

    const changePermissionMode = (nextMode: AgentPermissionMode) => {
        const apply = () => {
            localStorage.setItem("canvas-agent-permission-mode", nextMode);
            setAgentState({ permissionMode: nextMode });
        };
        if (nextMode !== "full") return apply();
        modal.confirm({
            title: rt("enableFullAccess"),
            content: rt("fullAccessDescription"),
            okText: rt("enableFullAccessAction"),
            okType: "danger",
            cancelText: t("common.cancel"),
            onOk: apply,
        });
    };

    const toggleAgentConnection = async ({ silent = false }: { silent?: boolean } = {}) => {
        if (enabled) {
            clearAgentSession({ enabled: false, connected: false, activity: rt("offline"), connectError: "", reconnectAttempt: 0 });
            return;
        }
        const urlToken = searchParams.get("agentToken") || "";
        const urlEndpoint = searchParams.get("agentUrl") || "";
        const discovered = urlToken ? null : await discoverAgentConfig(endpoint || DEFAULT_AGENT_URL);
        const nextEndpoint = (urlEndpoint || discovered?.url || endpoint || DEFAULT_AGENT_URL).trim().replace(/\/$/, "");
        const nextToken = (urlToken || token.trim() || discovered?.token || "").trim();
        if (!nextEndpoint) {
            const text = rt("addressRequired");
            if (!silent) {
                setAgentState({ connectError: text });
                if (!headless) message.warning(text);
            }
            return;
        }
        if (!nextToken) {
            const text = rt("agentNotFound");
            if (!silent) {
                setAgentState({ connectError: text });
                if (!headless) message.warning(text);
            }
            return;
        }
        if (!isAgentUrl(nextEndpoint)) {
            const text = rt("invalidAddress");
            if (!silent) {
                setAgentState({ connectError: text });
                if (!headless) message.warning(text);
            }
            return;
        }
        errorLoggedRef.current = false;
        setAgentState({ url: nextEndpoint, token: nextToken, enabled: true, connected: false, silentConnect: silent, fragmentBootstrap: false, activity: rt("connecting"), connectError: "", activeTab: "setup" });
    };

    useLayoutEffect(() => {
        const bootstrap = readAgentUrlBootstrap(hash);
        if (!bootstrap) return;
        navigate(`${window.location.pathname}${window.location.search}${bootstrap.remainingHash}`, { replace: true });
        if (!bootstrap.url || !bootstrap.token) {
            setAgentState({ fragmentBootstrap: false, activeTab: "setup", connectError: rt(!bootstrap.url ? "addressRequired" : "agentNotFound") });
            useAgentStore.getState().openPanel();
            return;
        }
        if (!isAgentUrl(bootstrap.url)) {
            setAgentState({ fragmentBootstrap: false, activeTab: "setup", connectError: rt("invalidAddress") });
            useAgentStore.getState().openPanel();
            return;
        }
        errorLoggedRef.current = false;
        setAgentState({ url: bootstrap.url.replace(/\/$/, ""), token: bootstrap.token, enabled: true, connected: false, silentConnect: true, fragmentBootstrap: true, confirmTools: false, activity: rt("connecting"), connectError: "", activeTab: "setup" });
    }, [hash, navigate, setAgentState]);

    useEffect(() => {
        if (urlAgentAutoConnect && confirmTools) setAgentState({ confirmTools: false });
    }, [confirmTools, setAgentState, urlAgentAutoConnect]);

    useEffect(() => {
        if ((!autoConnect && !urlAgentAutoConnect) || autoConnectRef.current || enabled || connected) return;
        autoConnectRef.current = true;
        void toggleAgentConnection({ silent: true });
    }, [autoConnect, connected, enabled, urlAgentAutoConnect]);

    function clearAgentSession(patch: Parameters<typeof setAgentState>[0] = {}) {
        loadThreadsSequenceRef.current += 1;
        threadMessagesRef.current.clear();
        authoritativeHistoryTurnsRef.current.clear();
        liveTurnKeysRef.current.clear();
        threadOperationRef.current = 0;
        setAgentState({
            messages: [],
            tokenUsage: null,
            tokenUsageTotal: null,
            threads: [],
            activeThreadId: "",
            activeTurnId: "",
            workspacePath: "",
            loadingThreads: false,
            waiting: false,
            sending: false,
            fragmentBootstrap: false,
            pendingTool: null,
            pendingApprovals: [],
            conversation: { revision: 0, conversationId: "", threadId: "", status: "idle", mcpStatuses: {} },
            bootstrapStatus: null,
            mcpStartupStatuses: {},
            ...patch,
        });
        useAgentSkillStore.getState().reset();
        pendingToolRef.current = null;
    }

    const { handleToolCall, rejectPendingTool, approvePendingTool } = useAgentToolCalls({ endpoint, clientIdRef, canvasContextRef, pendingToolRef, confirmToolsRef, navigate, addEventLog });

    const connectionStatus = t(connectError ? "agent.status.failed" : connected ? "agent.status.connected" : enabled ? "agent.status.connecting" : "agent.status.disconnected");
    const connectionStatusColor = connectionColor({ connectError, connected, enabled }, theme);
    const content = (
        <>
            <AgentPanelTabs
                value={activeTab}
                leading={
                    <div className="flex items-center gap-1">
                        <span className="grid size-8 place-items-center">
                            <Bot className="size-4" />
                        </span>
                        <div className="hidden text-base font-semibold leading-5 @min-[560px]:block">Agent</div>
                        <Tooltip title={t("agent.panel.switchRuntime")} placement="bottom">
                            <span className="inline-flex shrink-0">
                                <Dropdown
                                    trigger={["click"]}
                                    menu={{
                                        items: [{ key: "codex", label: "Codex" }, { key: "claude", label: "Claude" }],
                                        selectedKeys: [runtime],
                                        onClick: ({ key }) => void switchRuntime(key as AgentRuntimeName),
                                    }}
                                >
                                    <button type="button" className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm font-medium hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }}>
                                        {runtime === "claude" ? "Claude" : "Codex"}
                                        <ChevronDown className="size-3.5" />
                                    </button>
                                </Dropdown>
                            </span>
                        </Tooltip>
                        <Tooltip title={t("agent.panel.connectionSettings", { status: connectionStatus })} placement="bottom">
                            <Button size="small" type="text" className="!h-8 !w-8 !min-w-8 !px-0 @min-[560px]:!w-auto @min-[560px]:!min-w-0 @min-[560px]:!px-[7px]" aria-label={t("agent.panel.connectionSettingsLabel", { status: connectionStatus })} icon={<PlugZap className="size-3.5" style={{ color: connectionStatusColor }} />} onClick={() => setAgentState({ activeTab: "setup" })}>
                                <span className="hidden @min-[560px]:inline">{connectionStatus}</span>
                            </Button>
                        </Tooltip>
                    </div>
                }
                items={[
                    { value: "chat", label: t("agent.panel.chat"), icon: <MessageSquare className="size-3.5" /> },
                    { value: "history", label: t("agent.panel.history"), icon: <History className="size-3.5" />, count: threads.length },
                    { value: "skills", label: t("agent.panel.skills"), icon: <Sparkles className="size-3.5" />, count: skillCount },
                    { value: "log", label: t("agent.panel.logs"), icon: <Terminal className="size-3.5" />, count: eventLogs.length },
                ]}
                onChange={(activeTab) => {
                    setAgentState({ activeTab });
                    if (activeTab === "history") void loadThreads();
                }}
                right={
                    <>
                        <Tooltip title={t("agent.history.newThread")} placement="bottom">
                            <Button size="small" type="text" className="!h-8 !w-8 !min-w-8 !px-0 @min-[560px]:!w-auto @min-[560px]:!min-w-0 @min-[560px]:!px-[7px]" aria-label={t("agent.history.newThread")} disabled={!connected || loadingThreads || sending || waiting || conversationBusy} icon={<Plus className="size-3.5" />} onClick={startNewThread}>
                                <span className="hidden @min-[560px]:inline">{t("agent.history.newThread")}</span>
                            </Button>
                        </Tooltip>
                        <Tooltip title={t("agent.panel.collapse")}>
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" aria-label={t("agent.panel.collapseLabel")} style={{ color: theme.node.muted }} icon={<PanelRightClose className="size-4" />} onClick={closePanel} />
                        </Tooltip>
                    </>
                }
            />

            {activeTab === "setup" ? (
                <AgentConnectView
                    url={url}
                    token={token}
                    enabled={enabled}
                    connected={connected}
                    activity={activity}
                    connectError={connectError}
                    onUrlChange={(url) => setAgentState({ url, connectError: "" })}
                    onTokenChange={(token) => setAgentState({ token, connectError: "" })}
                    onToggleEnabled={toggleAgentConnection}
                />
            ) : activeTab === "skills" ? (
                <AgentSkillsView clientId={clientIdRef.current} />
            ) : activeTab === "history" ? (
                <AgentHistoryView
                    threads={threads}
                    hasMore={Boolean(threadsNextCursor)}
                    pinnedThreadIds={pinnedThreadIds}
                    search={threadSearch}
                    onSearch={searchThreads}
                    onLoadMore={loadMoreThreads}
                    activeThreadId={activeThreadId}
                    workspacePath={workspacePath}
                    loading={loadingThreads}
                    busy={sending || waiting || conversationBusy}
                    connected={connected}
                    onRefresh={() => void loadThreads()}
                    onNewThread={() => void startNewThread()}
                    onResumeThread={(threadId) => void resumeThread(threadId)}
                    onDeleteThreads={confirmDeleteThreads}
                    onRenameThread={renameThread}
                    onTogglePinThread={togglePinThread}
                />
            ) : activeTab === "log" ? (
                <AgentLogView
                    logs={eventLogs}
                    context={{ endpoint, connected, enabled, activity, waiting, sending, messages: messageCount, pendingTool: pendingTool?.name }}
                    onClear={clearEventLogs}
                    onCopied={(text) => message.success(text)}
                    onCopyBlocked={(text) => message.warning(text)}
                />
            ) : (
                <>
                    {reconnectAttempt > 0 ? (
                        <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-1 text-xs" style={{ color: theme.node.muted }}>
                            <span className="min-w-0 truncate">{activity}</span>
                            <button type="button" className="shrink-0 rounded px-1.5 py-0.5 hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.muted }} onClick={reconnectNow}>{rt("reconnectNow")}</button>
                        </div>
                    ) : null}
                    <AgentChatTimeline pendingTool={pendingTool} pendingApprovals={pendingApprovals} sending={sending} waiting={waiting} onRejectTool={rejectPendingTool} onApproveTool={approvePendingTool} onApprovalDecision={decideApproval} onResend={sendPrompt} />
                    <AgentTaskProgress busy={sending || waiting} />
                    {tokenUsage ? <AgentUsageBar usage={tokenUsage} /> : null}
                    <AgentChatComposer
                        prompt={prompt}
                        attachments={attachments.map((attachment) => agentAttachmentToChatAttachment(attachment, endpoint, token))}
                        disabled={!connected || !conversationReady || loadingThreads}
                        sending={sending || waiting}
                        placeholder={conversation.status === "idle" || conversation.status === "preparing"
                            ? t("agent.panel.mcpInitializing")
                            : conversation.status === "failed"
                                ? t("agent.panel.initFailed")
                                : t("agent.panel.placeholder")}
                        onPromptChange={(prompt) => setAgentState({ prompt })}
                        onSubmit={sendPrompt}
                        onStop={stopTurn}
                        onAddFiles={addAttachments}
                        onRemoveAttachment={removeAttachment}
                        confirmTools={confirmTools}
                        onConfirmToolsChange={(confirmTools) => setAgentState({ confirmTools })}
                        permissionMode={permissionMode}
                        onPermissionModeChange={changePermissionMode}
                        models={models}
                        model={model}
                        reasoningEffort={reasoningEffort}
                        onModelChange={(model) => {
                            const selected = models.find((item) => item.model === model);
                            if (!selected) return;
                            const effort = selected.defaultReasoningEffort || selected.supportedReasoningEfforts[0]?.reasoningEffort || "";
                            const runtime = useAgentStore.getState().runtime;
                            localStorage.setItem(`canvas-agent-model:${runtime}`, model);
                            localStorage.setItem(`canvas-agent-reasoning-effort:${runtime}`, effort);
                            setAgentState({ model, reasoningEffort: effort });
                        }}
                        onReasoningEffortChange={(reasoningEffort) => {
                            localStorage.setItem(`canvas-agent-reasoning-effort:${useAgentStore.getState().runtime}`, reasoningEffort);
                            setAgentState({ reasoningEffort });
                        }}
                        left={
                            attachments.length ? (
                                <span className="hidden text-[11px] @min-[660px]:inline" style={{ color: theme.node.muted }}>
                                    {formatBytes(attachmentPayloadBytes(attachments))} / 30MB
                                </span>
                            ) : null
                        }
                    />
                </>
            )}
        </>
    );

    if (headless) return null;
    return embedded ? content : null;
}

function acquireAgentClientId() {
    const scope = globalThis as AgentClientGlobal;
    scope.__infiniteCanvasAgentClientIdPromise ||= (async () => {
        const storedClientId = readAgentClientId();
        let clientId = storedClientId || randomId();
        if (!navigator.locks) {
            if (!storedClientId) saveAgentClientId(clientId);
            return clientId;
        }
        while (true) {
            const acquired = await new Promise<boolean>((resolve, reject) => {
                void navigator.locks.request(`infinite-canvas-agent:${clientId}`, { ifAvailable: true }, async (lock) => {
                    if (!lock) return resolve(false);
                    resolve(true);
                    await new Promise<void>(() => undefined);
                }).catch(reject);
            });
            if (acquired) {
                saveAgentClientId(clientId);
                return clientId;
            }
            clientId = randomId();
        }
    })().catch(() => {
        const clientId = randomId();
        saveAgentClientId(clientId);
        return clientId;
    });
    return scope.__infiniteCanvasAgentClientIdPromise;
}

function readAgentClientId() {
    try {
        return sessionStorage.getItem("canvas-agent-client-id") || "";
    } catch {
        return "";
    }
}

function saveAgentClientId(clientId: string) {
    try {
        sessionStorage.setItem("canvas-agent-client-id", clientId);
    } catch {
        // The in-memory identity still keeps request ownership consistent within the current page session.
    }
}

function approvalActivity(pendingApprovals: AgentPendingApproval[], waiting: boolean, fallback: string) {
    if (pendingApprovals.length) return rt("awaitingApproval");
    return waiting ? rt("codexRunning") : fallback;
}

async function createMessageAttachmentMetadata(item: AgentAttachment) {
    const url = Math.max(item.width, item.height) > MESSAGE_PREVIEW_LONG_EDGE || item.dataUrl.length > MESSAGE_PREVIEW_MAX_LENGTH
        ? await upscaleDataUrl(item.dataUrl, { targetLongEdge: MESSAGE_PREVIEW_LONG_EDGE, algorithm: "high" })
        : item.dataUrl;
    return { id: item.id, name: item.name, type: item.type, size: item.size, width: item.width, height: item.height, url };
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}
